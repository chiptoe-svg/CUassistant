// Pi harness for the advisor chat.
//
// Pi is used for the two things a hand-rolled loop gets subtly wrong and this
// service needs: abort/cancellation through the pipeline including mid-tool-
// call (the UI has a stop control), and compaction when a conversation outgrows
// the window.
//
// The tool array is bridge.tools and nothing else. nanoclaw's harness also
// passes createFetchTool(), createWebSearchTool(), and createCodingTools(); all
// three are omitted here. "Answers come from the MCP tools or not at all" is
// therefore structural - the agent has no other capability to reach for -
// rather than a flag telling it not to. (Task 6 adds exactly one host tool,
// propose_schedule.)
//
// The bridge is built ONCE at startup and shared. Building it per request would
// pay listTools() latency every turn and churn connections against the MCP
// servers; all three transports are HTTP, so sharing is safe.
//
// Skills are NOT inlined into the system prompt. They are retrieved on demand
// through the bridge's list-skills / get-skill-docs tools. The three relevant
// skills total ~6,500 tokens; inlining them would spend a tenth of a 64k window
// on every turn.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AgentHarness,
  JsonlSessionRepo,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getModel, type Model } from "@earendil-works/pi-ai";

import {
  ADVISOR_BASE_URL,
  ADVISOR_MAX_ROUNDS,
  ADVISOR_MODEL,
  ADVISOR_PROVIDER,
  ADVISOR_PROVIDER_CHAIN,
  OPENAI_API_KEY,
} from "./config.js";
import { log } from "./log.js";
import { isEgressAuthorized } from "./policy.js";
import { createAdvisorMcpBridge } from "./advisor-mcp.js";
import type { AdvisorSession } from "./advisor-session.js";

let bridge: { tools: AgentTool[]; close(): Promise<void> } | null = null;

export function loadSystemPrompt(): string {
  return readFileSync(
    fileURLToPath(new URL("../advisor/AGENTS.md", import.meta.url)),
    "utf8",
  );
}

export async function initAdvisorTools(): Promise<void> {
  if (!isEgressAuthorized(ADVISOR_PROVIDER)) {
    throw new Error(
      `egress provider "${ADVISOR_PROVIDER}" is not authorized in policy/action-policy.yaml`,
    );
  }
  bridge = await createAdvisorMcpBridge();
  log.info("advisor tools ready", { tools: bridge.tools.length });
}

export function advisorToolNames(): string[] {
  return (bridge?.tools ?? []).map((t) => t.name);
}

export async function shutdownAdvisorTools(): Promise<void> {
  await bridge?.close();
  bridge = null;
}

// --- provider chain ---------------------------------------------------------
//
// Pi's model registry has no entry for the DGX Spark vLLM endpoint, so that
// model is constructed directly (the same pattern nanoclaw uses for its
// clemson-local / omlx-local providers). "openai" resolves through the real
// registry.

interface ProviderTarget {
  name: string;
  model: Model<never>;
  apiKey: string;
}

function resolveProvider(name: string): ProviderTarget | null {
  if (name === "spark") {
    return {
      name,
      apiKey: process.env.ADVISOR_API_KEY || "local",
      model: {
        id: ADVISOR_MODEL,
        name: ADVISOR_MODEL,
        api: "openai-completions",
        provider: "openai",
        baseUrl: ADVISOR_BASE_URL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65536,
        maxTokens: 8192,
      } as unknown as Model<never>,
    };
  }
  if (name === "openai") {
    if (!OPENAI_API_KEY) return null;
    const id = process.env.ADVISOR_OPENAI_MODEL || "gpt-5.4";
    return {
      name,
      apiKey: OPENAI_API_KEY,
      model: getModel("openai", id as never) as unknown as Model<never>,
    };
  }
  log.warn("advisor provider chain names an unknown provider", {
    provider: name,
  });
  return null;
}

// --- turn -------------------------------------------------------------------

/**
 * Reuse this session's Pi conversation if one already exists under
 * `piSessionRoot`, so multi-turn context survives across requests. The root is
 * per-AdvisorSession and removed by clearSession, so nothing leaks between
 * advisors.
 */
async function openOrCreatePiSession(
  env: NodeExecutionEnv,
  session: AdvisorSession,
) {
  const repo = new JsonlSessionRepo({
    fs: env,
    sessionsRoot: session.piSessionRoot,
  });
  const existing = await repo.list({ cwd: session.workDir });
  if (existing.length > 0) return repo.open(existing[0]!);
  return repo.create({ cwd: session.workDir });
}

async function runWithProvider(
  target: ProviderTarget,
  session: AdvisorSession,
  input: string,
  signal?: AbortSignal,
): Promise<{ text: string; toolCalls: number }> {
  const env = new NodeExecutionEnv({
    cwd: session.workDir,
    shellEnv: process.env,
  });
  const piSession = await openOrCreatePiSession(env, session);

  const harness = new AgentHarness({
    env,
    session: piSession,
    model: target.model,
    tools: bridge!.tools,
    systemPrompt: loadSystemPrompt(),
    streamOptions: { cacheRetention: "short" },
    getApiKeyAndHeaders: async () => ({ apiKey: target.apiKey }),
  });

  // Round cap. 0.75.4's AgentHarness exposes neither a maxRounds option nor the
  // agent loop's shouldStopAfterTurn hook, so the bound is enforced by counting
  // provider requests and blocking further tool calls once the cap is reached.
  // Blocking rather than aborting lets the model still produce a final answer.
  let rounds = 0;
  let toolCalls = 0;
  harness.on("before_provider_request", () => {
    rounds++;
    return undefined;
  });
  harness.on("tool_call", () => {
    if (rounds >= ADVISOR_MAX_ROUNDS) {
      return {
        block: true,
        reason: `tool-round cap of ${ADVISOR_MAX_ROUNDS} reached; answer from what you already have or say the tools could not answer`,
      };
    }
    toolCalls++;
    return undefined;
  });

  // temperature is not part of AgentHarnessStreamOptions in 0.75.4, so it is
  // injected into the provider payload directly.
  harness.on("before_provider_payload", (event) => ({
    payload: { ...(event.payload as Record<string, unknown>), temperature: 0 },
  }));

  const onAbort = () => {
    void harness.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) throw new Error("aborted before start");
    const reply = await harness.prompt(input);
    const text = reply.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    // Metadata only. Prompt and response text may carry student information and
    // never reach the log.
    log.info("advisor turn complete", {
      session: session.id,
      advisorId: session.advisorId,
      provider: target.name,
      model: target.model.id,
      rounds,
      toolCalls,
      inputTokens: reply.usage?.input,
      outputTokens: reply.usage?.output,
      totalTokens: reply.usage?.totalTokens,
      stopReason: reply.stopReason,
    });

    if (reply.stopReason === "error") {
      throw new Error(reply.errorMessage || "provider returned an error");
    }
    return { text, toolCalls };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function runAdvisorTurn(
  session: AdvisorSession,
  input: string,
  signal?: AbortSignal,
): Promise<{ text: string; toolCalls: number }> {
  if (!bridge) throw new Error("advisor tools not initialised");

  const errors: string[] = [];
  for (const name of ADVISOR_PROVIDER_CHAIN) {
    const target = resolveProvider(name);
    if (!target) {
      errors.push(`${name}: not configured`);
      continue;
    }
    try {
      return await runWithProvider(target, session, input, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      log.warn("advisor provider failed, trying next in chain", {
        session: session.id,
        advisorId: session.advisorId,
        provider: name,
      });
    }
  }
  throw new Error(`all advisor providers failed — ${errors.join("; ")}`);
}
