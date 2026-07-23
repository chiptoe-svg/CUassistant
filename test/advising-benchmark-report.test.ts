// test/advising-benchmark-report.test.ts
//
// Offline unit tests for scripts/advising-benchmark/report.ts (Task 4 of
// docs/superpowers/specs/2026-07-23-advising-model-benchmark.md). The live
// orchestration (runBenchmark) makes real HTTP calls end to end and is
// exercised only by the one-off small validation run described in the Task 4
// report, per the task brief. This file tests only the PURE aggregation math
// with mock RunObservation[]/JudgeVerdict[] inputs:
//   - failureClass tallying
//   - malformed / tool-calling proportions + Wilson interval wiring
//   - latency p50/p95 (even/odd counts, single value)
//   - judge mean over SCORED only, unscored counted separately
//   - S1 deterministic-vs-judge calibration comparison
//   - the pooling guard (aggregateReliability refuses mixed-scenario input)
//
// No network, no live model calls here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UnscoredJudgeVerdict, ScoredJudgeVerdict } from "../scripts/advising-benchmark/judge.ts";
import {
  aggregateJudgeVerdicts,
  aggregateReliability,
  aggregateS1Calibration,
  calibrateS1Trial,
  latencyPercentiles,
  meanOf,
  percentile,
  tallyFailureClasses,
  type S1TrialCalibration,
} from "../scripts/advising-benchmark/report.ts";
import type { RunObservation } from "../scripts/advising-benchmark/runner.ts";
import type { S1Fact } from "../scripts/advising-benchmark/scenarios.ts";

function obs(patch: Partial<RunObservation> = {}): RunObservation {
  return {
    model: "qwen-agentworld-35b-a3b",
    scenarioId: "S1",
    status: 200,
    bodyParsed: true,
    toolCallCount: 1,
    malformed: false,
    answer: "It has 4 credit hours.",
    latencyMsPerCompletion: [1000],
    promptTokens: 500,
    completionTokens: 50,
    failureClass: "ok",
    ...patch,
  };
}

function scored(patch: Partial<ScoredJudgeVerdict> = {}): ScoredJudgeVerdict {
  return {
    scenarioId: "S1",
    status: "scored",
    qualityScore: 4,
    behavioralOutcome: "stated credits and flagged the section full",
    rationale: "correct and clear",
    judgeRaw: '{"qualityScore":4}',
    ...patch,
  };
}

function unscored(patch: Partial<UnscoredJudgeVerdict> = {}): UnscoredJudgeVerdict {
  return {
    scenarioId: "S1",
    status: "unscored",
    qualityScore: null,
    behavioralOutcome: null,
    rationale: null,
    judgeRaw: "not json",
    unscoredReason: "judge response is not valid JSON",
    ...patch,
  };
}

// --- failureClass tallying ---------------------------------------------------

describe("tallyFailureClasses", () => {
  it("counts every observation into exactly one of the 5 buckets, all buckets present", () => {
    const counts = tallyFailureClasses([
      obs({ failureClass: "ok" }),
      obs({ failureClass: "ok" }),
      obs({ failureClass: "malformed" }),
      obs({ failureClass: "no_tool_call" }),
      obs({ failureClass: "http_error" }),
    ]);
    assert.deepEqual(counts, {
      ok: 2,
      malformed: 1,
      no_tool_call: 1,
      http_error: 1,
      unparseable: 0,
    });
  });

  it("empty input yields all-zero counts, not an empty object", () => {
    const counts = tallyFailureClasses([]);
    assert.deepEqual(counts, {
      ok: 0,
      http_error: 0,
      unparseable: 0,
      malformed: 0,
      no_tool_call: 0,
    });
  });
});

// --- percentile / latency ----------------------------------------------------

describe("percentile", () => {
  it("p50 of an odd-length array is the exact middle element", () => {
    assert.equal(percentile([1, 2, 3], 50), 2);
  });

  it("p50 of an even-length array averages the two middle elements", () => {
    assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  });

  it("a single value is returned for any percentile", () => {
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 95), 42);
    assert.equal(percentile([42], 0), 42);
  });

  it("p95 of a known array matches linear-interpolation expectation", () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    // idx = 0.95 * 19 = 18.05 -> between sorted[18]=19 and sorted[19]=20
    assert.equal(percentile(sorted, 95), 19.05);
  });

  it("refuses an empty array rather than fabricating 0", () => {
    assert.throws(() => percentile([], 50), /empty array/);
  });
});

describe("latencyPercentiles", () => {
  it("flattens per-completion latencies across every observation in the cell", () => {
    const { p50, p95 } = latencyPercentiles([
      obs({ latencyMsPerCompletion: [100, 200] }),
      obs({ latencyMsPerCompletion: [300] }),
    ]);
    // pooled sorted: [100, 200, 300]
    assert.equal(p50, 200);
    assert.equal(p95, 290);
  });

  it("returns null (not 0) when there is no latency data at all", () => {
    const { p50, p95 } = latencyPercentiles([obs({ latencyMsPerCompletion: [] })]);
    assert.equal(p50, null);
    assert.equal(p95, null);
  });
});

describe("meanOf", () => {
  it("means only the non-null values", () => {
    assert.equal(meanOf([10, null, 20, null, 30]), 20);
  });

  it("returns null (not 0) when every value is null", () => {
    assert.equal(meanOf([null, null]), null);
  });
});

// --- reliability aggregation + Wilson wiring + pooling guard -----------------

describe("aggregateReliability", () => {
  it("wires malformed rate and tool-calling success rate through wilsonInterval on n", () => {
    const agg = aggregateReliability([
      obs({ malformed: false, toolCallCount: 1, failureClass: "ok" }),
      obs({ malformed: false, toolCallCount: 1, failureClass: "ok" }),
      obs({ malformed: true, toolCallCount: 0, failureClass: "malformed" }),
      obs({ malformed: false, toolCallCount: 0, failureClass: "no_tool_call" }),
    ]);
    assert.equal(agg.n, 4);
    // malformed: 1/4
    assert.equal(agg.malformedRate.successes, 1);
    assert.equal(agg.malformedRate.n, 4);
    assert.equal(agg.malformedRate.point, 0.25);
    // tool-calling success: 2/4 (toolCallCount > 0)
    assert.equal(agg.toolCallingSuccessRate.successes, 2);
    assert.equal(agg.toolCallingSuccessRate.point, 0.5);
    // Wilson interval must bracket the point estimate
    assert.ok(agg.malformedRate.low <= agg.malformedRate.point);
    assert.ok(agg.malformedRate.high >= agg.malformedRate.point);
  });

  it("computes token means and latency percentiles for the cell", () => {
    const agg = aggregateReliability([
      obs({ promptTokens: 100, completionTokens: 10, latencyMsPerCompletion: [500] }),
      obs({ promptTokens: 200, completionTokens: 20, latencyMsPerCompletion: [1500] }),
    ]);
    assert.equal(agg.meanPromptTokens, 150);
    assert.equal(agg.meanCompletionTokens, 15);
    assert.equal(agg.latency.p50, 1000);
  });

  it("refuses zero observations", () => {
    assert.throws(() => aggregateReliability([]), /zero observations/);
  });

  it("THE POOLING GUARD: refuses observations spanning multiple scenarios", () => {
    assert.throws(
      () =>
        aggregateReliability([
          obs({ scenarioId: "S1" }),
          obs({ scenarioId: "S4" }),
        ]),
      /multiple.*\(model, scenario\) cells|per \(model, scenario\)/i,
    );
  });

  it("THE POOLING GUARD: refuses observations spanning multiple models", () => {
    assert.throws(
      () =>
        aggregateReliability([
          obs({ model: "gptoss-120b" }),
          obs({ model: "qwen-agentworld-35b-a3b" }),
        ]),
      /multiple.*\(model, scenario\) cells|per \(model, scenario\)/i,
    );
  });
});

// --- judge mean over SCORED only ---------------------------------------------

describe("aggregateJudgeVerdicts", () => {
  it("means qualityScore over scored verdicts only", () => {
    const agg = aggregateJudgeVerdicts([scored({ qualityScore: 4 }), scored({ qualityScore: 2 })]);
    assert.equal(agg.meanQualityScore, 3);
    assert.equal(agg.scoredCount, 2);
    assert.equal(agg.unscoredCount, 0);
  });

  it("counts unscored SEPARATELY and does not fold them into the mean", () => {
    const agg = aggregateJudgeVerdicts([
      scored({ qualityScore: 5 }),
      unscored({ unscoredReason: "bad json" }),
    ]);
    assert.equal(agg.meanQualityScore, 5); // unscored not averaged in as e.g. 0 or skipped-as-lower
    assert.equal(agg.scoredCount, 1);
    assert.equal(agg.unscoredCount, 1);
    assert.deepEqual(agg.unscoredReasons, ["bad json"]);
  });

  it("an all-unscored run yields NO mean (null), not 0", () => {
    const agg = aggregateJudgeVerdicts([unscored(), unscored()]);
    assert.equal(agg.meanQualityScore, null);
    assert.equal(agg.scoredCount, 0);
    assert.equal(agg.unscoredCount, 2);
  });

  it("empty verdict list yields null mean and zero counts", () => {
    const agg = aggregateJudgeVerdicts([]);
    assert.equal(agg.meanQualityScore, null);
    assert.equal(agg.scoredCount, 0);
    assert.equal(agg.unscoredCount, 0);
  });
});

// --- S1 deterministic calibration --------------------------------------------

const S1_ANCHOR: S1Fact = { creditHours: 4, seatsAvailable: 0 };

describe("calibrateS1Trial", () => {
  it("matches a correctly-stated credit count", () => {
    const cal = calibrateS1Trial("GC 3400 is a 4 credit hour course.", S1_ANCHOR);
    assert.equal(cal.creditsMatch, "match");
  });

  it("flags a mismatched credit count", () => {
    const cal = calibrateS1Trial("GC 3400 is a 3 credit hour course.", S1_ANCHOR);
    assert.equal(cal.creditsMatch, "mismatch");
  });

  it("reports not_extracted (not mismatch) when the extractor finds no credit-hour cue", () => {
    const cal = calibrateS1Trial("She should be able to register for it.", S1_ANCHOR);
    assert.equal(cal.creditsMatch, "not_extracted");
  });

  it("seat calibration: extractSeatCap targets enrollment-cap language, not " +
    "seats-remaining phrasing — a natural 'seats left' answer reports not_extracted", () => {
    const cal = calibrateS1Trial(
      "It has 4 credit hours, and unfortunately there are 0 seats left — it's full.",
      S1_ANCHOR,
    );
    // Documented, expected behavior of the reused extractor (see report.ts's
    // calibrateS1Trial doc comment) — not a bug in this wiring.
    assert.equal(cal.seatMatch, "not_extracted");
  });

  it("seat calibration matches when the answer uses enrollment-cap language", () => {
    const cal = calibrateS1Trial("The maximum enrollment for that section is 0.", S1_ANCHOR);
    assert.equal(cal.seatMatch, "match");
  });
});

describe("aggregateS1Calibration", () => {
  function trial(creditsMatch: S1TrialCalibration["creditsMatch"]): S1TrialCalibration {
    return {
      creditsExtraction: { kind: "none" },
      creditsMatch,
      seatExtraction: { kind: "none" },
      seatMatch: "not_extracted",
    };
  }

  it("computes match rate over the EXTRACTED subset only, counting not_extracted separately", () => {
    const agg = aggregateS1Calibration([trial("match"), trial("match"), trial("mismatch"), trial("not_extracted")]);
    assert.equal(agg.n, 4);
    assert.equal(agg.credits.matchCount, 2);
    assert.equal(agg.credits.mismatchCount, 1);
    assert.equal(agg.credits.notExtractedCount, 1);
    // matchRate denominator is matchCount+mismatchCount = 3, not n=4
    assert.equal(agg.credits.matchRate?.n, 3);
    assert.ok(Math.abs((agg.credits.matchRate?.point ?? 0) - 2 / 3) < 1e-9);
  });

  it("matchRate is null (not a fabricated 0%) when nothing was ever extracted", () => {
    const agg = aggregateS1Calibration([trial("not_extracted"), trial("not_extracted")]);
    assert.equal(agg.credits.matchRate, null);
    assert.equal(agg.credits.notExtractedCount, 2);
  });
});
