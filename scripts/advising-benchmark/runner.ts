// scripts/advising-benchmark/runner.ts
//
// Task 2 of docs/superpowers/specs/2026-07-23-advising-model-benchmark.md: the
// candidate-model RUNNER. Drives each FERPA-OK candidate model through the
// advisor's REAL, LIVE MCP tool surface on one scenario (from Task 1's
// scripts/advising-benchmark/scenarios.ts) and records a raw RunObservation
// per trial — answer, tool calls, malformed flag, per-completion latency,
// tokens, failure class.
//
// This module does NOT score against the deterministic anchor (Task 4) and
// does NOT call the judge (Task 3). Raw observations only.
//
// Reuse, not reinvention — see docs/superpowers/specs/2026-07-23-advising-model-benchmark.md
// "Hard-won discipline to inherit":
//   - MAX_TURNS, MIN_TRIALS, getFlag <- scripts/fabrication-probe.ts. The
//     agentic-loop SHAPE (model -> structured tool_calls -> live MCP -> model,
//     accumulate tokens/tool names, stop on a turn with zero tool calls) mirrors
//     fabrication-probe.ts's runAgenticTrial exactly.
//   - wilsonInterval/formatInterval/readModelsResponse/blockValidity/EndpointState
//     <- scripts/tool-ceiling-probe.ts, for the pre-trial endpoint-steadiness gate.
//   - detectMalformedToolCall (the malformed-generation detector) and
//     loadSystemPrompt (the real advisor persona, advisor/AGENTS.md) <-
//     src/advisor-agent.ts. Neither is re-implemented here.
//   - createAdvisorMcpBridge <- src/advisor-mcp.ts. This is the SAME function
//     the live advisor calls at startup, so the tool array this runner hands
//     the model is the advisor's REAL tool surface (bare tool names, per-server
//     bearer auth already wired via MCP_PUBLIC_AUTH_TOKEN/MCP_CATALOG_AUTH_TOKEN)
//     rather than a hand-rolled approximation of it.
//
//     Deliberately NOT reused: fabrication-probe.ts's own MCP_SERVERS /
//     routeToolName / callMcpTool. Two reasons. First, mcpToolToPiTool's doc
//     comment in advisor-mcp.ts records a measured finding: prefixed tool names
//     ("cu_public__...") degrade the Spark endpoint (0/3 vs 3/3 in a captured
//     replay), so the advisor exposes tools under BARE names — reproducing the
//     prefixed/routeToolName approach here would benchmark a tool surface the
//     advisor no longer presents. Second, fabrication-probe.ts's callMcpTool
//     sends no Authorization header at all, which predates the "8766/8767 now
//     require a bearer" change this branch already shipped — it would 401
//     against the currently-deployed servers. createAdvisorMcpBridge() already
//     gets both of these right because it IS the code path the advisor uses.
//
// Provider request shape mirrors src/advisor-agent.ts's runWithProvider for the
// qwen family: temperature ADVISOR_TEMPERATURE (0.6, the endpoint docs' own
// canonical value) and chat_template_kwargs.enable_thinking:true. tool_choice
// is NEVER set, for any candidate, on purpose: the advisor itself never sends
// tool_choice="required" either (reconcileToolChoiceWithThinking in
// advisor-agent.ts only fires to STRIP a value something else set — nothing in
// this codebase's advisor path is that "something else"), so the documented
// tool_choice+thinking 400 trap has no input here that could trigger it.
//
// gptoss-120b is NOT in the qwen family, and chat_template_kwargs.enable_thinking
// is a vLLM/Qwen chat-template extension (see providerModel("spark")'s comment
// in advisor-agent.ts) — there is no prior wire capture in this codebase for
// gpt-oss to confirm whether it tolerates or rejects that field. Rather than
// guess a shape that could 400 or silently misbehave, gptoss-120b gets the
// "plain" family (temperature only, no chat_template_kwargs). See the Task 2
// report's "concerns" section — this is exactly the kind of ambiguity the task
// brief said to flag rather than silently resolve.

import { writeFileSync } from "node:fs";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { StopReason, TextContent } from "@earendil-works/pi-ai";

import {
  ADVISOR_BASE_URL,
  ADVISOR_MAX_OUTPUT_TOKENS,
  ADVISOR_MODEL,
  ADVISOR_TEMPERATURE,
  CLEMSON_LLM_API_KEY,
  CLEMSON_LLM_BASE_URL,
  CLEMSON_LLM_OPENAI_BASE_URL,
} from "../../src/config.ts";
import {
  detectMalformedToolCall,
  loadSystemPrompt,
} from "../../src/advisor-agent.ts";
import { createAdvisorMcpBridge } from "../../src/advisor-mcp.ts";
import { getFlag, MAX_TURNS, MIN_TRIALS } from "../fabrication-probe.ts";
import {
  blockValidity,
  readModelsResponse,
  type EndpointState,
} from "../tool-ceiling-probe.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

// ---------------------------------------------------------------------------
// MODEL_PANEL — 3 local/RCD FERPA-OK candidates (usable on raw student PII) + 1
// frontier deployable only on DE-IDENTIFIED traffic (the toggle's OpenAI mode).
// Plain config array, easy to edit. See the spec's "Candidate panel" table.
// ---------------------------------------------------------------------------

/**
 * Which provider-request fields this candidate's wire shape needs.
 * "qwen-thinking" mirrors advisor-agent.ts's providerModel("spark") exactly
 * (temperature + chat_template_kwargs.enable_thinking). "plain" sends only
 * temperature — see the file header for why gptoss-120b is "plain" rather than
 * a guess at gpt-oss's own thinking-flag convention.
 *
 * "openai-reasoning" is for the Task 3 yardstick models (gpt-5.4 reference,
 * gpt-5.5 judge) called through CLEMSON_LLM_OPENAI_BASE_URL. This is NOT
 * a guess: advisor-agent.ts's runWithProvider already documents "the
 * Responses API rejects temperature for reasoning models — a 400", and
 * src/openai-classifier.ts's working gpt-5.4-mini call confirms the pattern
 * on chat/completions too — it sends no `temperature` at all and uses
 * `max_completion_tokens`, not `max_tokens`. Reusing "plain" (which injects
 * ADVISOR_TEMPERATURE) for these models would risk exactly that 400, so they
 * get their own family rather than silently reusing a shape built for a
 * different endpoint family.
 */
export type ModelFamily = "qwen-thinking" | "plain" | "openai-reasoning";

export interface ModelCandidate {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  family: ModelFamily;
}

export const MODEL_PANEL: ModelCandidate[] = [
  {
    label: "gptoss-120b",
    baseUrl: CLEMSON_LLM_BASE_URL,
    apiKey: CLEMSON_LLM_API_KEY,
    model: "gptoss-120b",
    family: "plain",
  },
  {
    // FRONTIER via the DE-IDENTIFIED path — the toggle's "OpenAI mode". No OpenAI
    // route is FERPA-cleared for identifiable PII, so this can't take raw student
    // data; but WITH de-identification it is a real deployment option, not merely a
    // yardstick — so it belongs in the panel as a genuine (privacy-gated) choice.
    //
    // gpt-5.5, NOT gpt-5.6: gpt-5.6-sol rejects function tools on /chat/completions
    // unless reasoning_effort:'none' (which turns its reasoning OFF — understates
    // the frontier) or /v1/responses (a different API our loop doesn't speak).
    // gpt-5.5 does tools+reasoning on /chat/completions today (verified). CAVEAT:
    // gpt-5.5 is also the judge, so its QUALITY score carries a mild self-preference
    // bias — pointwise+blinded blunts it, and reliability/latency are judge-
    // independent and clean. Judge stays gpt-5.5 so the frontier's scores are
    // comparable to the baseline's. Flag the caveat in the report (same class as
    // gptoss's same-family note).
    //
    // Replaces qwen-agentworld-35b-a3b, which was DROPPED: per its arXiv paper it
    // is a "language world model" that predicts environment observations, not an
    // agent policy that calls tools — wrong model class for an advisor candidate.
    label: "frontier-gpt-5.5",
    baseUrl: CLEMSON_LLM_OPENAI_BASE_URL,
    apiKey: CLEMSON_LLM_API_KEY,
    model: "gpt-5.5",
    family: "openai-reasoning",
  },
  {
    label: "qwen3.6-35b-a3b-fp8",
    baseUrl: CLEMSON_LLM_BASE_URL,
    apiKey: CLEMSON_LLM_API_KEY,
    model: "qwen3.6-35b-a3b-fp8",
    family: "qwen-thinking",
  },
  {
    // Incumbent. Same base URL / auth / model id the advisor service itself
    // resolves for the "spark" chain entry (providerModel("spark") in
    // advisor-agent.ts) — not re-derived or guessed here.
    label: "spark-qwen3.6-35b-a3b",
    baseUrl: ADVISOR_BASE_URL,
    apiKey: process.env.ADVISOR_API_KEY || "local",
    model: ADVISOR_MODEL,
    family: "qwen-thinking",
  },
];

// ---------------------------------------------------------------------------
// Pure classification / extraction — no network. Mirrors fabrication-probe.ts's
// own split between pure classifier logic and the network loop that feeds it.
// ---------------------------------------------------------------------------

export type FailureClass =
  | "ok"
  | "http_error"
  | "unparseable"
  | "malformed"
  | "no_tool_call";

export interface RunObservation {
  model: string;
  scenarioId: string;
  status: number;
  bodyParsed: boolean;
  toolCallCount: number;
  malformed: boolean;
  answer: string;
  /** One entry per model completion (provider round-trip) in the loop. */
  latencyMsPerCompletion: number[];
  promptTokens: number | null;
  completionTokens: number | null;
  failureClass: FailureClass;
}

/**
 * Shape one turn's request body per the candidate's family. tool_choice is
 * deliberately never touched — see the file header.
 *
 * "openai-reasoning" deliberately does NOT inject temperature (see the
 * ModelFamily doc comment) and passes the body through as-is; the
 * max_tokens/max_completion_tokens key swap for that family lives in the
 * caller (runScenarioTrial), since it is chosen when the body's token-limit
 * key is first set, before this function ever sees it.
 */
export function applyRequestShape(
  body: Record<string, unknown>,
  family: ModelFamily,
): Record<string, unknown> {
  if (family === "openai-reasoning") {
    return { ...body };
  }
  const shaped: Record<string, unknown> = {
    ...body,
    temperature: ADVISOR_TEMPERATURE,
  };
  if (family === "qwen-thinking") {
    shaped.chat_template_kwargs = { enable_thinking: true };
  }
  return shaped;
}

export interface WireTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/** AgentTool[] (advisor-mcp.ts's bridge shape) -> chat-completions `tools`. */
export function agentToolsToWireTools(
  tools: Array<{ name: string; description: string; parameters: unknown }>,
): WireTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export interface UsageTotals {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Pull prompt/completion tokens off one turn's `usage` block. */
export function extractUsage(
  usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined,
): UsageTotals {
  return {
    promptTokens:
      typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
    completionTokens:
      typeof usage?.completion_tokens === "number"
        ? usage.completion_tokens
        : null,
  };
}

/**
 * Fold one turn's usage into the trial-so-far total. Summed across every
 * provider request in the trial, matching fabrication-probe.ts's LoopResult:
 * the price/quality question is what ANSWERING costs, and a model that needs
 * four turns to get there costs four turns' tokens.
 */
export function accumulateUsage(
  acc: UsageTotals,
  turn: UsageTotals,
): UsageTotals {
  return {
    promptTokens:
      turn.promptTokens === null
        ? acc.promptTokens
        : (acc.promptTokens ?? 0) + turn.promptTokens,
    completionTokens:
      turn.completionTokens === null
        ? acc.completionTokens
        : (acc.completionTokens ?? 0) + turn.completionTokens,
  };
}

/**
 * Glue between this loop's raw `finish_reason` string and
 * detectMalformedToolCall's `StopReason` parameter. The detector's ONLY branch
 * on stopReason is `stopReason !== "stop"` (see its doc comment in
 * advisor-agent.ts: this is deliberately narrow, matched only to the endpoint
 * owners' own signature for the degradation) — so any raw finish_reason other
 * than the literal string "stop" is safe to fold into a single non-"stop"
 * placeholder here without changing the detector's behaviour.
 */
export function computeMalformed(
  answer: string,
  toolCallCount: number,
  toolNames: readonly string[],
  finishReason: string | null,
): boolean {
  const stopReason: StopReason = finishReason === "stop" ? "stop" : "length";
  return detectMalformedToolCall(answer, toolCallCount, toolNames, stopReason);
}

export interface ClassifyInput {
  status: number;
  bodyParsed: boolean;
  answer: string;
  toolCallCount: number;
  malformed: boolean;
}

/**
 * failureClass precedence (load-bearing, per the Task 2 brief):
 *   http_error -> unparseable -> malformed -> no_tool_call -> ok
 *
 * "unparseable" covers two distinct raw states as ONE class, both meaning
 * "there is no final message to judge": a response body that never parsed as
 * JSON (bodyParsed stays false), and a body that parsed on every turn but the
 * loop ran out of MAX_TURNS while still mid tool-call, so no final answer text
 * was ever produced (bodyParsed true, answer ""). Neither is "ok" and neither
 * is "no_tool_call" — there is no prose to have skipped a tool call.
 *
 * malformed is checked before no_tool_call so XML-in-content (the decoder
 * failure) is never filed as "answered from memory" (a different failure with
 * a different owner) — same distinction advisor-agent.ts's detector exists to
 * preserve.
 */
export function classifyFailureClass(input: ClassifyInput): FailureClass {
  if (input.status < 200 || input.status >= 300) return "http_error";
  if (!input.bodyParsed || input.answer.trim() === "") return "unparseable";
  if (input.malformed) return "malformed";
  if (input.toolCallCount === 0) return "no_tool_call";
  return "ok";
}

// ---------------------------------------------------------------------------
// Network — the live agentic loop. Cannot be unit-tested without network; kept
// as thin as possible so every decision above lives in a pure function.
// ---------------------------------------------------------------------------

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/v1\/?$/, "")}/v1/models`;
}

async function fetchEndpointState(
  candidate: ModelCandidate,
): Promise<EndpointState> {
  try {
    const res = await fetch(modelsUrl(candidate.baseUrl), {
      headers: candidate.apiKey
        ? { authorization: `Bearer ${candidate.apiKey}` }
        : {},
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
    return readModelsResponse(await res.json(), candidate.model);
  } catch (err) {
    return {
      target: null,
      othersLoading: [],
      stateless: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Route a tool call to the live AgentTool that actually executes it. Exported
 * so Task 3's reference-answer generator (scripts/advising-benchmark/judge.ts)
 * can build the same tool executor without duplicating this logic.
 */
export function buildToolExecutor(
  tools: AgentTool[],
): (name: string, args: unknown) => Promise<string> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async (name, args) => {
    const tool = byName.get(name);
    if (!tool) {
      return JSON.stringify({
        error: `unknown tool "${name}" — not in the live advisor tool surface`,
      });
    }
    const result = await tool.execute(
      `bench-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      args as Record<string, unknown>,
    );
    const text = result.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return text.slice(0, 24_000);
  };
}

/**
 * Run ONE scenario trial through the agentic loop for one candidate. Exported
 * — Task 3's reference-answer generator (judge.ts) reuses this EXACT function
 * to run gpt-5.4 through the same loop, per the spec's "the reference answer
 * is just gpt-5.4 run through the SAME agentic loop." No second loop
 * implementation exists anywhere in this benchmark.
 */
export async function runScenarioTrial(
  candidate: ModelCandidate,
  scenario: Scenario,
  systemPrompt: string,
  tools: WireTool[],
  execTool: (name: string, args: unknown) => Promise<string>,
): Promise<RunObservation> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: scenario.prompt },
  ];

  let status = 0;
  let bodyParsed = false;
  let toolCallCount = 0;
  let answer = "";
  let finishReason: string | null = null;
  const toolNames: string[] = [];
  let usage: UsageTotals = { promptTokens: null, completionTokens: null };
  const latencyMsPerCompletion: number[] = [];

  // OpenAI reasoning-family models (see the ModelFamily doc comment) reject
  // `max_tokens` on chat/completions in favor of `max_completion_tokens` —
  // the same distinction src/openai-classifier.ts's working gpt-5.4-mini call
  // already encodes. The key is chosen here, before applyRequestShape ever
  // sees the body, since applyRequestShape only touches temperature/
  // chat_template_kwargs, not the token-limit field's name.
  const tokenLimitKey =
    candidate.family === "openai-reasoning" ? "max_completion_tokens" : "max_tokens";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = applyRequestShape(
      {
        model: candidate.model,
        messages,
        tools,
        stream: false,
        [tokenLimitKey]: ADVISOR_MAX_OUTPUT_TOKENS,
      },
      candidate.family,
    );

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(
        `${candidate.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(candidate.apiKey
              ? { authorization: `Bearer ${candidate.apiKey}` }
              : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(240_000),
        },
      );
    } catch (err) {
      latencyMsPerCompletion.push(Date.now() - t0);
      status = 0;
      answer = err instanceof Error ? err.message : String(err);
      break;
    }
    latencyMsPerCompletion.push(Date.now() - t0);
    status = res.status;
    const raw = await res.text();
    if (!res.ok) {
      answer = raw.slice(0, 400);
      break;
    }

    let choice: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(raw) as {
        choices?: Array<Record<string, unknown>>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      usage = accumulateUsage(usage, extractUsage(parsed.usage));
      choice = parsed.choices?.[0];
    } catch {
      break; // bodyParsed stays false -> classifyFailureClass: unparseable
    }
    if (!choice) break;
    bodyParsed = true;
    finishReason =
      typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    const msg = (choice.message ?? {}) as Record<string, unknown>;
    const calls =
      (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];

    if (calls.length === 0) {
      answer = String(msg.content ?? "");
      break;
    }

    toolCallCount += calls.length;
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: calls,
    });
    for (const tc of calls) {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      const name = String(fn.name ?? "");
      toolNames.push(name);
      let args: unknown = {};
      try {
        args = JSON.parse(String(fn.arguments ?? "{}"));
      } catch {
        args = {};
      }
      let content: string;
      try {
        content = await execTool(name, args);
      } catch (err) {
        content = JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: content.slice(0, 24_000),
      });
    }
  }

  const malformed = bodyParsed
    ? computeMalformed(answer, toolCallCount, toolNames, finishReason)
    : false;
  const failureClass = classifyFailureClass({
    status,
    bodyParsed,
    answer,
    toolCallCount,
    malformed,
  });

  return {
    model: candidate.label,
    scenarioId: scenario.id,
    status,
    bodyParsed,
    toolCallCount,
    malformed,
    answer,
    latencyMsPerCompletion,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    failureClass,
  };
}

export interface ModelScenarioRun {
  model: string;
  scenarioId: string;
  trials: number;
  steady: boolean;
  steadinessReason: string;
  observations: RunObservation[];
}

/**
 * Run N trials for one (candidate, scenario) cell, gated by endpoint
 * steadiness per tool-ceiling-probe.ts's discipline: refuse BEFORE spending any
 * trial if the endpoint is not resident/reachable, and report (not silently
 * drop) if it moved mid-block. `observations` is returned either way — Task 2
 * emits raw observations, not a scored rate, so there is no "number" to
 * withhold; `steady`/`steadinessReason` tell the caller (and Task 4's scorer)
 * whether this cell's observations came from a block the endpoint held still
 * for.
 */
export async function runModel(
  candidate: ModelCandidate,
  scenario: Scenario,
  trials: number,
  systemPrompt: string,
  tools: WireTool[],
  execTool: (name: string, args: unknown) => Promise<string>,
): Promise<ModelScenarioRun> {
  const before = await fetchEndpointState(candidate);
  // blockValidity(before, before) reduces to exactly a single-state readiness
  // check (no error, target resident or the endpoint is stateless, nothing
  // else loading) without duplicating that logic in a second function.
  const preflight = blockValidity(before, before);
  if (!preflight.valid) {
    return {
      model: candidate.label,
      scenarioId: scenario.id,
      trials: 0,
      steady: false,
      steadinessReason: `refused before any trial: ${preflight.reason}`,
      observations: [],
    };
  }

  const observations: RunObservation[] = [];
  for (let i = 0; i < trials; i++) {
    const obs = await runScenarioTrial(
      candidate,
      scenario,
      systemPrompt,
      tools,
      execTool,
    );
    observations.push(obs);
    process.stderr.write(
      `[${candidate.label}/${scenario.id} ${i + 1}/${trials}] ${obs.failureClass} ` +
        `tools=${obs.toolCallCount} lat=[${obs.latencyMsPerCompletion.join(",")}]ms\n`,
    );
  }

  const after = await fetchEndpointState(candidate);
  const validity = blockValidity(before, after);
  return {
    model: candidate.label,
    scenarioId: scenario.id,
    trials,
    steady: validity.valid,
    steadinessReason: validity.reason,
    observations,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  model: string;
  scenario: string;
  trials: number;
  out?: string;
  allowUnderpowered: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const rawTrials = getFlag(argv, "--trials");
  const trials = rawTrials === undefined ? MIN_TRIALS : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(
      `REFUSED: --trials ${JSON.stringify(rawTrials ?? "(no value)")} is not a positive whole number.`,
    );
  }
  return {
    model: getFlag(argv, "--model") ?? "all",
    scenario: getFlag(argv, "--scenario") ?? "all",
    trials,
    out: getFlag(argv, "--out"),
    allowUnderpowered: argv.includes("--allow-underpowered"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.trials < MIN_TRIALS && !args.allowUnderpowered) {
    console.error(
      `REFUSED: --trials ${args.trials} is below the ${MIN_TRIALS}-trial minimum this project's ` +
        `probes require before a rate is treated as evidence. Re-run with --allow-underpowered for ` +
        `a smoke run — this runner emits raw observations only and does no scoring itself, but the ` +
        `caller (Task 4) needs to know the count was intentional, not an accident.`,
    );
    process.exit(2);
  }

  const candidates =
    args.model === "all"
      ? MODEL_PANEL
      : MODEL_PANEL.filter((c) => c.label === args.model);
  if (candidates.length === 0) {
    console.error(
      `REFUSED: --model ${args.model} matches no MODEL_PANEL entry. Known: ` +
        MODEL_PANEL.map((c) => c.label).join(", "),
    );
    process.exit(2);
  }
  const scenarios =
    args.scenario === "all"
      ? SCENARIOS
      : SCENARIOS.filter((s) => s.id === args.scenario);
  if (scenarios.length === 0) {
    console.error(
      `REFUSED: --scenario ${args.scenario} matches no scenario. Known: ` +
        SCENARIOS.map((s) => s.id).join(", "),
    );
    process.exit(2);
  }

  const systemPrompt = loadSystemPrompt();
  console.error("[runner] connecting to the live advisor MCP tool surface ...");
  const bridge = await createAdvisorMcpBridge();
  console.error(`[runner] tool surface ready: ${bridge.tools.length} tools`);
  const tools = agentToolsToWireTools(bridge.tools);
  const execTool = buildToolExecutor(bridge.tools);

  const runs: ModelScenarioRun[] = [];
  try {
    for (const candidate of candidates) {
      for (const scenario of scenarios) {
        const run = await runModel(
          candidate,
          scenario,
          args.trials,
          systemPrompt,
          tools,
          execTool,
        );
        runs.push(run);
        if (!run.steady) {
          console.error(
            `[runner] ${candidate.label}/${scenario.id}: UNSTEADY — ${run.steadinessReason}. ` +
              `Observations are still recorded but must not be read as a settled rate.`,
          );
        }
      }
    }
  } finally {
    await bridge.close();
  }

  const output = JSON.stringify(runs, null, 2);
  if (args.out) {
    writeFileSync(args.out, output);
    console.error(`[runner] wrote ${args.out}`);
  }
  console.log(output);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      `ADVISING-BENCHMARK RUNNER FAILED: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exit(1);
  });
}
