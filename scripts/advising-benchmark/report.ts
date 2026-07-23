// scripts/advising-benchmark/report.ts
//
// Task 4 of docs/superpowers/specs/2026-07-23-advising-model-benchmark.md: the
// ORCHESTRATOR + AGGREGATION + REPORT layer. Composes Tasks 1-3 — it does NOT
// change the runner's agentic loop, the judge's prompt/parsing, or the anchor
// queries. Everything here is either (a) pure aggregation math over the
// RunObservation[]/JudgeVerdict[] shapes those tasks already produce, or
// (b) orchestration glue that calls their exported functions unmodified.
//
// Approved scoring design (see the Task 4 brief — build to this, no brittle
// extractors added here):
//   - PRIMARY screen = pure deterministic reliability, straight off
//     RunObservation: failureClass distribution, malformed rate, tool-calling
//     success rate (both with per-scenario Wilson intervals — reused from
//     tool-ceiling-probe.ts, NEVER pooled across scenarios — see
//     aggregateReliability's own refusal below), latency p50/p95, token means.
//   - Quality/correctness = the judge (judge.ts's judgeAnswer), given the
//     scenario's deterministic anchor facts as ground truth. That grounding is
//     what stops a model "winning" the quality score by sounding right without
//     being right — no free-text extractors are built here for S2-S5.
//   - ONE deterministic calibration point, S1 only: fabrication-probe.ts's
//     extractCredits/extractSeatCap run on the S1 answer, compared against
//     anchorS1's resolved facts, reported ALONGSIDE (never instead of) the
//     judge's S1 score. See calibrateS1Trial's doc comment for why
//     extractSeatCap is expected to legitimately return "not_extracted" often
//     here — that is itself an honest reading of the instrument, not folded
//     into a "wrong" bucket.
//
// "Couldn't establish" (an unsteady endpoint, an unavailable anchor/reference,
// an unscored judge verdict, an unextracted S1 calibration fact) is ALWAYS a
// distinct value from a measured result, in both the data model below and the
// rendered report — never silently defaulted, never folded into a rate's
// denominator as if it were a negative observation.

import { writeFileSync } from "node:fs";

import { loadSystemPrompt } from "../../src/advisor-agent.ts";
import { createAdvisorMcpBridge } from "../../src/advisor-mcp.ts";
import {
  extractCredits,
  extractSeatCap,
  getFlag,
  MIN_TRIALS,
  normalizeNumber,
  type Extraction,
} from "../fabrication-probe.ts";
import { formatInterval, wilsonInterval, type Interval } from "../tool-ceiling-probe.ts";
import {
  behavioralCriterion,
  judgeAnswer,
  REFERENCE_MODEL,
  summarizeReferenceObservation,
  type JudgeVerdict,
  type ScoredJudgeVerdict,
  type UnscoredJudgeVerdict,
} from "./judge.ts";
import {
  agentToolsToWireTools,
  buildToolExecutor,
  MODEL_PANEL,
  runModel,
  runScenarioTrial,
  type FailureClass,
  type ModelCandidate,
  type RunObservation,
} from "./runner.ts";
import {
  anchorS1,
  anchorS2,
  anchorS3,
  anchorS4,
  anchorS5,
  SCENARIOS,
  type AnchorResolution,
  type S1Fact,
  type Scenario,
} from "./scenarios.ts";

// ---------------------------------------------------------------------------
// 1. Pure aggregation — reliability (the PRIMARY screen)
// ---------------------------------------------------------------------------

const FAILURE_CLASSES: FailureClass[] = [
  "ok",
  "http_error",
  "unparseable",
  "malformed",
  "no_tool_call",
];

/** Tally raw observations into the 5 failureClass buckets. Every bucket is
 *  present in the result even at 0 — a caller reading `counts.malformed`
 *  never has to guess whether a missing key means zero or "not tallied". */
export function tallyFailureClasses(
  observations: readonly RunObservation[],
): Record<FailureClass, number> {
  const counts = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0])) as Record<
    FailureClass,
    number
  >;
  for (const o of observations) counts[o.failureClass]++;
  return counts;
}

/**
 * Percentile over an ALREADY-SORTED-ASCENDING array, linear interpolation
 * (the R-7 / Excel PERCENTILE.INC method). p50 on an even-length array
 * averages the two middle values (the ordinary definition of a median); a
 * single-element array returns that element for every p. Throws on an empty
 * array rather than returning a fabricated 0 — there is no percentile of no
 * data.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) {
    throw new Error("REFUSED: percentile() called on an empty array — nothing to compute.");
  }
  const idx = (p / 100) * (sortedAscending.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedAscending[lower]!;
  const frac = idx - lower;
  return sortedAscending[lower]! + (sortedAscending[upper]! - sortedAscending[lower]!) * frac;
}

export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
}

/** p50/p95 over EVERY per-completion latency in the cell (all trials'
 *  latencyMsPerCompletion flattened) — a multi-turn trial contributes one
 *  sample per provider round-trip, matching how the runner already sums
 *  tokens across turns. null (not 0) when there is no latency data at all. */
export function latencyPercentiles(observations: readonly RunObservation[]): LatencyPercentiles {
  const all = observations
    .flatMap((o) => o.latencyMsPerCompletion)
    .slice()
    .sort((a, b) => a - b);
  if (all.length === 0) return { p50: null, p95: null };
  return { p50: percentile(all, 50), p95: percentile(all, 95) };
}

/** Mean over the non-null values only; null (not 0) when none are present. */
export function meanOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export interface ReliabilityAggregate {
  model: string;
  scenarioId: string;
  n: number;
  failureClassCounts: Record<FailureClass, number>;
  /** Wilson interval on `malformed === true` proportion of n. */
  malformedRate: Interval;
  /** Wilson interval on `toolCallCount > 0` proportion of n — did the model
   *  attempt tool use at all, independent of whether the generation was
   *  otherwise malformed. */
  toolCallingSuccessRate: Interval;
  latency: LatencyPercentiles;
  meanPromptTokens: number | null;
  meanCompletionTokens: number | null;
}

/**
 * THE POOLING GUARD. Refuses (throws) if given observations spanning more
 * than one (model, scenario) cell — the spec's "per-scenario Wilson
 * intervals, NEVER pooled" is enforced here structurally, not just by
 * caller discipline: there is no code path in this module that can produce
 * an aggregate mixing scenarios or models, because the one function that
 * builds a ReliabilityAggregate refuses to run on mixed input.
 */
export function aggregateReliability(
  observations: readonly RunObservation[],
): ReliabilityAggregate {
  if (observations.length === 0) {
    throw new Error("REFUSED: aggregateReliability() called with zero observations.");
  }
  const scenarioIds = new Set(observations.map((o) => o.scenarioId));
  const models = new Set(observations.map((o) => o.model));
  if (scenarioIds.size > 1 || models.size > 1) {
    throw new Error(
      "REFUSED: aggregateReliability() received observations spanning multiple " +
        `(model, scenario) cells — models={${[...models].join(",")}} ` +
        `scenarios={${[...scenarioIds].join(",")}}. Every rate in this benchmark is ` +
        "per (model, scenario); pooling across scenarios is refused, not silently allowed.",
    );
  }

  const n = observations.length;
  const malformedCount = observations.filter((o) => o.malformed).length;
  const toolCallCount = observations.filter((o) => o.toolCallCount > 0).length;

  return {
    model: observations[0]!.model,
    scenarioId: observations[0]!.scenarioId,
    n,
    failureClassCounts: tallyFailureClasses(observations),
    malformedRate: wilsonInterval(malformedCount, n),
    toolCallingSuccessRate: wilsonInterval(toolCallCount, n),
    latency: latencyPercentiles(observations),
    meanPromptTokens: meanOf(observations.map((o) => o.promptTokens)),
    meanCompletionTokens: meanOf(observations.map((o) => o.completionTokens)),
  };
}

// ---------------------------------------------------------------------------
// 2. Pure aggregation — judge quality (SCORED only; unscored counted
//    separately, never folded into the mean or treated as a 0)
// ---------------------------------------------------------------------------

export interface JudgeAggregate {
  scoredCount: number;
  unscoredCount: number;
  /** null (not 0) when scoredCount === 0 — an all-unscored run yields no
   *  mean, because there is nothing to average. */
  meanQualityScore: number | null;
  scores: number[];
  unscoredReasons: string[];
}

export function aggregateJudgeVerdicts(verdicts: readonly JudgeVerdict[]): JudgeAggregate {
  const scored: ScoredJudgeVerdict[] = [];
  const unscored: UnscoredJudgeVerdict[] = [];
  for (const v of verdicts) {
    if (v.status === "scored") scored.push(v);
    else unscored.push(v);
  }
  const scores = scored.map((v) => v.qualityScore);
  return {
    scoredCount: scored.length,
    unscoredCount: unscored.length,
    meanQualityScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    scores,
    unscoredReasons: unscored.map((v) => v.unscoredReason),
  };
}

// ---------------------------------------------------------------------------
// 3. S1 deterministic calibration — the ONE reused-extractor check
//
// extractSeatCap's cue vocabulary (fabrication-probe.ts) is bound to
// ENROLLMENT-LIMIT language ("max enrollment", "seat cap", "capped at") and
// explicitly EXCLUDES seats-remaining phrasing (its own SEATS_REMAINING guard
// filters "N seats available/left/open" out of the bare-number fallback).
// S1's anchor fact is `seatsAvailable` — seats REMAINING, the thing the
// scenario's own question ("can she still get a seat?") is actually about —
// so a candidate answering the question naturally ("there are 0 seats left")
// is expected to often come back "not_extracted" here, NOT "mismatch". That
// is the correct, honest reading of a real extractor pointed at an adjacent
// but different fact, not a bug in this wiring — see the Task 4 report's
// concerns section. It is reused as-is per the brief rather than forked into
// a second, purpose-built extractor.
// ---------------------------------------------------------------------------

export type CalibrationMatch = "match" | "mismatch" | "not_extracted";

export interface S1TrialCalibration {
  creditsExtraction: Extraction;
  creditsMatch: CalibrationMatch;
  seatExtraction: Extraction;
  seatMatch: CalibrationMatch;
}

function matchAgainst(extraction: Extraction, truth: string): CalibrationMatch {
  if (extraction.kind !== "found") return "not_extracted";
  return extraction.value === normalizeNumber(truth) ? "match" : "mismatch";
}

/** PURE: run the two reused extractors on one S1 answer and compare each to
 *  anchorS1's resolved facts. No network, no scoring logic beyond string
 *  equality on normalized numbers. */
export function calibrateS1Trial(answer: string, anchor: S1Fact): S1TrialCalibration {
  const creditsExtraction = extractCredits(answer);
  const seatExtraction = extractSeatCap(answer);
  return {
    creditsExtraction,
    creditsMatch: matchAgainst(creditsExtraction, String(anchor.creditHours)),
    seatExtraction,
    seatMatch: matchAgainst(seatExtraction, String(anchor.seatsAvailable)),
  };
}

export interface CalibrationFactAggregate {
  matchCount: number;
  mismatchCount: number;
  notExtractedCount: number;
  /** Wilson interval on match/(match+mismatch) — the extracted subset only.
   *  null when nothing was ever extracted (denominator 0): "couldn't
   *  establish" for every trial is not the same as a measured 0% match. */
  matchRate: Interval | null;
}

export interface S1CalibrationAggregate {
  n: number;
  credits: CalibrationFactAggregate;
  seats: CalibrationFactAggregate;
}

function aggregateCalibrationFact(
  matches: readonly CalibrationMatch[],
): CalibrationFactAggregate {
  const matchCount = matches.filter((m) => m === "match").length;
  const mismatchCount = matches.filter((m) => m === "mismatch").length;
  const notExtractedCount = matches.filter((m) => m === "not_extracted").length;
  const extractedN = matchCount + mismatchCount;
  return {
    matchCount,
    mismatchCount,
    notExtractedCount,
    matchRate: extractedN > 0 ? wilsonInterval(matchCount, extractedN) : null,
  };
}

export function aggregateS1Calibration(
  trials: readonly S1TrialCalibration[],
): S1CalibrationAggregate {
  return {
    n: trials.length,
    credits: aggregateCalibrationFact(trials.map((t) => t.creditsMatch)),
    seats: aggregateCalibrationFact(trials.map((t) => t.seatMatch)),
  };
}

/** Distinguishes "this scenario cell has no calibration because it isn't S1"
 *  from "it IS S1 but numbers are withheld" from "computed" — the same
 *  three-way discipline as everything else in this file. */
export type S1CalibrationStatus =
  | { status: "computed"; aggregate: S1CalibrationAggregate }
  | { status: "not_applicable" }
  | { status: "unavailable"; reason: string };

// ---------------------------------------------------------------------------
// 4. Orchestrator
// ---------------------------------------------------------------------------

export interface AnchorSummary {
  scenarioId: Scenario["id"];
  status: "resolved" | "unavailable";
  value: unknown;
  reason: string | null;
  fetchedAt: string | null;
}

export interface ReferenceSummary {
  scenarioId: string;
  status: "ok" | "unavailable";
  answer: string | null;
  reason: string | null;
}

export interface ModelScenarioCell {
  model: string;
  scenarioId: Scenario["id"];
  requestedTrials: number;
  steady: boolean;
  steadinessReason: string;
  observations: RunObservation[];
  /** null when the endpoint was unsteady (or zero trials ran) — the cell's
   *  numbers are WITHHELD, per the brief, not reported as a degraded rate. */
  reliability: ReliabilityAggregate | null;
  judgeVerdicts: JudgeVerdict[];
  judgeAggregate: JudgeAggregate | null;
  s1Calibration: S1CalibrationStatus;
}

export interface BenchmarkResult {
  startedAt: string;
  trials: number;
  toolSurfaceSize: number;
  models: string[];
  scenarioIds: string[];
  anchors: AnchorSummary[];
  references: ReferenceSummary[];
  cells: ModelScenarioCell[];
}

async function resolveAnchorForScenario(scenario: Scenario): Promise<AnchorResolution<unknown>> {
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

async function resolveAnchorSummary(scenario: Scenario): Promise<AnchorSummary> {
  const res = await resolveAnchorForScenario(scenario);
  if (res.status === "resolved") {
    return {
      scenarioId: scenario.id,
      status: "resolved",
      value: res.value,
      reason: null,
      fetchedAt: res.fetchedAt,
    };
  }
  return {
    scenarioId: scenario.id,
    status: "unavailable",
    value: null,
    reason: res.reason,
    fetchedAt: res.fetchedAt,
  };
}

export interface RunBenchmarkOptions {
  models: ModelCandidate[];
  scenarios: Scenario[];
  trials: number;
}

/**
 * Orchestrate the full model x scenario x trial matrix: resolve each
 * scenario's anchor once, generate its reference once, then for every
 * (model, scenario) cell run `trials` trials (gated by runModel's existing
 * endpoint-steadiness check), judge every trial's answer against the
 * anchor's facts, and — for S1 — also run the deterministic calibration
 * check. Opens exactly ONE MCP bridge for the whole run (per the brief:
 * generateReference/judge.ts's own note says a batch caller should inline
 * its body to share a bridge rather than pay per-call connect/list-tools
 * overhead once per scenario) — the loop below IS that inlining, not a
 * second implementation of generateReference's logic (still
 * summarizeReferenceObservation + runScenarioTrial, imported unchanged).
 *
 * An unsteady cell's reliability numbers AND judge scores are withheld
 * entirely (reliability: null, judgeAggregate: null, judge calls skipped) —
 * raw observations are still kept, per runModel's own contract, but nothing
 * downstream treats them as a settled measurement.
 */
export async function runBenchmark(opts: RunBenchmarkOptions): Promise<BenchmarkResult> {
  const startedAt = new Date().toISOString();
  const systemPrompt = loadSystemPrompt();

  process.stderr.write("[report] connecting to the live advisor MCP tool surface ...\n");
  const bridge = await createAdvisorMcpBridge();
  process.stderr.write(`[report] tool surface ready: ${bridge.tools.length} tools\n`);
  const tools = agentToolsToWireTools(bridge.tools);
  const execTool = buildToolExecutor(bridge.tools);

  const anchors: AnchorSummary[] = [];
  const references: ReferenceSummary[] = [];
  const cells: ModelScenarioCell[] = [];

  try {
    for (const scenario of opts.scenarios) {
      process.stderr.write(`[report] resolving ${scenario.id}'s anchor ...\n`);
      const anchor = await resolveAnchorSummary(scenario);
      anchors.push(anchor);
      if (anchor.status === "unavailable") {
        process.stderr.write(`[report] ${scenario.id}: anchor UNAVAILABLE — ${anchor.reason}\n`);
      }

      process.stderr.write(`[report] generating ${scenario.id}'s reference answer ...\n`);
      const refObs = await runScenarioTrial(REFERENCE_MODEL, scenario, systemPrompt, tools, execTool);
      const refSummary = summarizeReferenceObservation(refObs);
      references.push({ scenarioId: scenario.id, ...refSummary });
      if (refSummary.status === "unavailable") {
        process.stderr.write(`[report] ${scenario.id}: reference UNAVAILABLE — ${refSummary.reason}\n`);
      }

      const anchorFacts: unknown =
        anchor.status === "resolved"
          ? anchor.value
          : { status: "unavailable" as const, reason: anchor.reason };

      for (const candidate of opts.models) {
        process.stderr.write(
          `[report] ${candidate.label}/${scenario.id}: running ${opts.trials} trial(s) ...\n`,
        );
        const run = await runModel(candidate, scenario, opts.trials, systemPrompt, tools, execTool);
        process.stderr.write(
          `[report] ${candidate.label}/${scenario.id}: ${run.steady ? "steady" : `UNSTEADY (${run.steadinessReason})`}, ` +
            `${run.observations.length} observation(s)\n`,
        );

        let reliability: ReliabilityAggregate | null = null;
        let judgeVerdicts: JudgeVerdict[] = [];
        let judgeAggregate: JudgeAggregate | null = null;
        let s1Calibration: S1CalibrationStatus =
          scenario.id === "S1" ? { status: "unavailable", reason: "" } : { status: "not_applicable" };

        if (run.steady && run.observations.length > 0) {
          reliability = aggregateReliability(run.observations);

          for (const obs of run.observations) {
            const verdict = await judgeAnswer({
              scenario,
              candidateAnswer: obs.answer,
              referenceAnswer: refSummary.answer,
              referenceUnavailableReason: refSummary.reason,
              anchorFacts,
            });
            judgeVerdicts.push(verdict);
          }
          judgeAggregate = aggregateJudgeVerdicts(judgeVerdicts);

          if (scenario.id === "S1") {
            if (anchor.status === "resolved") {
              const trials = run.observations.map((o) =>
                calibrateS1Trial(o.answer, anchor.value as S1Fact),
              );
              s1Calibration = { status: "computed", aggregate: aggregateS1Calibration(trials) };
            } else {
              s1Calibration = {
                status: "unavailable",
                reason: `S1 anchor unavailable: ${anchor.reason}`,
              };
            }
          }
        } else if (scenario.id === "S1") {
          s1Calibration = {
            status: "unavailable",
            reason: !run.steady
              ? `endpoint unsteady: ${run.steadinessReason}`
              : "no observations were run",
          };
        }

        cells.push({
          model: candidate.label,
          scenarioId: scenario.id,
          requestedTrials: opts.trials,
          steady: run.steady,
          steadinessReason: run.steadinessReason,
          observations: run.observations,
          reliability,
          judgeVerdicts,
          judgeAggregate,
          s1Calibration,
        });
      }
    }
  } finally {
    await bridge.close();
  }

  return {
    startedAt,
    trials: opts.trials,
    toolSurfaceSize: bridge.tools.length,
    models: opts.models.map((m) => m.label),
    scenarioIds: opts.scenarios.map((s) => s.id),
    anchors,
    references,
    cells,
  };
}

// ---------------------------------------------------------------------------
// 5. Report rendering — pure, no network. Takes a BenchmarkResult and
//    produces markdown text.
// ---------------------------------------------------------------------------

function fmtLatency(l: LatencyPercentiles): string {
  if (l.p50 === null || l.p95 === null) return "n/a";
  return `${Math.round(l.p50)} / ${Math.round(l.p95)} ms`;
}

function fmtTokens(v: number | null): string {
  return v === null ? "n/a" : Math.round(v).toString();
}

function fmtJudge(agg: JudgeAggregate | null): string {
  if (agg === null) return "WITHHELD";
  const mean = agg.meanQualityScore === null ? "n/a" : agg.meanQualityScore.toFixed(2);
  return `${mean} (scored ${agg.scoredCount}, unscored ${agg.unscoredCount})`;
}

function fmtCalibrationFact(f: CalibrationFactAggregate): string {
  const rate = f.matchRate === null ? "n/a" : formatInterval(f.matchRate);
  return `${f.matchCount}/${f.matchCount + f.mismatchCount} ${rate} (not-extracted: ${f.notExtractedCount})`;
}

function fmtAnchorValue(a: AnchorSummary): string {
  if (a.status === "unavailable") return `UNAVAILABLE — ${a.reason}`;
  return "```json\n" + JSON.stringify(a.value, null, 2) + "\n```";
}

export function renderReport(result: BenchmarkResult): string {
  const lines: string[] = [];
  const log = (s = "") => lines.push(s);

  log(`# Advising-model benchmark — report`);
  log();
  log(`Run started: ${result.startedAt}`);
  log(`Trials per (model, scenario) cell: ${result.trials}` + (result.trials < MIN_TRIALS
    ? `   ** BELOW the ${MIN_TRIALS}-trial minimum — validation run, not evidence **`
    : ""));
  log(`Models: ${result.models.join(", ")}`);
  log(`Scenarios: ${result.scenarioIds.join(", ")}`);
  log(`Tool surface loaded for this run: ${result.toolSurfaceSize} tools (bare names, real advisor bridge)`);
  log();
  log(
    `> **What this does and does not establish.** This is a screen to shortlist ` +
      `1-2 deployable models for deeper testing, not a final verdict. Complex ` +
      `multi-step advising questions are expensive to run, so per-scenario n is ` +
      `modest here and the resulting intervals are wide. Every rate below is ` +
      `per (model, scenario) — this report never prints, and this codebase's ` +
      `aggregator refuses to compute, a rate pooled across scenarios.`,
  );
  log();

  for (const scenarioId of result.scenarioIds) {
    const scenario = SCENARIOS.find((s) => s.id === scenarioId);
    const anchor = result.anchors.find((a) => a.scenarioId === scenarioId);
    const reference = result.references.find((r) => r.scenarioId === scenarioId);
    const scenarioCells = result.cells.filter((c) => c.scenarioId === scenarioId);

    log(`## ${scenarioId}`);
    log();
    if (scenario) {
      log(`Prompt: ${scenario.prompt.split("\n")[0]}${scenario.prompt.includes("\n") ? " [...]" : ""}`);
      log();
      log(`Behavioral criterion (judge): ${behavioralCriterion(scenario.id)}`);
      log();
    }
    log(`**Anchor:** ${anchor ? fmtAnchorValue(anchor) : "n/a"}`);
    log();
    log(
      `**Reference (gpt-5.4, one example of a good answer):** ${
        reference?.status === "ok"
          ? "ok"
          : `UNAVAILABLE — ${reference?.reason ?? "not generated"}`
      }`,
    );
    log();

    log(
      `| model | n | ok | malformed | no_tool_call | http_error | unparseable | ` +
        `malformed rate (95% CI) | tool-call success (95% CI) | latency p50/p95 | ` +
        `judge mean (scored/unscored) | steady |`,
    );
    log(`|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|`);
    for (const cell of scenarioCells) {
      const r = cell.reliability;
      const c = r?.failureClassCounts;
      log(
        `| ${cell.model} | ${cell.observations.length} | ${c?.ok ?? "-"} | ${c?.malformed ?? "-"} | ` +
          `${c?.no_tool_call ?? "-"} | ${c?.http_error ?? "-"} | ${c?.unparseable ?? "-"} | ` +
          `${r ? formatInterval(r.malformedRate) : "WITHHELD"} | ` +
          `${r ? formatInterval(r.toolCallingSuccessRate) : "WITHHELD"} | ` +
          `${r ? fmtLatency(r.latency) : "WITHHELD"} | ${fmtJudge(cell.judgeAggregate)} | ` +
          `${cell.steady ? "yes" : `**NO** — ${cell.steadinessReason}`} |`,
      );
    }
    log();

    log(`Token means (prompt / completion), per model:`);
    for (const cell of scenarioCells) {
      const r = cell.reliability;
      log(
        `- ${cell.model}: ${r ? `${fmtTokens(r.meanPromptTokens)} / ${fmtTokens(r.meanCompletionTokens)}` : "WITHHELD"}`,
      );
    }
    log();

    if (scenarioId === "S1") {
      log(`### S1 deterministic calibration (fabrication-probe extractors vs anchor)`);
      log();
      log(
        `Reuses \`extractCredits\`/\`extractSeatCap\` on each answer, compared to the ` +
          `live anchor. \`extractSeatCap\` targets ENROLLMENT-CAP language, not ` +
          `seats-REMAINING language (this scenario's anchor fact) — a high ` +
          `not-extracted count for seats is expected and is not itself evidence ` +
          `of anything about the model; see the report's concerns section.`,
      );
      log();
      log(`| model | credits match (95% CI over extracted) | seats match (95% CI over extracted) |`);
      log(`|---|---|---|`);
      for (const cell of scenarioCells) {
        const cal = cell.s1Calibration;
        const row =
          cal.status === "computed"
            ? `${fmtCalibrationFact(cal.aggregate.credits)} | ${fmtCalibrationFact(cal.aggregate.seats)}`
            : cal.status === "unavailable"
              ? `UNAVAILABLE (${cal.reason}) | UNAVAILABLE (${cal.reason})`
              : "n/a | n/a";
        log(`| ${cell.model} | ${row} |`);
      }
      log();
    }
  }

  // ---- Watch-items / honesty section ---------------------------------------
  log(`## Watch items and honesty notes`);
  log();

  if (result.models.includes("gptoss-120b")) {
    log(
      `- **Same-family judge bias risk:** the judge (\`judge-gpt-5.5\`) and the ` +
        `reference (\`reference-gpt-5.4\`) are both OpenAI-architecture models. ` +
        `\`gptoss-120b\`'s judge scores carry a possible same-family bias (an ` +
        `OpenAI-family judge favoring OpenAI-architecture output) that blinding ` +
        `the candidate's identity does NOT correct for — blinding removes ` +
        `model-identity bias, not architecture-family bias. Read \`gptoss-120b\`'s ` +
        `quality scores with that in mind, not as directly comparable to the qwen ` +
        `family's scores.`,
    );
  }

  const unsteady = result.cells.filter((c) => !c.steady);
  log(
    unsteady.length === 0
      ? `- No UNSTEADY endpoint cells in this run.`
      : `- **${unsteady.length} UNSTEADY endpoint cell(s) — numbers withheld:**`,
  );
  for (const c of unsteady) {
    log(`  - \`${c.model}/${c.scenarioId}\`: ${c.steadinessReason}`);
  }

  const unavailableAnchors = result.anchors.filter((a) => a.status === "unavailable");
  log(
    unavailableAnchors.length === 0
      ? `- No UNAVAILABLE anchors in this run.`
      : `- **${unavailableAnchors.length} UNAVAILABLE anchor(s):**`,
  );
  for (const a of unavailableAnchors) {
    log(`  - \`${a.scenarioId}\`: ${a.reason}`);
  }

  const unavailableRefs = result.references.filter((r) => r.status === "unavailable");
  log(
    unavailableRefs.length === 0
      ? `- No UNAVAILABLE references in this run.`
      : `- **${unavailableRefs.length} UNAVAILABLE reference(s)** (judging proceeded with referenceAnswer=null):`,
  );
  for (const r of unavailableRefs) {
    log(`  - \`${r.scenarioId}\`: ${r.reason}`);
  }

  const cellsWithUnscored = result.cells.filter((c) => (c.judgeAggregate?.unscoredCount ?? 0) > 0);
  log(
    cellsWithUnscored.length === 0
      ? `- No unscored judge verdicts in this run.`
      : `- **Unscored judge verdicts (couldn't-establish, NOT a low score):**`,
  );
  for (const c of cellsWithUnscored) {
    const agg = c.judgeAggregate!;
    log(
      `  - \`${c.model}/${c.scenarioId}\`: ${agg.unscoredCount} unscored of ${c.observations.length} ` +
        `— e.g. "${agg.unscoredReasons[0]}"`,
    );
  }

  log(
    `- n per cell and CI width: every rate above is Wilson-scored on the n shown in ` +
      `that row's \`n\` column, per (model, scenario) — never pooled across ` +
      `scenarios or across models. At modest n (especially any run below ` +
      `${MIN_TRIALS} trials/cell) intervals are WIDE; read the interval, not just ` +
      `the point estimate.`,
  );
  log(
    `- S5's per-suggestion classifier (\`classifySuggestion\`, Task 1) is NOT used ` +
      `here as a free-text extractor over candidate answers — per the approved ` +
      `design, S5's primary signal is the judge scored against the anchor's ` +
      `\`validSet\`/\`explicitEligible\` ground truth, to avoid building a brittle ` +
      `parser over open-ended model prose.`,
  );

  log();
  log(`_This report does not recommend a model. It screens; the operator decides._`);

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

export interface ReportCliArgs {
  models: ModelCandidate[];
  scenarios: Scenario[];
  trials: number;
  out?: string;
}

export function parseReportArgs(argv: string[]): ReportCliArgs {
  const modelsFlag = getFlag(argv, "--models") ?? "all";
  const scenariosFlag = getFlag(argv, "--scenarios") ?? "all";
  const rawTrials = getFlag(argv, "--trials");
  const trials = rawTrials === undefined ? MIN_TRIALS : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(
      `REFUSED: --trials ${JSON.stringify(rawTrials ?? "(no value)")} is not a positive whole number.`,
    );
  }

  const models =
    modelsFlag === "all"
      ? MODEL_PANEL
      : modelsFlag.split(",").map((raw) => {
          const label = raw.trim();
          const c = MODEL_PANEL.find((m) => m.label === label);
          if (!c) {
            throw new Error(
              `REFUSED: --models includes "${label}" which matches no MODEL_PANEL entry. ` +
                `Known: ${MODEL_PANEL.map((m) => m.label).join(", ")}`,
            );
          }
          return c;
        });

  const scenarios =
    scenariosFlag === "all"
      ? SCENARIOS
      : scenariosFlag.split(",").map((raw) => {
          const id = raw.trim();
          const s = SCENARIOS.find((x) => x.id === id);
          if (!s) {
            throw new Error(
              `REFUSED: --scenarios includes "${id}" which matches no scenario. ` +
                `Known: ${SCENARIOS.map((x) => x.id).join(", ")}`,
            );
          }
          return s;
        });

  return { models, scenarios, trials, out: getFlag(argv, "--out") };
}

async function main(): Promise<void> {
  const args = parseReportArgs(process.argv.slice(2));
  if (args.trials < MIN_TRIALS) {
    console.error(
      `[report] NOTE: --trials ${args.trials} is below the ${MIN_TRIALS}-trial minimum this ` +
        `project's probes require before a rate is treated as evidence. This run validates the ` +
        `orchestration end to end — do not cite its numbers as a real screen result.`,
    );
  }

  const result = await runBenchmark({
    models: args.models,
    scenarios: args.scenarios,
    trials: args.trials,
  });
  const markdown = renderReport(result);
  console.log(markdown);
  if (args.out) {
    writeFileSync(args.out, markdown);
    console.error(`[report] wrote ${args.out}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      `ADVISING-BENCHMARK REPORT FAILED: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exit(1);
  });
}
