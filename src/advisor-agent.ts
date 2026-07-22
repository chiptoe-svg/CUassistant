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
// rather than a flag telling it not to. The one exception is propose_schedule,
// the single host tool: it reaches nothing and writes nothing, it hands
// validated structured data back to the host for rendering.
//
// The bridge is built ONCE at startup and shared. Building it per request would
// pay listTools() latency every turn and churn connections against the MCP
// servers; all three transports are HTTP, so sharing is safe.
//
// Skills are NOT inlined into the system prompt. They are retrieved on demand
// through the bridge's list-skills / get-skill-docs tools. The three relevant
// skills total ~6,500 tokens; inlining them would spend a tenth of a 64k window
// on every turn.

import { mkdtempSync, readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  ADVISOR_PROVIDER_CHAIN,
  OPENAI_API_KEY,
} from "./config.js";
import { log } from "./log.js";
import { isEgressAuthorized } from "./policy.js";
import { createAdvisorMcpBridge } from "./advisor-mcp.js";
import { createProposeScheduleTool } from "./advisor-artifacts.js";
import type { AdvisorSession } from "./advisor-session.js";

let bridge: { tools: AgentTool[]; close(): Promise<void> } | null = null;

export function loadSystemPrompt(): string {
  return readFileSync(
    fileURLToPath(new URL("../advisor/AGENTS.md", import.meta.url)),
    "utf8",
  );
}

// --- egress authorization ---------------------------------------------------
//
// The chain names in ADVISOR_PROVIDER_CHAIN are internal labels ("spark",
// "openai"); policy/action-policy.yaml declares destinations under its own
// provider vocabulary. Every chain entry that we are about to send bytes to has
// to resolve to a declared, authorized destination, so the mapping is explicit
// and exhaustive. An entry with no mapping is a destination nobody reviewed —
// that fails closed, exactly like an entry whose policy record says
// `authorized: false`.
//
// ADVISOR_PROVIDER_CHAIN is env-settable, so this is the only thing standing
// between a typo in a unit file and student context going somewhere undeclared.
const CHAIN_EGRESS_PROVIDER: Readonly<Record<string, string>> = {
  spark: "clemson_spark_vllm",
  openai: "openai_api",
};

/**
 * Throw unless every name in `chain` maps to a policy destination that is
 * authorized for content egress. FAIL CLOSED on an unmapped name.
 *
 * `isAuthorized` is injectable so tests can exercise the unauthorized branch
 * without editing the shipped policy file.
 */
export function assertAdvisorChainAuthorized(
  chain: readonly string[],
  isAuthorized: (provider: string) => boolean = isEgressAuthorized,
): void {
  for (const name of chain) {
    const declared = CHAIN_EGRESS_PROVIDER[name];
    if (!declared) {
      throw new Error(
        `advisor provider "${name}" has no destination declared in policy/action-policy.yaml; refusing to send content to an undeclared endpoint`,
      );
    }
    if (!isAuthorized(declared)) {
      throw new Error(
        `advisor provider "${name}" sends to egress provider "${declared}", which is not authorized in policy/action-policy.yaml`,
      );
    }
  }
}

export async function initAdvisorTools(): Promise<void> {
  // Fail at startup on a misconfigured chain rather than at the first turn.
  // runAdvisorTurn re-checks each entry it actually reaches; this is the early
  // warning, not the gate.
  assertAdvisorChainAuthorized(ADVISOR_PROVIDER_CHAIN);
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
 * How a turn ended.
 *
 * - `complete`  — the model finished its answer.
 * - `round_cap` — the tool-round cap stopped the loop; `text` is whatever the
 *   model had said by then and is NOT a finished answer.
 * - `aborted`   — the caller's AbortSignal fired; `text` is a partial answer.
 *
 * Callers must distinguish these. A partial answer rendered as a final one is
 * the failure mode this type exists to prevent.
 */
export type AdvisorTurnOutcome = "complete" | "round_cap" | "aborted";

export interface AdvisorTurnResult {
  text: string;
  toolCalls: number;
  outcome: AdvisorTurnOutcome;
}

/**
 * Reuse the Pi conversation under `sessionsRoot` if one exists, so multi-turn
 * context survives across requests. The root is per-AdvisorSession and removed
 * by clearSession, so nothing leaks between advisors.
 */
async function openOrCreatePiSession(
  env: NodeExecutionEnv,
  sessionsRoot: string,
  cwd: string,
) {
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
  const existing = await repo.list({ cwd });
  if (existing.length > 0) return repo.open(existing[0]!);
  return repo.create({ cwd });
}

async function runWithProvider(
  target: ProviderTarget,
  session: AdvisorSession,
  piSessionRoot: string,
  input: string,
  signal?: AbortSignal,
): Promise<AdvisorTurnResult> {
  const env = new NodeExecutionEnv({
    cwd: session.workDir,
    shellEnv: process.env,
  });
  const piSession = await openOrCreatePiSession(
    env,
    piSessionRoot,
    session.workDir,
  );

  const harness = new AgentHarness({
    env,
    session: piSession,
    model: target.model,
    // bridge.tools plus EXACTLY ONE host tool. propose_schedule writes
    // nothing — it hands validated structured data back to the host, which
    // renders the document. Nothing else joins this array; "answers come from
    // the MCP tools or not at all" stays structural.
    //
    // Built per turn because it closes over the session it writes the proposed
    // schedule onto.
    tools: [...bridge!.tools, createProposeScheduleTool(session)],
    systemPrompt: loadSystemPrompt(),
    streamOptions: { cacheRetention: "short" },
    getApiKeyAndHeaders: async () => ({ apiKey: target.apiKey }),
  });

  // Round cap. 0.75.4's AgentHarness exposes neither a maxRounds option nor the
  // agent loop's shouldStopAfterTurn hook, so the bound is enforced through the
  // one mechanism that actually ends the loop: `terminate` on ToolResultPatch.
  //
  // Blocking from the `tool_call` hook does NOT bound anything. agent-loop.js
  // turns a blocked call into an error tool result, feeds it back, and requests
  // again — the model can retry forever against a metered provider.
  // `shouldTerminateToolBatch` (agent-loop.js:345) is the real exit, and it is
  // true only when EVERY finalized call in the batch carries terminate. This
  // hook fires per call and the predicate is round-based, so once the cap is
  // hit every call in the batch sets it and the loop stops after this batch.
  //
  // Returning only `terminate` leaves the real tool output intact:
  // agent-loop.js:454 merges `afterResult.content ?? result.content`.
  let rounds = 0;
  let toolCalls = 0;
  let hitRoundCap = false;
  harness.on("before_provider_request", () => {
    rounds++;
    return undefined;
  });
  harness.on("tool_call", () => {
    toolCalls++;
    return undefined;
  });
  harness.on("tool_result", () => {
    if (rounds < ADVISOR_MAX_ROUNDS) return undefined;
    hitRoundCap = true;
    return { terminate: true };
  });

  // temperature is not part of AgentHarnessStreamOptions in 0.75.4, so it is
  // injected into the provider payload directly.
  //
  // Only for chat-completions providers. The openai fallback is
  // `openai-responses` with a reasoning model, and the Responses API rejects
  // `temperature` for those — injecting it unconditionally would 400 the
  // fallback on every single request, i.e. exactly when it is needed.
  if (target.model.api === "openai-completions") {
    harness.on("before_provider_payload", (event) => ({
      payload: { ...(event.payload as Record<string, unknown>), temperature: 0 },
    }));
  }

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
      hitRoundCap,
    });

    if (reply.stopReason === "error") {
      throw new Error(reply.errorMessage || "provider returned an error");
    }
    // harness.abort() makes prompt() RESOLVE with stopReason "aborted" and
    // whatever text had streamed so far (agent-loop.js:107 returns early on it).
    // Without its own branch a stopped turn is indistinguishable from a finished
    // one, and the UI's stop control would render a truncated answer as final.
    if (reply.stopReason === "aborted") {
      return { text, toolCalls, outcome: "aborted" };
    }
    return { text, toolCalls, outcome: hitRoundCap ? "round_cap" : "complete" };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Run one attempt against a scratch COPY of the session's Pi conversation, and
 * fold the copy back into `session.piSessionRoot` only if the turn completed.
 *
 * The harness persists the user message and every partial assistant/tool
 * message as the turn runs. Prompting the same JSONL session again after a
 * provider failure would therefore leave a duplicate user turn and an orphaned
 * failed assistant turn behind — permanently, in every later turn's context.
 * Attempts are isolated so a fallback starts from the same history spark saw,
 * and a failed or aborted attempt leaves no trace.
 */
async function runAttempt(
  target: ProviderTarget,
  session: AdvisorSession,
  input: string,
  signal?: AbortSignal,
): Promise<AdvisorTurnResult> {
  const attemptRoot = mkdtempSync(path.join(tmpdir(), "advisor-pi-try-"));
  // Any schedule proposed during a discarded attempt is discarded with it, for
  // the same reason the JSONL is: a failed or cancelled attempt must leave no
  // trace, and a stale document offered for download is worse than none.
  const scheduleBefore = session.lastSchedule;
  let committed = false;
  try {
    await cp(session.piSessionRoot, attemptRoot, { recursive: true });
    const result = await runWithProvider(
      target,
      session,
      attemptRoot,
      input,
      signal,
    );
    // An aborted turn is discarded too: the advisor pressed stop, so the
    // half-finished exchange should not become permanent history.
    if (result.outcome !== "aborted") {
      await rm(session.piSessionRoot, { recursive: true, force: true });
      await cp(attemptRoot, session.piSessionRoot, { recursive: true });
      committed = true;
    }
    return result;
  } finally {
    if (!committed) session.lastSchedule = scheduleBefore;
    await rm(attemptRoot, { recursive: true, force: true });
  }
}

export async function runAdvisorTurn(
  session: AdvisorSession,
  input: string,
  signal?: AbortSignal,
): Promise<AdvisorTurnResult> {
  if (!bridge) throw new Error("advisor tools not initialised");

  const errors: string[] = [];
  for (const name of ADVISOR_PROVIDER_CHAIN) {
    // The gate on the bytes actually about to leave. Re-checked per entry
    // reached rather than once at startup, so a fallback is authorized on its
    // own record and not on the primary's.
    assertAdvisorChainAuthorized([name]);

    const target = resolveProvider(name);
    if (!target) {
      errors.push(`${name}: not configured`);
      continue;
    }
    try {
      const result = await runAttempt(target, session, input, signal);
      // A stopped turn is the caller's decision, not a provider failure. Do not
      // burn the fallback provider re-running work the advisor cancelled.
      return result;
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

/** Test seam: install a fake tool bridge without standing up MCP servers. */
export function setAdvisorBridgeForTest(
  b: { tools: AgentTool[]; close(): Promise<void> } | null,
): void {
  bridge = b;
}

/** Test seam: run a turn against an explicitly constructed provider target. */
export const __runWithProviderForTest = runAttempt;
