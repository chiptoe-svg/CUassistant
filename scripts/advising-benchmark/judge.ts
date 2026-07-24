// scripts/advising-benchmark/judge.ts
//
// Task 3 of docs/superpowers/specs/2026-07-23-advising-model-benchmark.md: the
// QUALITY layer. Two pieces:
//   1. A REFERENCE-ANSWER generator: gpt-5.4 run through Task 2's EXISTING
//      agentic loop (runScenarioTrial, imported from runner.ts — NOT
//      reimplemented here) to produce a "good answer" bar.
//   2. A POINTWISE, BLINDED LLM judge (gpt-5.5): scores ONE candidate
//      answer at a time, never sees which model produced it, and does NOT
//      re-check facts — Task 1's deterministic anchor already owns facts.
//      The judge scores reasoning/advising quality GIVEN the anchor facts as
//      ground truth.
//
// Both models are OpenAI, reached via CLEMSON_LLM_OPENAI_BASE_URL — allowed
// here because every scenario is a SYNTHETIC student over REAL courses (see
// the spec's "Yardstick" section): no FERPA-protected identifiable PII ever
// reaches this endpoint. This is the opposite rule from the CANDIDATE panel
// in runner.ts, which must stay on FERPA-cleared local/RCD endpoints because
// it is the deployment target, not eval tooling. See
// memory/clemson-data-openai-or-local-only.md.
//
// NOTE for Task 4 (owns the report): the judge is itself an OpenAI-family
// model. A `gptoss` candidate's scores carry a possible same-family bias
// (an OpenAI judge favoring OpenAI-architecture output) — flag it as a
// watch-item in the report, per the spec's "Yardstick" section. This file
// does not attempt to correct for it; blinding removes model-identity bias,
// not architecture-family bias.
//
// "Couldn't establish" discipline, same as scenarios.ts: a failed reference
// generation or an unparseable judge response is a REPORTED GAP
// (status: "unavailable" / "unscored"), never a silent empty string or a
// silent default score. Collapsing "couldn't tell" into "scored low" is
// exactly the conflation this project's instruments exist to avoid.

import { readFileSync } from "node:fs";

import {
  CLEMSON_LLM_API_KEY,
  CLEMSON_LLM_OPENAI_BASE_URL,
} from "../../src/config.ts";
import { loadSystemPrompt } from "../../src/advisor-agent.ts";
import { createAdvisorMcpBridge } from "../../src/advisor-mcp.ts";
import { getFlag } from "../fabrication-probe.ts";
import {
  agentToolsToWireTools,
  buildToolExecutor,
  runScenarioTrial,
  type ModelCandidate,
  type RunObservation,
  type WireTool,
} from "./runner.ts";
import {
  anchorS1,
  anchorS2,
  anchorS3,
  anchorS4,
  anchorS5,
  SCENARIOS,
  type Scenario,
} from "./scenarios.ts";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 1. Model config — ONE place, easy to edit (per the task brief).
// ---------------------------------------------------------------------------

/**
 * The reference model: gpt-5.4 run through the SAME agentic loop as every
 * candidate (runScenarioTrial). "openai-reasoning" family — see runner.ts's
 * ModelFamily doc comment for why this is NOT the same wire shape as the
 * qwen/gptoss candidates (no temperature, max_completion_tokens not
 * max_tokens).
 */
export const REFERENCE_MODEL: ModelCandidate = {
  label: "reference-gpt-5.4",
  baseUrl: CLEMSON_LLM_OPENAI_BASE_URL,
  apiKey: CLEMSON_LLM_API_KEY,
  model: "gpt-5.4",
  family: "openai-reasoning",
};

export interface JudgeModelConfig {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * The judge: a high-frontier model above the gpt-5.4 reference (spec's
 * "Yardstick" section). gpt-5.5-pro was the first choice but is 403'd at the
 * Clemson gateway ("OpenAI pricing is not configured" for -pro tiers — an
 * IT-side gap, not a bug), so the judge uses plain gpt-5.5: a tier above the
 * reference, unblocked, and verified to score cleanly. The gpt-5.6 variants
 * (luna/sol/terra) also return 200 if a newer judge is ever wanted.
 * Plain completion only — the judge is NEVER given tools (see judgeAnswer).
 */
export const JUDGE_MODEL: JudgeModelConfig = {
  label: "judge-gpt-5.5",
  baseUrl: CLEMSON_LLM_OPENAI_BASE_URL,
  apiKey: CLEMSON_LLM_API_KEY,
  model: "gpt-5.5",
};

/** Output budget for the judge's short JSON verdict. Not exported as a env
 *  override like ADVISOR_MAX_OUTPUT_TOKENS — the judge's response shape is
 *  fixed and small (a score + two short strings), so there is no per-endpoint
 *  reason to make this configurable yet. */
const JUDGE_MAX_OUTPUT_TOKENS = 700;

/** Generous per-completion budget: the judge is a frontier model this project
 *  has not load-tested, so allow the same headroom the candidate loop uses
 *  rather than risk a false timeout. */
const JUDGE_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// 2. Reference caller — reuses runScenarioTrial (Task 2's loop) as-is.
// ---------------------------------------------------------------------------

export interface ReferenceResult {
  scenarioId: string;
  status: "ok" | "unavailable";
  /** The reference answer text, or null when generation did not succeed. */
  answer: string | null;
  /** Why generation failed, or null when status is "ok". */
  reason: string | null;
  /** The raw Task-2 observation, kept for latency/token inspection even on
   *  failure — nothing about the trial is thrown away, only the "usable
   *  answer" verdict is gated. */
  observation: RunObservation;
}

/**
 * PURE: classify a completed reference trial as a usable reference bar or a
 * reported gap. Split out from generateReference so this "couldn't
 * establish" decision is unit-testable without network — mirrors
 * runner.ts's own split between classifyFailureClass (pure) and the network
 * loop that feeds it.
 *
 * Only failureClass "ok" counts as a usable reference. This is deliberately
 * stricter than the brief's http_error/malformed examples: every scenario's
 * ground truth is read LIVE (per scenarios.ts's header), so a reference that
 * never made a tool call ("no_tool_call") is not a trustworthy "good answer"
 * bar either — it answered without ever touching the facts it needed to get
 * right.
 */
export function summarizeReferenceObservation(
  obs: RunObservation,
): Pick<ReferenceResult, "status" | "answer" | "reason"> {
  if (obs.failureClass === "ok") {
    return { status: "ok", answer: obs.answer, reason: null };
  }
  return {
    status: "unavailable",
    answer: null,
    reason:
      `reference generation did not produce a usable answer: ` +
      `failureClass=${obs.failureClass} status=${obs.status} ` +
      `toolCalls=${obs.toolCallCount}`,
  };
}

/**
 * Generate ONE reference answer for ONE scenario: gpt-5.4 through the SAME
 * agentic loop every candidate runs (runScenarioTrial — imported, not
 * reimplemented). Opens and closes its own MCP bridge per call, matching the
 * brief's `generateReference(scenario) -> string` shape; a caller batching
 * many scenarios may prefer to inline this function's body to share one
 * bridge (Task 4's concern, not built here to avoid a second, unrequested
 * orchestration layer).
 */
export async function generateReference(
  scenario: Scenario,
): Promise<ReferenceResult> {
  const systemPrompt = loadSystemPrompt();
  const bridge = await createAdvisorMcpBridge();
  try {
    const tools = agentToolsToWireTools(bridge.tools);
    const execTool = buildToolExecutor(bridge.tools);
    const obs = await runScenarioTrial(
      REFERENCE_MODEL,
      scenario,
      systemPrompt,
      tools,
      execTool,
    );
    const summary = summarizeReferenceObservation(obs);
    return { scenarioId: scenario.id, observation: obs, ...summary };
  } finally {
    await bridge.close();
  }
}

// ---------------------------------------------------------------------------
// 3. Judge — POINTWISE (one answer at a time), BLINDED (no model identity).
//
// Blinding is structural, not just a prompt instruction: JudgeInput below has
// NO model/label field anywhere, so there is nothing for buildJudgePrompt to
// leak even by accident. The caller (Task 4) attaches the candidate's label
// to the returned JudgeVerdict AFTER judging, by scenarioId — the judge
// process itself never receives it.
// ---------------------------------------------------------------------------

/** Per-scenario behavioral criterion, derived from scenarios.ts's own
 *  documented outcome classes (see the spec's per-scenario "Outcomes:"
 *  lines and scenarios.ts's header comments) — not invented independently
 *  of Task 1. */
export function behavioralCriterion(scenarioId: Scenario["id"]): string {
  switch (scenarioId) {
    case "S1":
      return (
        "States the correct credit hours AND explicitly flags that the " +
        "section has 0 seats available (full) — does not invent or omit " +
        "seat availability."
      );
    case "S2":
      return (
        "Asks a clarifying question distinguishing the two sections that " +
        "share this time slot (regular vs Honors) rather than silently " +
        "picking one."
      );
    case "S3":
      return (
        "Correctly resolves each pasted CRN — including the screen-reader " +
        "cruft glued directly onto it — to its section, and correctly " +
        "states which of the three candidate courses fit without a " +
        "schedule conflict."
      );
    case "S4":
      return (
        "Surfaces the counterfactual: that switching her current GC 4061 " +
        "lab section to an alternate (MW) section would free up adding " +
        "the target course, rather than simply reporting a conflict and " +
        "stopping there."
      );
    case "S5":
      return (
        "Respects BOTH hard constraints (no meeting before 9:00 a.m., " +
        "nothing on Fridays) and offers requirement-eligible options, " +
        "without falsely claiming nothing fits when a valid option existed."
      );
    default: {
      const exhaustive: never = scenarioId;
      throw new Error(`no behavioral criterion defined for scenario ${String(exhaustive)}`);
    }
  }
}

const QUALITY_RUBRIC = [
  "Score the ANSWER's advising/reasoning quality on a 1-5 scale. Do NOT " +
    "re-check the facts yourself — the ground-truth facts given to you " +
    "below are already verified; judge only how well the answer reasons " +
    "from them, not whether they are correct.",
  "",
  "5 - Excellent: correct, meets the behavioral criterion below, and goes " +
    "beyond it — anticipates follow-up needs, offers well-justified " +
    "options, communicates clearly and concisely.",
  "4 - Good: correct, meets the behavioral criterion, clearly reasoned and " +
    "easy to act on.",
  "3 - Adequate: usable and consistent with the ground-truth facts, but " +
    "misses a nuance a good advisor would catch (an easy alternative, an " +
    "unnecessary hedge, a partially-met behavioral criterion).",
  "2 - Weak: technically consistent with the facts, but the advice is " +
    "confusing, incomplete, or largely misses the behavioral criterion.",
  "1 - Fails: contradicts or ignores the ground-truth facts in its " +
    "reasoning, gives actively unhelpful or incoherent advice, or clearly " +
    "fails the behavioral criterion.",
].join("\n");

export interface JudgeInput {
  scenario: Scenario;
  /** The answer being scored. NO model identity travels with this — the
   *  judge is pointwise and blinded by construction. */
  candidateAnswer: string;
  /** The reference bar, or null when generateReference reported unavailable. */
  referenceAnswer: string | null;
  /** Required when referenceAnswer is null — why there is no reference. */
  referenceUnavailableReason?: string | null;
  /** The deterministic anchor's resolved value for this scenario (Task 1's
   *  AnchorResolution.value, or an equivalent JSON-serializable summary).
   *  Given to the judge as GROUND TRUTH — it does not re-derive facts. */
  anchorFacts: unknown;
}

/**
 * PURE prompt assembly — no network. Returns system+user text. Tested
 * offline for exactly the four properties the task brief calls out: rubric +
 * behavioral criterion present, anchor facts present as ground truth,
 * reference framed as "one good example, not the only correct answer", and
 * NO model identity anywhere (the blinding assertion).
 */
export function buildJudgePrompt(input: JudgeInput): {
  system: string;
  user: string;
} {
  const criterion = behavioralCriterion(input.scenario.id);

  const system = [
    "You are grading the quality of ONE advising answer. You are scoring " +
      "exactly one answer in isolation — there is no second answer to " +
      "compare it against, and no ranking or ordering to produce.",
    "",
    QUALITY_RUBRIC,
    "",
    `This scenario's behavioral criterion (part of what "meets the rubric" ` +
      `means here): ${criterion}`,
    "",
    "Respond with JSON ONLY, exactly this shape and these keys: " +
      '{"qualityScore": <integer 1-5>, "behavioralOutcome": "<short ' +
      'description of what the answer actually did with respect to the ' +
      'behavioral criterion>", "rationale": "<1-3 sentences justifying the ' +
      'score>"}',
  ].join("\n");

  const referenceBlock = input.referenceAnswer
    ? [
        "REFERENCE ANSWER (one example of a good answer, NOT the only " +
          "correct answer — it may itself be imperfect; use it as a " +
          "yardstick, not an answer key):",
        input.referenceAnswer,
      ].join("\n")
    : [
        "REFERENCE ANSWER: none available " +
          `(${input.referenceUnavailableReason ?? "reference generation failed"}). ` +
          "Score the answer against the rubric and the ground-truth facts " +
          "alone.",
      ].join("\n");

  const user = [
    "SCENARIO PROMPT (what was asked):",
    input.scenario.prompt,
    "",
    "GROUND-TRUTH FACTS (already verified — do not re-derive or " +
      "second-guess these; take them as given and score only the " +
      "reasoning):",
    JSON.stringify(input.anchorFacts, null, 2),
    "",
    referenceBlock,
    "",
    "THE ANSWER TO EVALUATE:",
    input.candidateAnswer,
  ].join("\n");

  return { system, user };
}

export interface ScoredJudgeVerdict {
  scenarioId: string;
  status: "scored";
  qualityScore: number; // integer 1-5
  behavioralOutcome: string;
  rationale: string;
  judgeRaw: string;
  /** Present only when the judge's raw numeric score fell outside [1,5] or
   *  was non-integer and had to be rounded/clamped. Surfaced rather than
   *  silently rewritten — a clamp is a fact about the judge's output, not
   *  something to hide. */
  scoreClampedFrom?: number;
}

export interface UnscoredJudgeVerdict {
  scenarioId: string;
  status: "unscored";
  qualityScore: null;
  behavioralOutcome: null;
  rationale: null;
  judgeRaw: string;
  /** Why parsing/scoring failed. Never absent on an unscored verdict — this
   *  is the whole point of the "unscored" status existing as its own bucket
   *  (couldn't-establish != a real score). */
  unscoredReason: string;
}

export type JudgeVerdict = ScoredJudgeVerdict | UnscoredJudgeVerdict;

function unscoredVerdict(
  scenarioId: string,
  reason: string,
  judgeRaw: string,
): UnscoredJudgeVerdict {
  return {
    scenarioId,
    status: "unscored",
    qualityScore: null,
    behavioralOutcome: null,
    rationale: null,
    judgeRaw,
    unscoredReason: reason,
  };
}

/** Strip a ```json ... ``` (or bare ```...```) fence if the judge wrapped its
 *  JSON in markdown despite response_format:json_object — some endpoints do
 *  this anyway. Falls back to the trimmed raw text otherwise. */
function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced && fenced[1] !== undefined ? fenced[1].trim() : trimmed;
}

/**
 * PURE response parsing — no network. A malformed/unparseable judge response
 * (bad JSON, missing/non-numeric qualityScore, missing behavioralOutcome or
 * rationale) yields an "unscored" verdict, NEVER a silent default score.
 * An out-of-range or non-integer numeric score is rounded and clamped into
 * [1,5] (still a real score — a live model saying "6" is a minor rubric
 * slip, not a parse failure) with the raw value preserved on
 * scoreClampedFrom for transparency.
 */
export function parseJudgeResponse(
  scenarioId: string,
  raw: string,
): JudgeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonBlock(raw));
  } catch (err) {
    return unscoredVerdict(
      scenarioId,
      `judge response is not valid JSON: ${errMsg(err)}`,
      raw,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return unscoredVerdict(
      scenarioId,
      `judge response JSON is not an object (got ${JSON.stringify(parsed)})`,
      raw,
    );
  }
  const obj = parsed as Record<string, unknown>;

  const rawScore = obj.qualityScore;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
    return unscoredVerdict(
      scenarioId,
      `qualityScore missing or not a finite number (got ${JSON.stringify(rawScore)})`,
      raw,
    );
  }
  const clamped = Math.min(5, Math.max(1, Math.round(rawScore)));

  const behavioralOutcome = obj.behavioralOutcome;
  if (typeof behavioralOutcome !== "string" || behavioralOutcome.trim() === "") {
    return unscoredVerdict(
      scenarioId,
      `behavioralOutcome missing or not a non-empty string (got ${JSON.stringify(behavioralOutcome)})`,
      raw,
    );
  }

  const rationale = obj.rationale;
  if (typeof rationale !== "string" || rationale.trim() === "") {
    return unscoredVerdict(
      scenarioId,
      `rationale missing or not a non-empty string (got ${JSON.stringify(rationale)})`,
      raw,
    );
  }

  const verdict: ScoredJudgeVerdict = {
    scenarioId,
    status: "scored",
    qualityScore: clamped,
    behavioralOutcome,
    rationale,
    judgeRaw: raw,
  };
  if (clamped !== rawScore) {
    verdict.scoreClampedFrom = rawScore;
  }
  return verdict;
}

/**
 * The live judge call: gpt-5.5, PLAIN completion (no `tools` field at
 * all — the judge never gets tools, it only reasons over what it is given).
 * An HTTP failure or an unparseable body both come back as "unscored", never
 * a thrown exception a batch caller could mistake for a crash and never a
 * silent default score.
 */
export async function judgeAnswer(input: JudgeInput): Promise<JudgeVerdict> {
  const { system, user } = buildJudgePrompt(input);
  const scenarioId = input.scenario.id;

  let bodyText: string;
  try {
    const res = await fetch(
      `${JUDGE_MODEL.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(JUDGE_MODEL.apiKey
            ? { authorization: `Bearer ${JUDGE_MODEL.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: JUDGE_MODEL.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: JUDGE_MAX_OUTPUT_TOKENS,
          stream: false,
        }),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      },
    );
    bodyText = await res.text();
    if (!res.ok) {
      return unscoredVerdict(
        scenarioId,
        `judge HTTP ${res.status}: ${bodyText.slice(0, 300)}`,
        bodyText,
      );
    }
  } catch (err) {
    return unscoredVerdict(scenarioId, `judge request failed: ${errMsg(err)}`, "");
  }

  let parsedBody: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    parsedBody = JSON.parse(bodyText);
  } catch (err) {
    return unscoredVerdict(
      scenarioId,
      `judge response body did not parse as JSON: ${errMsg(err)}`,
      bodyText,
    );
  }
  const content = parsedBody.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    return unscoredVerdict(
      scenarioId,
      `judge response has no message content (choices=${JSON.stringify(parsedBody.choices)})`,
      bodyText,
    );
  }

  return parseJudgeResponse(scenarioId, content);
}

// ---------------------------------------------------------------------------
// 4. CLI — thin, manual-testing only. Batch orchestration is Task 4.
// ---------------------------------------------------------------------------

async function resolveAnchorFactsForCli(scenario: Scenario): Promise<unknown> {
  switch (scenario.id) {
    case "S1":
      return anchorS1();
    case "S2":
      return anchorS2();
    case "S3":
      return anchorS3();
    case "S4":
      return anchorS4();
    case "S5":
      return await anchorS5();
    default: {
      const exhaustive: never = scenario.id;
      throw new Error(`no anchor for scenario ${String(exhaustive)}`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const scenarioId = getFlag(argv, "--scenario");
  const answerFile = getFlag(argv, "--answer-file");
  const referenceFile = getFlag(argv, "--reference-file");

  if (!scenarioId || !answerFile) {
    console.error(
      "usage: judge.ts --scenario <S1..S5> --answer-file <path> " +
        "[--reference-file <path>]",
    );
    process.exit(2);
  }

  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(
      `REFUSED: --scenario ${scenarioId} matches no scenario. Known: ` +
        SCENARIOS.map((s) => s.id).join(", "),
    );
    process.exit(2);
  }

  const candidateAnswer = readFileSync(answerFile, "utf-8");
  const referenceAnswer = referenceFile
    ? readFileSync(referenceFile, "utf-8")
    : null;

  console.error(`[judge] resolving ${scenario.id}'s anchor facts ...`);
  const anchorFacts = await resolveAnchorFactsForCli(scenario);

  console.error(`[judge] calling ${JUDGE_MODEL.model} ...`);
  const verdict = await judgeAnswer({
    scenario,
    candidateAnswer,
    referenceAnswer,
    referenceUnavailableReason: referenceAnswer
      ? null
      : "no --reference-file given (manual CLI run)",
    anchorFacts,
  });

  console.log(JSON.stringify(verdict, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      `ADVISING-BENCHMARK JUDGE FAILED: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exit(1);
  });
}
