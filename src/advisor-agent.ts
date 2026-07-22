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
import { getModel, type Model, type StopReason } from "@earendil-works/pi-ai";

import {
  ADVISOR_BASE_URL,
  ADVISOR_MAX_OUTPUT_TOKENS,
  ADVISOR_MAX_REQUEST_TOKENS,
  ADVISOR_MAX_ROUNDS,
  ADVISOR_MODEL,
  ADVISOR_PROVIDER_CHAIN,
  ADVISOR_TEMPERATURE,
  ADVISOR_TURN_TIMEOUT_MS,
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
//
// A chain NAME is only a label. Checking the label proves nothing about where
// bytes go, because the URL each label dials is env-settable too:
// `ADVISOR_BASE_URL=https://anything/v1` keeps the name "spark" and the policy
// record "clemson_spark_vllm" while sending every prompt somewhere nobody
// declared. So each entry carries the hosts its policy record actually
// describes, and the gate checks the host that will be dialled.
interface ChainDestination {
  /** The provider record in policy/action-policy.yaml. */
  policyProvider: string;
  /**
   * Hosts this policy record covers. `clemson_spark_vllm`'s basis names
   * on-premises Clemson hardware at gcspark.clemson.edu; `openai_api`'s names
   * the OpenAI API. Neither covers an arbitrary host, so neither list may grow
   * without the corresponding policy record being rewritten and re-reviewed.
   */
  hosts: readonly string[];
}

const CHAIN_EGRESS_PROVIDER: Readonly<Record<string, ChainDestination>> = {
  spark: {
    policyProvider: "clemson_spark_vllm",
    hosts: ["gcspark.clemson.edu"],
  },
  openai: {
    policyProvider: "openai_api",
    hosts: ["api.openai.com"],
  },
};

/**
 * The host pi-ai will dial for a model, read off the MODEL OBJECT.
 *
 * pi-ai dials `model.baseUrl` (providers/openai-completions.js:386,
 * openai-responses.js:169) and never reads OPENAI_BASE_URL or any other
 * environment variable at dial time. So the only string that predicts the
 * destination is the one on the model we are about to hand it; anything else is
 * a configuration value that may or may not be what gets used.
 */
function modelHost(model: Model<never>): string | undefined {
  const raw = (model as unknown as { baseUrl?: string }).baseUrl;
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The host each chain entry will actually dial.
 *
 * Derived from the same model object resolveProvider() builds, so the startup
 * warning and the per-turn gate cannot disagree about the destination. Built
 * WITHOUT the API-key check, because an unconfigured provider still has a known
 * destination and the startup check should judge the chain, not the secrets.
 */
function dialledHost(name: string): string | undefined {
  const model = providerModel(name);
  return model ? modelHost(model) : undefined;
}

/**
 * Throw unless every name in `chain` maps to a policy destination that is
 * authorized for content egress AND will dial a host that destination covers.
 * FAIL CLOSED on an unmapped name, an unauthorized record, or an unparseable
 * or undeclared host.
 *
 * `isAuthorized` and `resolveHost` are injectable so tests can exercise the
 * failing branches without editing the shipped policy file or the environment.
 */
export function assertAdvisorChainAuthorized(
  chain: readonly string[],
  isAuthorized: (provider: string) => boolean = isEgressAuthorized,
  resolveHost: (name: string) => string | undefined = dialledHost,
): void {
  for (const name of chain) {
    const declared = CHAIN_EGRESS_PROVIDER[name];
    if (!declared) {
      throw new Error(
        `advisor provider "${name}" has no destination declared in policy/action-policy.yaml; refusing to send content to an undeclared endpoint`,
      );
    }
    if (!isAuthorized(declared.policyProvider)) {
      throw new Error(
        `advisor provider "${name}" sends to egress provider "${declared.policyProvider}", which is not authorized in policy/action-policy.yaml`,
      );
    }
    // The gate on the URL, not on the label. Without this the two checks above
    // pass for a chain that dials anywhere at all.
    const host = resolveHost(name);
    if (!host) {
      throw new Error(
        `advisor provider "${name}" has no resolvable endpoint host; refusing to send content to an endpoint that cannot be checked`,
      );
    }
    if (!declared.hosts.includes(host)) {
      throw new Error(
        `advisor provider "${name}" would dial host "${host}", which is not covered by egress provider "${declared.policyProvider}" (declared: ${declared.hosts.join(", ")})`,
      );
    }
  }
}

/**
 * The gate as the turn loop applies it: on a RESOLVED target, checking the host
 * off `target.model.baseUrl` — the field pi-ai actually dials.
 *
 * This exists as its own function because the ordering is the safety property.
 * Asserting on a chain NAME before the provider is resolved checks a
 * configuration string, and the string and the model object can disagree: the
 * pi-ai registry supplies `openai`'s baseUrl and never consults OPENAI_BASE_URL,
 * so a gate reading that variable would be validating something nobody dials
 * while the real destination went unchecked.
 */
export function assertAdvisorTargetAuthorized(
  target: ProviderTarget,
  isAuthorized: (provider: string) => boolean = isEgressAuthorized,
): void {
  assertAdvisorChainAuthorized([target.name], isAuthorized, () =>
    modelHost(target.model),
  );
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

export interface ProviderTarget {
  name: string;
  model: Model<never>;
  apiKey: string;
}

/**
 * The model object a chain entry dials, independent of whether its credential
 * is present. resolveProvider() adds the key; the egress gate reads the host
 * off this, so both see the same `baseUrl`.
 */
function providerModel(name: string): Model<never> | null {
  if (name === "spark") {
    return {
      id: ADVISOR_MODEL,
      name: ADVISOR_MODEL,
      api: "openai-completions",
      provider: "openai",
      baseUrl: ADVISOR_BASE_URL,
      // The endpoint docs' canonical request for qwen3.6-35b-a3b carries
      // `chat_template_kwargs: { enable_thinking: true }`. pi-ai emits
      // exactly that itself — openai-completions.js:443-448 — but the branch
      // is guarded by `compat.thinkingFormat === "qwen-chat-template" &&
      // model.reasoning`. With reasoning:false and no thinkingFormat (what we
      // shipped) the branch is dead and the flag never reaches the wire.
      //
      // These two fields turn pi-ai's own supported path on, rather than
      // hand-rolling the parameter in the payload hook. The third input the
      // branch needs is a truthy `options.reasoningEffort`, which comes from
      // the harness's `thinkingLevel` (agent-harness.js:339) — set where the
      // AgentHarness is constructed, below.
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 65536,
      maxTokens: 8192,
    } as unknown as Model<never>;
  }
  if (name === "openai") {
    const id = process.env.ADVISOR_OPENAI_MODEL || "gpt-5.4";
    return getModel("openai", id as never) as unknown as Model<never>;
  }
  return null;
}

function resolveProvider(name: string): ProviderTarget | null {
  const model = providerModel(name);
  if (!model) {
    log.warn("advisor provider chain names an unknown provider", {
      provider: name,
    });
    return null;
  }
  if (name === "openai" && !OPENAI_API_KEY) return null;
  return {
    name,
    apiKey:
      name === "spark"
        ? process.env.ADVISOR_API_KEY || "local"
        : OPENAI_API_KEY,
    model,
  };
}

// --- turn -------------------------------------------------------------------

/**
 * How a turn ended.
 *
 * - `complete`   — the model finished its answer.
 * - `round_cap`  — the tool-round cap stopped the loop; `text` is whatever the
 *   model had said by then and is NOT a finished answer.
 * - `timeout`    — the wall-clock ceiling stopped the turn; `text` is partial.
 * - `malformed_tool_call` — the endpoint emitted a tool call as prose instead
 *   of as a tool call. `text` is NOT an answer; see detectMalformedToolCall.
 * - `truncated`  — the output budget ran out mid-generation (finish_reason
 *   "length"); `text` is a partial answer and may end mid-sentence or mid
 *   tool-call.
 * - `aborted`    — the caller's AbortSignal fired; `text` is a partial answer.
 *
 * Callers must distinguish these. A partial answer rendered as a final one is
 * the failure mode this type exists to prevent.
 *
 * `truncated` and `malformed_tool_call` are deliberately separate outcomes even
 * though a truncated generation can leave behind exactly the same partial
 * tool-call XML. They have different owners: truncation is fixed HERE, by
 * raising ADVISOR_MAX_OUTPUT_TOKENS or trimming context, while
 * malformed_tool_call can only be fixed by whoever operates the endpoint.
 * Collapsing them sends our own budget bug to someone else's inbox.
 */
export type AdvisorTurnOutcome =
  | "complete"
  | "round_cap"
  | "timeout"
  | "malformed_tool_call"
  | "truncated"
  | "aborted";

export interface AdvisorTurnResult {
  text: string;
  toolCalls: number;
  outcome: AdvisorTurnOutcome;
}

// --- malformed tool-call generation -----------------------------------------

/**
 * Detect the degraded generation where the endpoint emits a tool call as PROSE:
 * `finish_reason: "stop"`, zero structured tool calls, and a `<tool_call>` or
 * `<some__tool-name>` block sitting in the content.
 *
 * Per the endpoint owners this is a known, rare SERVER-SIDE degradation that a
 * server restart clears. It is not a prompt problem and not something the
 * client can negotiate away.
 *
 * ============================ DO NOT PARSE THIS =============================
 * It is obvious that the XML here could be parsed back into a real tool call,
 * and a future editor WILL notice that and think it is an easy win. It is not
 * sanctioned: the endpoint owners explicitly asked that this not be worked
 * around by parsing, because a client that silently repairs the malformed
 * output hides the degradation from the operators who can actually fix it, and
 * makes the remedy (restart the server) look unnecessary.
 *
 * Detection exists to REPORT, never to recover. If you are about to add a
 * parser here, take it up with the endpoint owners first.
 * ============================================================================
 *
 * Why this matters more than a normal malformed response: the persona instructs
 * the model to source every factual claim from a tool result. A turn where the
 * model INTENDED to call a tool and no tool ran is precisely the turn whose
 * prose is most likely to be invented — and it renders as a finished answer.
 */
/**
 * Structural markers of an attempted tool call. Every one of these was observed
 * LIVE on 2026-07-22 while the endpoint was in the degraded state — the model
 * varies the wrapper it invents from generation to generation, so matching only
 * `<tool_call>` missed two of six real captured shapes.
 */
const MALFORMED_MARKERS = [
  /<\/?tool_call>/i,
  /<\/?tool_code>/i,
  /<\/function>/i,
  /<function[= ]/i,
  /<parameter name=/i,
];

export function detectMalformedToolCall(
  text: string,
  toolCalls: number,
  toolNames: readonly string[],
  stopReason: StopReason,
): boolean {
  // ===================== KEEP THIS CONDITION NARROW ==========================
  // The endpoint owners' signature for this degradation is finish_reason
  // "stop" — the model came to a clean end and simply put the tool call in the
  // wrong channel. pi-ai maps finish_reason onto `stopReason`
  // (providers/openai-completions.js mapStopReason), and "stop" is the mapped
  // equivalent; the raw field is not exposed through the harness reply, so this
  // is the reachable form of the check.
  //
  // A generation cut off mid-stream also leaves partial tool-call XML in
  // content with zero tool calls, and looks identical to the two checks below.
  // It arrives as "length", not "stop", and it is OUR problem — raise
  // maxTokens, trim context — not the endpoint's. `truncated` covers it.
  //
  // This distinction is the whole point, and it is the answer to the future
  // editor who wants to relax this to "catch more cases": the remedy attached
  // to malformed_tool_call is ASKING A HUMAN TO RESTART A SHARED SERVER. Every
  // false positive spends an operator's attention on a restart that cannot fix
  // anything, and a report that is wrong some of the time is a report people
  // learn to ignore — at which point the true positives stop being actioned
  // too. An under-firing detector costs one mislabelled turn; an over-firing
  // one costs the credibility of the whole signal. Widening this is a decision
  // to take up with the endpoint owners, not a tidy-up.
  //
  // This is not hypothetical. A previous fix wave reported this endpoint as
  // degraded in 100% of 11 trials and recommended a restart on the strength of
  // a detector that did not check the stop reason.
  // ===========================================================================
  if (stopReason !== "stop") return false;
  // A turn that really ran tools is not this failure, whatever else is in the
  // prose — a legitimate answer may quote a tool name in angle brackets.
  if (toolCalls > 0) return false;
  if (!text) return false;
  if (MALFORMED_MARKERS.some((re) => re.test(text))) return true;
  // An INTERNAL tool identifier (`cu_public__list-clemson-terms`) appearing in
  // the answer text when NO tool was called.
  //
  // An earlier version of this also required invocation punctuation (`{` or
  // `<`) nearby, on the theory that a bare mention might be legitimate. Live
  // verification killed that theory: a captured generation's entire content was
  // the bare string `cu_public__list-clemson-terms`, which slipped through.
  //
  // The zero-tool-call condition above is what makes the bare check safe. A
  // real answer speaks to an advisor about courses and never prints a tool's
  // wire name; and a turn that legitimately narrates its tool use has
  // toolCalls > 0 and returned before reaching here.
  return toolNames.some((name) => text.includes(name));
}

// --- context budget ---------------------------------------------------------

/**
 * Rough token estimate. Deliberately a character heuristic and not a tokenizer:
 * the budget needs a cheap bound every request, not an exact count, and 4
 * chars/token overestimates for English prose and JSON alike (i.e. errs toward
 * trimming early, which is the safe direction).
 */
function estimateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload ?? "").length / 4);
}

interface PayloadMessage {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

const TRIMMED_MARKER =
  "[tool result trimmed to fit the context budget — re-run the tool if you need this data]";

/**
 * Roles that carry the persona and must never be trimmed. Both spellings count:
 * the OpenAI chat-completions family renamed "system" to "developer", and pi-ai
 * emits "developer" for this provider.
 */
function isSystemRole(role: unknown): boolean {
  return role === "system" || role === "developer";
}

/**
 * Bring a chat-completions payload under `maxTokens`, or throw.
 *
 * Order matters. Tool results are the unbounded term — Task 6's schedule
 * request made 8 tool calls, and a catalog query can return kilobytes — so they
 * are trimmed FIRST, oldest first, since the newest result is the one the model
 * is currently reasoning about. Conversation history goes only after every tool
 * result has already been dropped.
 *
 * Two things this deliberately does NOT do:
 *
 *  - it does not keep a per-result floor. A floor that every result is entitled
 *    to is a floor that GROWS the request as the tool count grows, which is the
 *    opposite of a budget. A trimmed result becomes a marker, not a prefix.
 *  - it does not give up quietly. If the payload is still over budget after
 *    everything trimmable is gone, it throws. A silently degraded request
 *    produces a confidently wrong answer; a thrown one produces an error the
 *    advisor can see. Failing loudly beats failing subtly.
 *
 * The system prompt and the newest user message are never trimmed: a request
 * without them is not a smaller version of the request, it is a different one.
 */
export function enforceContextBudget(
  payload: Record<string, unknown>,
  maxTokens: number,
): Record<string, unknown> {
  if (estimateTokens(payload) <= maxTokens) return payload;

  const messages = Array.isArray(payload.messages)
    ? ([...payload.messages] as PayloadMessage[])
    : null;
  if (!messages) {
    throw new Error(
      `advisor request is ${estimateTokens(payload)} tokens against a budget of ${maxTokens} and carries no trimmable messages`,
    );
  }

  const next = { ...payload, messages };
  const isTrimmedAlready = (m: PayloadMessage) => m.content === TRIMMED_MARKER;

  // 1. Tool results, oldest first.
  for (let i = 0; i < messages.length; i++) {
    if (estimateTokens(next) <= maxTokens) return next;
    const m = messages[i]!;
    if (m.role !== "tool" || isTrimmedAlready(m)) continue;
    messages[i] = { ...m, content: TRIMMED_MARKER };
  }

  // 2. History, oldest first, never the system prompt and never the last
  //    message (the turn's own input).
  //
  //    "system" is NOT the only role the persona can arrive under. pi-ai emits
  //    the system prompt as role "developer" for this provider — verified on
  //    the wire, where the captured payload's first message was
  //    `developer:3701`, not `system`. A guard that matched only "system"
  //    therefore did not protect the persona at all: it fell through to the
  //    splice below and was the FIRST thing deleted, since it is the oldest
  //    message. That produces a request that is under budget and has lost the
  //    advisor's entire persona and sourcing rules — the silent degradation
  //    this function's own doc comment promises not to do.
  for (let i = 0; i < messages.length - 1; i++) {
    if (estimateTokens(next) <= maxTokens) return next;
    if (isSystemRole(messages[i]!.role)) continue;
    messages.splice(i, 1);
    i--;
  }

  const finalSize = estimateTokens(next);
  if (finalSize > maxTokens) {
    throw new Error(
      `advisor request is ${finalSize} tokens after trimming every tool result and all history, against a budget of ${maxTokens}; refusing to send a request the model cannot answer`,
    );
  }
  return next;
}

/**
 * Strip a `tool_choice` that the endpoint cannot accept alongside thinking.
 *
 * HARD CONSTRAINT from the endpoint docs: `tool_choice: "required"` together
 * with `chat_template_kwargs.enable_thinking: true` returns HTTP 400 on this
 * stack. We never set tool_choice ourselves today, but pi-ai forwards
 * `options.toolChoice` straight into the payload (openai-completions.js:435),
 * so anything that later sets a thinking level plus a required tool choice —
 * including a future harness default — would 400 every request.
 *
 * Dropping to "auto" rather than disabling thinking is deliberate: thinking is
 * what the endpoint docs prescribe for this model, and "auto" still lets the
 * model call tools.
 */
export function reconcileToolChoiceWithThinking(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const kwargs = payload.chat_template_kwargs as
    | { enable_thinking?: unknown }
    | undefined;
  if (!kwargs?.enable_thinking) return payload;
  if (payload.tool_choice !== "required") return payload;
  log.warn(
    "advisor dropped tool_choice=required: the endpoint rejects it with enable_thinking",
  );
  return { ...payload, tool_choice: "auto" };
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
  // Injectable so a test can exercise the ceiling without waiting out the real
  // one. Production always uses the configured value.
  timeoutMs: number = ADVISOR_TURN_TIMEOUT_MS,
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
    // The third input pi-ai's `qwen-chat-template` branch needs. The harness
    // turns thinkingLevel into `options.reasoning` (agent-harness.js:339),
    // which openai-completions.js turns into `reasoningEffort`, which is what
    // makes `chat_template_kwargs.enable_thinking` true rather than false.
    // "off" — the harness default — would send enable_thinking:false, which is
    // NOT what the endpoint docs prescribe for this model.
    thinkingLevel: "medium",
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

  // Round cap — enforced at the PROVIDER REQUEST, not at the tool result.
  //
  // The previous version bounded the loop only through `terminate` on
  // ToolResultPatch, set from the `tool_result` hook. That hook is Pi's
  // `afterToolCall`, and `afterToolCall` runs ONLY inside
  // finalizeExecutedToolCall (agent-loop.js:439). A tool call whose preparation
  // resolves as `kind: "immediate"` never reaches it (agent-loop.js:281-286,
  // :300-312), and `prepareToolCall` returns `immediate` for two conditions the
  // MODEL controls: an unknown tool name (:361-367) and arguments that fail
  // schema validation (:406-412). Since `shouldTerminateToolBatch` (:344-345)
  // requires EVERY call in the batch to carry terminate, a model that keeps
  // hallucinating a tool name never sets it on any call and the loop never
  // ends — measured at 63 provider requests against a cap of 8.
  //
  // That is not a hypothetical: the malformed generations that trigger it are a
  // known server-side degradation we cannot prevent (see
  // detectMalformedToolCall). The loop bound is the containment.
  //
  // So the cap is enforced where every path must pass regardless of how a tool
  // call resolved: the provider request itself. Aborting is what actually ends
  // the loop — a hook return value cannot.
  let rounds = 0;
  let toolCalls = 0;
  let hitRoundCap = false;
  let hitTimeout = false;
  harness.on("before_provider_request", () => {
    rounds++;
    if (rounds > ADVISOR_MAX_ROUNDS) {
      hitRoundCap = true;
      void harness.abort();
    }
    return undefined;
  });
  harness.on("tool_call", () => {
    toolCalls++;
    return undefined;
  });
  // Kept as the GRACEFUL bound for the ordinary path: it stops the loop after
  // the current batch without an abort, so the turn ends with the tool output
  // intact (agent-loop.js:454 merges `afterResult.content ?? result.content`).
  // It is no longer the only bound, because it provably cannot cover calls that
  // never reach afterToolCall.
  harness.on("tool_result", () => {
    if (rounds < ADVISOR_MAX_ROUNDS) return undefined;
    hitRoundCap = true;
    return { terminate: true };
  });

  // Wall-clock ceiling. The round cap bounds how many times the model is asked;
  // nothing bounded how LONG one turn could take. A stalled provider held the
  // request, the session's directories, and the advisor's browser tab open
  // indefinitely — only a client disconnect ended it.
  const deadline = setTimeout(() => {
    hitTimeout = true;
    log.warn("advisor turn exceeded its wall-clock ceiling", {
      session: session.id,
      provider: target.name,
      timeoutMs,
    });
    void harness.abort();
  }, timeoutMs);
  deadline.unref?.();

  if (target.model.api === "openai-completions") {
    harness.on("before_provider_payload", (event) => {
      let payload = event.payload as Record<string, unknown>;
      // temperature is not part of AgentHarnessStreamOptions in 0.75.4, so it
      // is injected into the provider payload directly.
      //
      // Only for chat-completions providers. The openai fallback is
      // `openai-responses` with a reasoning model, and the Responses API
      // rejects `temperature` for those — injecting it unconditionally would
      // 400 the fallback on every single request, i.e. exactly when it is
      // needed. That gate is on model.api and must survive.
      payload = { ...payload, temperature: ADVISOR_TEMPERATURE };
      // The OUTPUT budget, injected here for the same reason temperature is:
      // the model's declared `maxTokens: 8192` never reaches the wire, because
      // pi-agent-core's createStreamFn passes pi-ai an explicit allowlist of
      // stream options that does not include maxTokens, and pi-ai emits
      // max_tokens only when `options.maxTokens` is set. Confirmed with a
      // capturing proxy against the real endpoint: no max_tokens and no
      // max_completion_tokens on any request, so the server's own default was
      // the only bound on generation.
      //
      // Setting it on the model object does NOT work and a future editor should
      // not "simplify" this away by moving it there — that is exactly the field
      // that is already set and already ignored.
      payload = { ...payload, max_tokens: ADVISOR_MAX_OUTPUT_TOKENS };
      // Never let tool_choice:"required" ship next to enable_thinking:true.
      payload = reconcileToolChoiceWithThinking(payload);
      // Last, so it measures what would actually be sent.
      payload = enforceContextBudget(payload, ADVISOR_MAX_REQUEST_TOKENS);
      return { payload };
    });
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

    const malformed = detectMalformedToolCall(
      text,
      toolCalls,
      (bridge?.tools ?? []).map((t) => t.name),
      reply.stopReason,
    );
    const truncated = reply.stopReason === "length";

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
      hitTimeout,
      malformed,
      truncated,
    });

    if (reply.stopReason === "error") {
      throw new Error(reply.errorMessage || "provider returned an error");
    }

    // The caller's own stop wins over every other reason the turn ended: the
    // advisor pressed stop, and saying anything else misreports their action.
    if (signal?.aborted) {
      return { text, toolCalls, outcome: "aborted" };
    }
    // Our own aborts. harness.abort() makes prompt() RESOLVE with stopReason
    // "aborted" and whatever text had streamed so far (agent-loop.js:107
    // returns early on it), so the reason we aborted has to come from our own
    // flags — the stopReason cannot tell these apart.
    if (hitTimeout) return { text, toolCalls, outcome: "timeout" };
    if (hitRoundCap) return { text, toolCalls, outcome: "round_cap" };
    // Without its own branch a stopped turn is indistinguishable from a
    // finished one, and the UI's stop control would render a truncated answer
    // as final.
    if (reply.stopReason === "aborted") {
      return { text, toolCalls, outcome: "aborted" };
    }

    // The output budget ran out mid-generation. Checked BEFORE the malformed
    // branch so the two can never be confused at the call site either, not just
    // inside the detector — and logged at warn with an explicitly OURS remedy,
    // because the greppable line next door asks an operator to restart a shared
    // server and these two must never look alike in the log stream.
    if (truncated) {
      log.warn(
        "advisor turn hit the output token budget and was cut off mid-generation — raise ADVISOR_MAX_OUTPUT_TOKENS or trim context (this is OUR budget, not an endpoint fault; do NOT restart the model server)",
        {
          session: session.id,
          provider: target.name,
          model: target.model.id,
          maxOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
          outputTokens: reply.usage?.output,
        },
      );
      return { text, toolCalls, outcome: "truncated" };
    }

    if (malformed) {
      // A distinct, greppable line: the remedy is an operator action (restart
      // the endpoint), not a retry and not a prompt change, so this must not
      // blend into the ordinary warn stream. Metadata only — the prose that
      // triggered detection may carry student information.
      log.error(
        "advisor endpoint emitted a tool call as prose — KNOWN SERVER-SIDE DEGRADATION, RESTART THE MODEL SERVER (do not parse the output)",
        {
          session: session.id,
          provider: target.name,
          model: target.model.id,
          baseUrl: target.model.baseUrl,
          stopReason: reply.stopReason,
        },
      );
      return { text, toolCalls, outcome: "malformed_tool_call" };
    }

    // An EMPTY answer with no tool calls is not a finished turn, and it must
    // not render as a blank one.
    //
    // Observed live 2026-07-22: with enable_thinking on, the endpoint can spend
    // its whole completion budget in `reasoning` deltas and then stop with
    // finish_reason "stop", no content and no tool calls. pi-ai parses the
    // reasoning correctly, but reasoning is not an answer — it is filtered out
    // of `text` — so the turn arrived here with an empty string and the outcome
    // `complete`. Enabling thinking makes this more reachable, so the guard
    // ships alongside it.
    //
    // Thrown rather than returned so the provider chain treats it as a failed
    // attempt and falls through to the fallback, which is the right response to
    // a provider that returned nothing: runAttempt discards the attempt's JSONL
    // and the advisor gets an answer from the next provider.
    if (!text) {
      throw new Error(
        "provider returned no answer text and called no tools (thinking-only generation)",
      );
    }

    return { text, toolCalls, outcome: "complete" };
  } finally {
    clearTimeout(deadline);
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
  timeoutMs?: number,
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
      timeoutMs,
    );
    // An aborted turn is discarded too: the advisor pressed stop, so the
    // half-finished exchange should not become permanent history.
    //
    // A malformed_tool_call turn is discarded for a different reason: its text
    // is a tool call rendered as prose. Committing that to the JSONL would put
    // a malformed example into every later turn's context, where it invites the
    // model to repeat the shape.
    if (
      result.outcome !== "aborted" &&
      result.outcome !== "malformed_tool_call"
    ) {
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
    // Resolve FIRST, then gate. The gate has to see the model object that pi-ai
    // will dial — it reads `model.baseUrl` and nothing else — so checking before
    // the target exists would be checking a configuration string instead of the
    // destination. An unconfigured entry is skipped without a check because
    // nothing is sent to it.
    const target = resolveProvider(name);
    if (!target) {
      errors.push(`${name}: not configured`);
      continue;
    }
    // The gate on the bytes actually about to leave. Re-checked per entry
    // reached rather than once at startup, so a fallback is authorized on its
    // own record and not on the primary's.
    assertAdvisorTargetAuthorized(target);
    try {
      const result = await runAttempt(target, session, input, signal);
      // A stopped turn is the caller's decision, not a provider failure. Do not
      // burn the fallback provider re-running work the advisor cancelled.
      return result;
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
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

/**
 * Test seam: the REAL provider target, so tests of the model's wire
 * configuration exercise the shipped fields rather than a copy of them that can
 * drift away from what the service actually sends.
 */
export const __resolveProviderForTest = resolveProvider;

/**
 * Test seam: the host resolver the gate uses by default, so a test can prove it
 * reads the model object rather than an environment variable pi-ai ignores.
 */
export const __dialledHostForTest = dialledHost;
