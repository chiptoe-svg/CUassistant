// Tool-call ceiling probe — a MEASUREMENT harness, not a fix and not a diagnosis.
//
// Why this file exists
// --------------------
// Four separate confident diagnoses of "the model won't call tools" were made
// on this project and all four were wrong: a server degradation that wasn't, a
// max_tokens truncation that never occurred in production, a tool-surface
// breadth limit, and a namespace-prefix mechanism. Every one of them came from
// n=3 or n=4, sometimes against an endpoint whose state was never checked. A
// later n=10 run scored 1/10 for a variant that had scored 3/3 twenty minutes
// earlier.
//
// So this harness is built so that an underpowered or invalid measurement
// CANNOT be reported as a result:
//
//   1. >= 20 trials per cell. Fewer requires --allow-underpowered, which stamps
//      NON-CONCLUSIVE on every affected row and on the report header. A bare
//      ratio from a small n is never printed as though it were a finding.
//   2. The user message is varied across >= 6 realistic advisor questions and
//      reported per-message, because one unlucky prompt is not a ceiling.
//   3. Endpoint state is read before AND after every block. If the target model
//      is not resident, something else is loading, or the state moved mid-block,
//      the block is marked INVALID and its numbers are withheld.
//   4. Every trial gets exactly one of six distinct classes. A clean HTTP 400
//      was twice recorded on this project as "the model made zero tool calls".
//      http_error and unparseable exist so that can't happen again.
//   5. A Wilson score interval accompanies every rate, so 18/20 and 180/200
//      cannot read as the same evidence.
//
// This harness deliberately DOES NOT conclude. It prints the table, the
// classifications, the intervals, and any INVALID blocks. Interpreting them is
// the human's job — premature interpretation is the thing this tool exists to
// prevent.
//
// Usage:
//   npx tsx scripts/tool-ceiling-probe.ts [options]
//     --trials N          trials per cell (default 20, minimum 20)
//     --counts a,b,c      tool counts to test (default 8,12,17,25,35)
//     --variants a,b,c    bare,single,double (default all three)
//     --frontier          add an OpenAI control endpoint alongside spark
//     --allow-underpowered  permit --trials < 20, labelled NON-CONCLUSIVE
//     --report PATH       also write the report markdown to PATH

import { readFileSync, writeFileSync } from "node:fs";

import {
  ADVISOR_BASE_URL,
  CLEMSON_LLM_API_KEY,
  CLEMSON_LLM_OPENAI_BASE_URL,
  OPENAI_API_KEY,
} from "../src/config.ts";

// ---------------------------------------------------------------------------
// Pure logic (exported for test/tool-ceiling-probe.test.ts — no network)
// ---------------------------------------------------------------------------

export const MIN_TRIALS = 20;

export type TrialClass =
  | "tool_calls"
  | "malformed"
  | "truncated"
  | "no_tool_call"
  | "http_error"
  | "unparseable";

export const TRIAL_CLASSES: TrialClass[] = [
  "tool_calls",
  "malformed",
  "truncated",
  "no_tool_call",
  "http_error",
  "unparseable",
];

/** Raw observation from one request, before it is given a class. */
export interface TrialObservation {
  /** HTTP status. 0 means the request never completed (network error/timeout). */
  status: number;
  /** SSE frames that parsed as JSON. Zero frames on a 200 is a dead stream. */
  parsedFrames: number;
  /** Whether the body could be parsed at all (stream frames or JSON object). */
  bodyParsed: boolean;
  /** Number of structured tool-call deltas observed. */
  toolCallCount: number;
  /** Terminal finish_reason, if the stream reported one. */
  finishReason: string | null;
  /** Accumulated assistant content (not reasoning). */
  content: string;
}

/**
 * Tool-call syntax leaking into the content channel as text. When the endpoint
 * does this it reports finish_reason "stop" and zero structured tool calls, so
 * without this check it is indistinguishable from the model simply choosing to
 * answer in prose — a distinction that matters enormously and was collapsed
 * before.
 */
const TOOL_CALL_XML = [
  /<tool_call\b/i,
  /<\/tool_call>/i,
  /<function\s*=/i,
  /<function_call\b/i,
  /<\|tool_call/i,
  /<tool_calls?\b/i,
  /<invoke\b/i,
];

export function looksLikeToolCallXml(content: string): boolean {
  return TOOL_CALL_XML.some((re) => re.test(content));
}

/**
 * Assign exactly one class to a trial.
 *
 * Precedence is deliberate and load-bearing:
 *   http_error before everything — a 4xx/5xx carries no generation to judge.
 *   unparseable before everything else — a 200 with a dead body is not a
 *     behavioural observation about the model, it is a broken measurement.
 *   tool_calls next, matching the literal success criterion (structured tool
 *     calls present). finish_reason is still reported separately per cell, so a
 *     tool call that also hit the length cap remains visible rather than hidden.
 *   truncated before the text classes, so a cut-off generation is never filed
 *     as "the model declined to call a tool".
 *   malformed before no_tool_call, so XML-in-content is never filed as prose.
 */
export function classifyTrial(obs: TrialObservation): TrialClass {
  if (obs.status === 0 || obs.status < 200 || obs.status >= 300) {
    return "http_error";
  }
  if (!obs.bodyParsed || obs.parsedFrames === 0) {
    return "unparseable";
  }
  if (obs.toolCallCount > 0) {
    return "tool_calls";
  }
  if (obs.finishReason === "length") {
    return "truncated";
  }
  if (looksLikeToolCallXml(obs.content)) {
    return "malformed";
  }
  return "no_tool_call";
}

export interface Interval {
  point: number;
  low: number;
  high: number;
  n: number;
  successes: number;
}

/**
 * Wilson score interval. Chosen over the normal approximation because it stays
 * sane at the extremes (20/20, 0/20) where this probe actually lives — the
 * normal interval would report [1.0, 1.0] for 20/20 and imply certainty that
 * 20 samples cannot support.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n <= 0) {
    return { point: 0, low: 0, high: 1, n: 0, successes: 0 };
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    point: p,
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
    n,
    successes,
  };
}

export function formatInterval(iv: Interval): string {
  const pct = (x: number) => (x * 100).toFixed(0).padStart(3);
  return `${pct(iv.point)}% [${pct(iv.low)}-${pct(iv.high)}]`;
}

// ---------------------------------------------------------------------------
// Endpoint state
// ---------------------------------------------------------------------------

export interface EndpointState {
  /** State string of the target model, or null when absent from the list. */
  target: string | null;
  /** Ids of any OTHER model reporting a loading-ish state. */
  othersLoading: string[];
  /** True when the endpoint has no per-model state field (e.g. OpenAI). */
  stateless: boolean;
  error?: string;
}

const LOADING_STATES = ["loading", "starting", "pending", "warming"];

export function readModelsResponse(
  json: unknown,
  targetModel: string,
): EndpointState {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { target: null, othersLoading: [], stateless: false, error: "no data array" };
  }
  let target: string | null = null;
  let anyStateField = false;
  const othersLoading: string[] = [];
  for (const entry of data as Array<Record<string, unknown>>) {
    const id = String(entry.id ?? "");
    const state = typeof entry.state === "string" ? entry.state : null;
    if (state !== null) anyStateField = true;
    if (id === targetModel) {
      target = state;
    } else if (state !== null && LOADING_STATES.includes(state.toLowerCase())) {
      othersLoading.push(`${id}=${state}`);
    }
  }
  return { target, othersLoading, stateless: !anyStateField };
}

/**
 * A block is valid only when the endpoint held still for its whole duration.
 * A concurrent model load silently corrupts results and produced one of the
 * four wrong conclusions this harness exists to prevent.
 */
export function blockValidity(
  before: EndpointState,
  after: EndpointState,
): { valid: boolean; reason: string } {
  if (before.error) return { valid: false, reason: `pre-check failed: ${before.error}` };
  if (after.error) return { valid: false, reason: `post-check failed: ${after.error}` };
  if (before.stateless && after.stateless) {
    return { valid: true, reason: "endpoint reports no model state (not checked)" };
  }
  if (before.target !== "resident") {
    return { valid: false, reason: `target not resident before block (state=${before.target})` };
  }
  if (after.target !== "resident") {
    return { valid: false, reason: `target not resident after block (state=${after.target})` };
  }
  if (before.othersLoading.length > 0) {
    return { valid: false, reason: `other model loading before block: ${before.othersLoading.join(", ")}` };
  }
  if (after.othersLoading.length > 0) {
    return { valid: false, reason: `other model loading during/after block: ${after.othersLoading.join(", ")}` };
  }
  return { valid: true, reason: "resident before and after, nothing else loading" };
}

// ---------------------------------------------------------------------------
// Tool surface construction
// ---------------------------------------------------------------------------

export type NamingVariant = "bare" | "single" | "double";

export function applyNaming(
  namespace: string | null,
  bareName: string,
  variant: NamingVariant,
): string {
  if (!namespace) return bareName;
  if (variant === "bare") return bareName;
  if (variant === "single") return `${namespace}_${bareName}`;
  return `${namespace}__${bareName}`;
}

export interface RealTool {
  namespace: string | null;
  bareName: string;
  description: string;
  parameters: unknown;
}

/**
 * Build a tool array of exactly `count` entries.
 *
 * Ordering matters: the tools that can actually ANSWER the probe questions are
 * held at the front and therefore present in every slice. An earlier probe on
 * this project sliced them away, watched the model correctly decline to call
 * anything, and scored that as degradation.
 *
 * Above the real-tool count the surface is padded with byte-for-byte CLONES of
 * a real tool differing only in name. Clones are not representative — they add
 * count and bytes without adding semantic variety — and the caller is told how
 * many were used so the row can be read with that in mind.
 */
export function buildToolSurface(
  real: RealTool[],
  count: number,
  variant: NamingVariant,
): { tools: unknown[]; cloned: number } {
  const named = real.map((t) => ({
    type: "function" as const,
    function: {
      name: applyNaming(t.namespace, t.bareName, variant),
      description: t.description,
      parameters: t.parameters,
    },
  }));
  if (count <= named.length) {
    return { tools: named.slice(0, count), cloned: 0 };
  }
  const out = [...named];
  const donor = named[0]!;
  let i = 0;
  while (out.length < count) {
    out.push({
      type: "function" as const,
      function: {
        ...donor.function,
        name: applyNaming(
          "cu_clone",
          `filler-tool-${i}`,
          variant === "bare" ? "bare" : variant,
        ),
      },
    });
    i++;
  }
  return { tools: out, cloned: count - named.length };
}

/**
 * Realistic advisor questions, cycled across trials so no cell's number is an
 * artifact of a single prompt. All of them are answerable from the first eight
 * tools, so they stay answerable at every tool count in the matrix.
 *
 * KNOWN CONFOUND — two of these are UNDERSPECIFIED and their low tool-call
 * rates are a property of the question, not of the model or the tool surface:
 *
 *   - "Do CRN 12345 and CRN 23456 conflict with each other?" names no term,
 *     and `term` is REQUIRED by check-schedule-conflicts.
 *   - "What rooms are free Wednesday afternoon in Fall 2026?" names no
 *     building or room, both REQUIRED by get-clemson-room-availability — and
 *     no tool answers "which rooms", only "is this room free".
 *
 * Measured 2026-07-22, n=40 per cell, tools=17, bare naming, endpoint steady:
 * the conflict question scores 0-3% as written and 100% [91-100] once a term
 * is added, with real and fake CRNs indistinguishable in both conditions. The
 * misses are the model ASKING for the missing required argument — the correct
 * and safe behaviour, and the opposite of answering from memory.
 *
 * Note that `no_tool_call` does not distinguish "asked a clarifying question"
 * from "fabricated an answer". When a cell's rate is low, read the actual
 * generations before concluding anything about tool-calling. See
 * `.superpowers/sdd/message-effect-report.md`.
 */
export const PROBE_MESSAGES = [
  "What CPSC 3000-level classes are offered in Fall 2026? Use your tools.",
  "Which terms can I search right now?",
  "Is there a section of GC 3400 that meets on Tuesdays in Fall 2026?",
  "Find me the classes Dr. Sanders is teaching next term.",
  "Do CRN 12345 and CRN 23456 conflict with each other?",
  "What rooms are free Wednesday afternoon in Fall 2026?",
  "Give me a conflict-free schedule for a GC junior in Fall 2026.",
  "What does the skill documentation say about searching for sections?",
];

/**
 * Apply per-tool description overrides by BARE name, before naming variants are
 * applied. Used by the message-effect experiment to test whether rewriting a
 * tool's trigger conditions changes how often it is called, while holding the
 * persona, tool count, naming, temperature and endpoint constant.
 *
 * Overriding a name that is not present is a hard error: a silently-ignored
 * override would make a "no effect" cell indistinguishable from a cell where
 * the manipulation never happened, which is exactly the kind of uncontrolled
 * variable this harness exists to rule out.
 */
export function applyDescriptionOverrides(
  real: RealTool[],
  overrides: Record<string, string>,
): RealTool[] {
  const known = new Set(real.map((t) => t.bareName));
  for (const name of Object.keys(overrides)) {
    if (!known.has(name)) {
      throw new Error(
        `description override targets unknown tool "${name}" — ` +
          `known tools: ${[...known].sort().join(", ")}`,
      );
    }
  }
  return real.map((t) =>
    Object.prototype.hasOwnProperty.call(overrides, t.bareName)
      ? { ...t, description: overrides[t.bareName]! }
      : t,
  );
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

interface Endpoint {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Strip vLLM-specific fields the frontier API rejects. */
  frontier: boolean;
}

function modelsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/v1\/?$/, "");
  return `${root}/v1/models`;
}

async function fetchEndpointState(ep: Endpoint): Promise<EndpointState> {
  try {
    const res = await fetch(modelsUrl(ep.baseUrl), {
      headers: { authorization: `Bearer ${ep.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return {
        target: null,
        othersLoading: [],
        stateless: false,
        error: `HTTP ${res.status}`,
      };
    }
    return readModelsResponse(await res.json(), ep.model);
  } catch (err) {
    return {
      target: null,
      othersLoading: [],
      stateless: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runTrial(
  ep: Endpoint,
  body: Record<string, unknown>,
): Promise<TrialObservation> {
  const obs: TrialObservation = {
    status: 0,
    parsedFrames: 0,
    bodyParsed: false,
    toolCallCount: 0,
    finishReason: null,
    content: "",
  };
  let res: Response;
  try {
    res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    obs.status = 0;
    obs.content = err instanceof Error ? err.message : String(err);
    return obs;
  }
  obs.status = res.status;
  const raw = await res.text();
  if (!res.ok) {
    obs.content = raw.slice(0, 400);
    return obs;
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    let chunk: { choices?: Array<Record<string, any>> };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    obs.parsedFrames++;
    obs.bodyParsed = true;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) obs.content += String(choice.delta.content);
    if (choice.delta?.tool_calls) obs.toolCallCount += choice.delta.tool_calls.length;
    if (choice.finish_reason) obs.finishReason = String(choice.finish_reason);
  }
  // Non-streaming fallback: a plain JSON completion object.
  if (obs.parsedFrames === 0) {
    try {
      const json = JSON.parse(raw) as { choices?: Array<Record<string, any>> };
      const choice = json.choices?.[0];
      if (choice) {
        obs.bodyParsed = true;
        obs.parsedFrames = 1;
        obs.content = String(choice.message?.content ?? "");
        obs.toolCallCount = choice.message?.tool_calls?.length ?? 0;
        obs.finishReason = choice.finish_reason ?? null;
      }
    } catch {
      /* leave unparseable */
    }
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

interface CellResult {
  endpoint: string;
  toolCount: number;
  variant: NamingVariant;
  cloned: number;
  trials: number;
  counts: Record<TrialClass, number>;
  perMessage: Map<string, { n: number; toolCalls: number }>;
  finishReasons: Record<string, number>;
  interval: Interval;
  valid: boolean;
  validity: string;
  httpStatuses: Record<string, number>;
  elapsedMs: number;
}

function emptyCounts(): Record<TrialClass, number> {
  return {
    tool_calls: 0,
    malformed: 0,
    truncated: 0,
    no_tool_call: 0,
    http_error: 0,
    unparseable: 0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    trials: Number(get("--trials") ?? MIN_TRIALS),
    counts: (get("--counts") ?? "8,12,17,25,35").split(",").map(Number),
    variants: (get("--variants") ?? "bare,single,double").split(",") as NamingVariant[],
    frontier: argv.includes("--frontier"),
    allowUnderpowered: argv.includes("--allow-underpowered"),
    report: get("--report"),
    // --- controlled-cell overrides (all optional; defaults reproduce the
    // original matrix run byte-for-byte) ---
    messageFile: get("--message-file"),
    systemFile: get("--system-file"),
    descFile: get("--desc-file"),
    cellLabel: get("--cell-label"),
  };
}

async function loadRealTools(): Promise<RealTool[]> {
  const servers: Array<{ ns: string; url: string }> = [
    { ns: "cu_public", url: "http://127.0.0.1:8766/mcp" },
    { ns: "cu_catalog", url: "http://127.0.0.1:8767/mcp" },
  ];
  const out: RealTool[] = [];
  for (const { ns, url } of servers) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    if (!line) throw new Error(`no tools/list frame from ${url}`);
    const json = JSON.parse(line.slice(6)) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    };
    for (const t of json.result.tools) {
      out.push({
        namespace: ns,
        bareName: t.name,
        description: t.description,
        parameters: t.inputSchema,
      });
    }
  }
  // propose_schedule is a host tool, not an MCP tool, and carries no namespace
  // in any variant — its name is identical across all three.
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/advisor-schedule.schema.json", import.meta.url), "utf8"),
  );
  out.push({
    namespace: null,
    bareName: "propose_schedule",
    description:
      "Render a proposed schedule as an artifact for the advisor to review. Call this instead of describing the schedule in prose.",
    parameters: schema,
  });
  return out;
}

/**
 * Hold the answering tools at the front so every slice can answer the probe
 * questions. See buildToolSurface.
 */
const ANSWERING_FIRST = [
  "list-clemson-terms",
  "search-clemson-classes",
  "get-clemson-section-details",
  "find-clemson-instructor-classes",
  "get-clemson-room-availability",
  "check-schedule-conflicts",
  "find-conflict-free-schedule",
  "list-skills",
  "get-skill-docs",
];

function orderTools(real: RealTool[]): RealTool[] {
  const rank = (t: RealTool) => {
    const i = ANSWERING_FIRST.indexOf(t.bareName);
    return i >= 0 ? i : ANSWERING_FIRST.length;
  };
  return [...real].sort((a, b) => rank(a) - rank(b));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.trials < MIN_TRIALS && !args.allowUnderpowered) {
    console.error(
      `REFUSED: --trials ${args.trials} is below the ${MIN_TRIALS}-trial minimum.\n` +
        `\n` +
        `This harness exists because four wrong conclusions on this project came\n` +
        `from n=3 and n=4 samples. A ratio from ${args.trials} trials is not a finding and\n` +
        `will not be printed as one.\n` +
        `\n` +
        `If you need a smoke test rather than a measurement, re-run with\n` +
        `--allow-underpowered; every row and the report header will be stamped\n` +
        `NON-CONCLUSIVE.`,
    );
    process.exit(2);
  }
  const underpowered = args.trials < MIN_TRIALS;

  const captured = JSON.parse(readFileSync("/tmp/advisor-payload.json", "utf8")) as Record<
    string,
    any
  >;

  const endpoints: Endpoint[] = [
    {
      label: "spark",
      baseUrl: ADVISOR_BASE_URL,
      model: String(captured.model),
      apiKey: "local",
      frontier: false,
    },
  ];
  if (args.frontier) {
    // The frontier control now reaches OpenAI through Clemson's consolidated
    // gateway rather than dialling api.openai.com directly — same route the
    // advisor's `openai` chain entry takes, so the control measures the path
    // that would actually ship. `frontier: true` still strips the vLLM-specific
    // fields, because the passthrough forwards to the real OpenAI API.
    const gatewayKey = CLEMSON_LLM_API_KEY || OPENAI_API_KEY;
    if (!gatewayKey) {
      console.error(
        "REFUSED: --frontier requested but CLEMSON_LLM_API_KEY is unset.",
      );
      process.exit(2);
    }
    endpoints.push({
      label: "frontier",
      baseUrl: CLEMSON_LLM_OPENAI_BASE_URL,
      model: process.env.ADVISOR_OPENAI_MODEL || "gpt-5.4",
      apiKey: gatewayKey,
      frontier: true,
    });
  }

  // ---- controlled-cell overrides -----------------------------------------
  const messages: string[] = args.messageFile
    ? (JSON.parse(readFileSync(args.messageFile, "utf8")) as string[])
    : PROBE_MESSAGES;
  if (!Array.isArray(messages) || messages.length === 0 || messages.some((m) => typeof m !== "string")) {
    console.error(`REFUSED: --message-file ${args.messageFile} is not a non-empty array of strings.`);
    process.exit(2);
  }
  const systemOverride = args.systemFile ? readFileSync(args.systemFile, "utf8") : null;
  const descOverrides: Record<string, string> = args.descFile
    ? (JSON.parse(readFileSync(args.descFile, "utf8")) as Record<string, string>)
    : {};

  let real = orderTools(await loadRealTools());
  // Throws on an unknown tool name — see applyDescriptionOverrides.
  real = applyDescriptionOverrides(real, descOverrides);
  const started = new Date();

  const header: string[] = [];
  const log = (s = "") => {
    header.push(s);
    console.log(s);
  };

  log(`# Tool-call ceiling probe`);
  log();
  log(`Run started: ${started.toISOString()}`);
  log(`Trials per cell: ${args.trials}${underpowered ? "   ** NON-CONCLUSIVE (below minimum " + MIN_TRIALS + ") **" : ""}`);
  log(`Tool counts: ${args.counts.join(", ")}`);
  log(`Naming variants: ${args.variants.join(", ")}`);
  log(`Endpoints: ${endpoints.map((e) => `${e.label}(${e.model})`).join(", ")}`);
  log(`Real tools available: ${real.length} (counts above this are padded with clones)`);
  log(`Probe messages: ${messages.length}, cycled across trials${args.messageFile ? ` (from ${args.messageFile})` : ""}`);
  if (args.cellLabel) log(`Cell label: **${args.cellLabel}**`);
  log(
    `System prompt: ${systemOverride ? `${args.systemFile} (${systemOverride.length} chars)` : "captured payload developer message (baseline)"}`,
  );
  log(
    `Tool descriptions: ${
      Object.keys(descOverrides).length > 0
        ? `${args.descFile} — overriding ${Object.keys(descOverrides).sort().join(", ")}`
        : "as served by the MCP servers (baseline)"
    }`,
  );
  log(
    `Payload base: /tmp/advisor-payload.json (captured wire body) — ` +
      `temperature=${captured.temperature} max_tokens=${captured.max_tokens} ` +
      `chat_template_kwargs=${JSON.stringify(captured.chat_template_kwargs)}`,
  );
  if (underpowered) {
    log();
    log(
      `> **NON-CONCLUSIVE RUN.** ${args.trials} trials per cell is below the ${MIN_TRIALS}-trial`,
    );
    log(`> minimum. Numbers below are a smoke test, not evidence. Do not cite them.`);
  }
  log();

  const results: CellResult[] = [];

  for (const ep of endpoints) {
    for (const variant of args.variants) {
      for (const count of args.counts) {
        const cellStart = Date.now();
        const before = await fetchEndpointState(ep);
        const { tools, cloned } = buildToolSurface(real, count, variant);

        const counts = emptyCounts();
        const perMessage = new Map<string, { n: number; toolCalls: number }>();
        const finishReasons: Record<string, number> = {};
        const httpStatuses: Record<string, number> = {};

        for (let i = 0; i < args.trials; i++) {
          const message = messages[i % messages.length]!;
          const body: Record<string, unknown> = JSON.parse(JSON.stringify(captured));
          body.tools = tools;
          body.stream = true;
          const wire = body.messages as Array<Record<string, unknown>>;
          if (systemOverride !== null) {
            const sysIdx = wire.findIndex(
              (m) => m.role === "system" || m.role === "developer",
            );
            if (sysIdx < 0) {
              console.error("REFUSED: --system-file given but captured payload has no system/developer message.");
              process.exit(2);
            }
            wire[sysIdx] = { ...wire[sysIdx], content: systemOverride };
          }
          wire[wire.length - 1] = { role: "user", content: message };
          if (ep.frontier) {
            delete body.chat_template_kwargs;
            delete body.temperature;
            delete body.max_tokens;
            body.model = ep.model;
          }

          const obs = await runTrial(ep, body);
          const cls = classifyTrial(obs);
          counts[cls]++;
          const fr = obs.finishReason ?? "(none)";
          finishReasons[fr] = (finishReasons[fr] ?? 0) + 1;
          const st = String(obs.status);
          httpStatuses[st] = (httpStatuses[st] ?? 0) + 1;
          const pm = perMessage.get(message) ?? { n: 0, toolCalls: 0 };
          pm.n++;
          if (cls === "tool_calls") pm.toolCalls++;
          perMessage.set(message, pm);
        }

        const after = await fetchEndpointState(ep);
        const validity = blockValidity(before, after);

        results.push({
          endpoint: ep.label,
          toolCount: count,
          variant,
          cloned,
          trials: args.trials,
          counts,
          perMessage,
          finishReasons,
          interval: wilsonInterval(counts.tool_calls, args.trials),
          valid: validity.valid,
          validity: validity.reason,
          httpStatuses,
          elapsedMs: Date.now() - cellStart,
        });

        const iv = wilsonInterval(counts.tool_calls, args.trials);
        console.error(
          `[${ep.label} ${variant} n_tools=${count}] ${validity.valid ? formatInterval(iv) : "INVALID"} ` +
            `(${Math.round((Date.now() - cellStart) / 1000)}s)`,
        );
      }
    }
  }

  // ---- Results table -------------------------------------------------------
  log(`## Results`);
  log();
  log(
    `Rate is the proportion of trials with structured \`tool_calls\`, with a 95% ` +
      `Wilson score interval.`,
  );
  log();
  log(
    `| endpoint | variant | tools | cloned | n | tool_calls | malformed | truncated | no_tool_call | http_error | unparseable | rate (95% CI) | block |`,
  );
  log(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|`);
  for (const r of results) {
    const c = r.counts;
    const rate = r.valid
      ? `${formatInterval(r.interval)}${underpowered ? " NON-CONCLUSIVE" : ""}`
      : "WITHHELD";
    log(
      `| ${r.endpoint} | ${r.variant} | ${r.toolCount} | ${r.cloned || "-"} | ${r.trials} | ` +
        `${c.tool_calls} | ${c.malformed} | ${c.truncated} | ${c.no_tool_call} | ` +
        `${c.http_error} | ${c.unparseable} | ${rate} | ${r.valid ? "valid" : "**INVALID**"} |`,
    );
  }
  log();

  const invalid = results.filter((r) => !r.valid);
  log(`## Block validity`);
  log();
  if (invalid.length === 0) {
    log(
      `All ${results.length} blocks valid. Endpoint state was read before and after ` +
        `each block; the target model was resident throughout and no other model was loading.`,
    );
  } else {
    log(
      `${invalid.length} of ${results.length} blocks INVALID. Their rates are withheld — ` +
        `a block whose endpoint moved underneath it is not a measurement.`,
    );
    log();
    for (const r of invalid) {
      log(`- \`${r.endpoint}/${r.variant}/${r.toolCount}\` — ${r.validity}`);
    }
  }
  log();

  log(`## Per-message breakdown`);
  log();
  log(
    `Cycled across ${messages.length} messages. A single message behaving unlike ` +
      `the others is itself an observation.`,
  );
  log();
  for (const r of results) {
    if (!r.valid) continue;
    const parts = [...r.perMessage.entries()].map(
      ([m, v]) => `${v.toolCalls}/${v.n} ${JSON.stringify(m.slice(0, 44))}`,
    );
    log(`- \`${r.endpoint}/${r.variant}/${r.toolCount}\`: ${parts.join("; ")}`);
  }
  log();

  log(`## finish_reason and HTTP status distribution`);
  log();
  for (const r of results) {
    const fr = Object.entries(r.finishReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const st = Object.entries(r.httpStatuses)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    log(`- \`${r.endpoint}/${r.variant}/${r.toolCount}\`: finish{${fr}} http{${st}}`);
  }
  log();

  const anyCloned = results.some((r) => r.cloned > 0);
  if (anyCloned) {
    log(`## Note on cloned tools`);
    log();
    log(
      `Rows with a non-empty \`cloned\` column exceeded the ${real.length} real tools ` +
        `available and were padded with byte-for-byte copies of one real tool, differing ` +
        `only in name. Cloned tools add count and schema bytes without adding semantic ` +
        `variety, so they may not be representative of a real tool surface of that size.`,
    );
    log();
  }

  log(
    `_This harness does not interpret its own output. No recommendation or diagnosis ` +
      `is offered here by design._`,
  );

  if (args.report) {
    writeFileSync(args.report, header.join("\n") + "\n");
    console.error(`report written to ${args.report}`);
  }
}

// Only run when executed directly, so the test file can import the pure
// functions without firing 300 HTTP requests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  await main();
}
