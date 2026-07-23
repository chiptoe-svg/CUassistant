// test/advising-benchmark-judge.test.ts
//
// Offline unit tests for scripts/advising-benchmark/judge.ts (Task 3 of
// docs/superpowers/specs/2026-07-23-advising-model-benchmark.md). The live
// gpt-5.4 reference call and gpt-5.5-pro judge call are network and are
// exercised only by the one-off live smoke run in the Task 3 report, per the
// task brief. This file tests only the PURE parts with mock inputs:
//   - judge PROMPT ASSEMBLY (buildJudgePrompt) — especially the BLINDING
//     assertion, the most important property in this file.
//   - judge RESPONSE PARSING (parseJudgeResponse).
//   - the reference "couldn't establish" classifier (summarizeReferenceObservation).
//
// No network, no live model calls here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  behavioralCriterion,
  buildJudgePrompt,
  JUDGE_MODEL,
  parseJudgeResponse,
  REFERENCE_MODEL,
  summarizeReferenceObservation,
  type JudgeInput,
} from "../scripts/advising-benchmark/judge.ts";
import { MODEL_PANEL, type RunObservation } from "../scripts/advising-benchmark/runner.ts";
import { SCENARIOS, type Scenario } from "../scripts/advising-benchmark/scenarios.ts";

function scenario(id: Scenario["id"]): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`fixture bug: no scenario ${id}`);
  return s;
}

function judgeInput(patch: Partial<JudgeInput> = {}): JudgeInput {
  return {
    scenario: scenario("S1"),
    candidateAnswer: "GC 3400 is 4 credit hours, and that section is currently full.",
    referenceAnswer: "It's 4 credit hours; unfortunately that section has 0 seats left.",
    referenceUnavailableReason: null,
    anchorFacts: { creditHours: 4, seatsAvailable: 0 },
    ...patch,
  };
}

function runObservation(patch: Partial<RunObservation> = {}): RunObservation {
  return {
    model: "reference-gpt-5.4",
    scenarioId: "S1",
    status: 200,
    bodyParsed: true,
    toolCallCount: 1,
    malformed: false,
    answer: "GC 3400 is 4 credit hours and the section is full.",
    latencyMsPerCompletion: [1200],
    promptTokens: 500,
    completionTokens: 60,
    failureClass: "ok",
    ...patch,
  };
}

// --- BLINDING (the important one) -------------------------------------------

describe("buildJudgePrompt — blinding", () => {
  it("never mentions any candidate model's label or model id", () => {
    // Every identity string that could possibly leak: the 4 deployable
    // candidates, the reference model, and the judge model itself.
    const identityStrings = [
      ...MODEL_PANEL.flatMap((c) => [c.label, c.model]),
      REFERENCE_MODEL.label,
      REFERENCE_MODEL.model,
      JUDGE_MODEL.label,
      JUDGE_MODEL.model,
    ];
    for (const id of SCENARIOS.map((s) => s.id)) {
      const { system, user } = buildJudgePrompt(judgeInput({ scenario: scenario(id) }));
      const combined = `${system}\n${user}`.toLowerCase();
      for (const identity of identityStrings) {
        assert.equal(
          combined.includes(identity.toLowerCase()),
          false,
          `scenario ${id}: prompt leaked model identity "${identity}"`,
        );
      }
    }
  });

  it("never uses pairwise/ordering language (candidate A/B, model A/B)", () => {
    const { system, user } = buildJudgePrompt(judgeInput());
    const combined = `${system}\n${user}`.toLowerCase();
    // Word-boundary regexes, not plain substring checks: "answer a" as a
    // literal substring would false-positive on ordinary prose like "the
    // answer actually did" — the property under test is a labeled A/B
    // ordering, not the mere co-occurrence of a letter.
    for (const banned of [/\bcandidate a\b/, /\bcandidate b\b/, /\bmodel a\b/, /\bmodel b\b/, /\banswer a\b/, /\banswer b\b/]) {
      assert.equal(banned.test(combined), false, `prompt used pairwise phrase matching ${banned}`);
    }
  });

  it("JudgeInput itself has no field to carry a model label (structural guarantee)", () => {
    const input = judgeInput();
    assert.equal("model" in input, false);
    assert.equal("candidateModel" in input, false);
    assert.equal("label" in input, false);
  });
});

// --- prompt content: rubric, criterion, anchor facts, reference framing ----

describe("buildJudgePrompt — required content", () => {
  it("contains the rubric and the scenario's behavioral criterion", () => {
    const { system } = buildJudgePrompt(judgeInput({ scenario: scenario("S2") }));
    assert.match(system, /1-5 scale/);
    assert.ok(system.includes(behavioralCriterion("S2")));
  });

  it("contains the anchor facts as ground truth", () => {
    const anchorFacts = { count: 2, crns: ["80833", "83836"] };
    const { user } = buildJudgePrompt(judgeInput({ scenario: scenario("S2"), anchorFacts }));
    assert.match(user, /GROUND-TRUTH FACTS/);
    assert.ok(user.includes(JSON.stringify(anchorFacts, null, 2)));
  });

  it('frames the reference as "one good example, not the only correct answer" when present', () => {
    const { user } = buildJudgePrompt(judgeInput({ referenceAnswer: "a reference answer" }));
    assert.match(user, /one example of a good answer/i);
    assert.match(user, /not the only correct answer/i);
    assert.ok(user.includes("a reference answer"));
  });

  it("tells the judge no reference is available, with the reason, when referenceAnswer is null", () => {
    const { user } = buildJudgePrompt(
      judgeInput({ referenceAnswer: null, referenceUnavailableReason: "reference gpt-5.4 call returned http_error" }),
    );
    assert.match(user, /REFERENCE ANSWER: none available/);
    assert.ok(user.includes("reference gpt-5.4 call returned http_error"));
  });

  it("does not claim the reference is authoritative ground truth (only the anchor facts are)", () => {
    const { user } = buildJudgePrompt(judgeInput());
    // The anchor block, not the reference block, is the one labeled ground truth.
    const groundTruthIdx = user.indexOf("GROUND-TRUTH FACTS");
    const referenceIdx = user.indexOf("REFERENCE ANSWER");
    assert.ok(groundTruthIdx >= 0 && referenceIdx >= 0);
    assert.notEqual(groundTruthIdx, referenceIdx);
  });

  it("includes the scenario prompt and the candidate answer verbatim", () => {
    const s = scenario("S4");
    const { user } = buildJudgePrompt(
      judgeInput({ scenario: s, candidateAnswer: "unique-marker-xyz she should switch labs" }),
    );
    assert.ok(user.includes(s.prompt));
    assert.ok(user.includes("unique-marker-xyz she should switch labs"));
  });

  it("instructs the judge to respond with the exact JSON schema JudgeVerdict parses", () => {
    const { system } = buildJudgePrompt(judgeInput());
    assert.match(system, /"qualityScore"/);
    assert.match(system, /"behavioralOutcome"/);
    assert.match(system, /"rationale"/);
  });
});

describe("behavioralCriterion", () => {
  it("returns a distinct, non-empty criterion for every scenario", () => {
    const criteria = SCENARIOS.map((s) => behavioralCriterion(s.id));
    for (const c of criteria) assert.ok(c.length > 20);
    assert.equal(new Set(criteria).size, criteria.length);
  });
});

// --- response parsing --------------------------------------------------------

describe("parseJudgeResponse", () => {
  it("parses a well-formed response into a scored verdict", () => {
    const verdict = parseJudgeResponse(
      "S1",
      JSON.stringify({
        qualityScore: 4,
        behavioralOutcome: "flagged the section as full",
        rationale: "Correctly stated credits and flagged 0 seats available.",
      }),
    );
    assert.equal(verdict.status, "scored");
    assert.equal(verdict.qualityScore, 4);
    assert.equal(verdict.behavioralOutcome, "flagged the section as full");
    assert.ok(verdict.rationale && verdict.rationale.length > 0);
  });

  it("unwraps a ```json fenced response before parsing", () => {
    const raw = [
      "```json",
      JSON.stringify({ qualityScore: 5, behavioralOutcome: "ok", rationale: "great" }),
      "```",
    ].join("\n");
    const verdict = parseJudgeResponse("S1", raw);
    assert.equal(verdict.status, "scored");
    assert.equal(verdict.qualityScore, 5);
  });

  it("clamps and rounds an out-of-range score rather than rejecting it, and records the raw value", () => {
    const high = parseJudgeResponse(
      "S1",
      JSON.stringify({ qualityScore: 7, behavioralOutcome: "x", rationale: "y" }),
    );
    assert.equal(high.status, "scored");
    assert.equal(high.qualityScore, 5);
    assert.equal((high as { scoreClampedFrom?: number }).scoreClampedFrom, 7);

    const low = parseJudgeResponse(
      "S1",
      JSON.stringify({ qualityScore: 0, behavioralOutcome: "x", rationale: "y" }),
    );
    assert.equal(low.status, "scored");
    assert.equal(low.qualityScore, 1);

    const fractional = parseJudgeResponse(
      "S1",
      JSON.stringify({ qualityScore: 3.6, behavioralOutcome: "x", rationale: "y" }),
    );
    assert.equal(fractional.status, "scored");
    assert.equal(fractional.qualityScore, 4);
  });

  it("a score already in [1,5] does not carry scoreClampedFrom", () => {
    const verdict = parseJudgeResponse(
      "S1",
      JSON.stringify({ qualityScore: 3, behavioralOutcome: "x", rationale: "y" }),
    );
    assert.equal("scoreClampedFrom" in verdict, false);
  });

  it("non-JSON garbage yields an unscored verdict, never a silent default score", () => {
    const verdict = parseJudgeResponse("S1", "the model just chatted instead of returning JSON");
    assert.equal(verdict.status, "unscored");
    assert.equal(verdict.qualityScore, null);
    assert.ok((verdict as { unscoredReason: string }).unscoredReason.length > 0);
  });

  it("valid JSON but not an object yields unscored", () => {
    const verdict = parseJudgeResponse("S1", JSON.stringify([1, 2, 3]));
    assert.equal(verdict.status, "unscored");
  });

  it("missing qualityScore yields unscored, not a default score", () => {
    const verdict = parseJudgeResponse(
      "S1",
      JSON.stringify({ behavioralOutcome: "x", rationale: "y" }),
    );
    assert.equal(verdict.status, "unscored");
    assert.equal(verdict.qualityScore, null);
  });

  it("a non-numeric qualityScore (e.g. a string) yields unscored", () => {
    const verdict = parseJudgeResponse(
      "S1",
      JSON.stringify({ qualityScore: "four", behavioralOutcome: "x", rationale: "y" }),
    );
    assert.equal(verdict.status, "unscored");
  });

  it("missing behavioralOutcome yields unscored even with a valid score", () => {
    const verdict = parseJudgeResponse(
      "S1",
      JSON.stringify({ qualityScore: 4, rationale: "y" }),
    );
    assert.equal(verdict.status, "unscored");
  });

  it("missing rationale yields unscored even with a valid score", () => {
    const verdict = parseJudgeResponse(
      "S1",
      JSON.stringify({ qualityScore: 4, behavioralOutcome: "x" }),
    );
    assert.equal(verdict.status, "unscored");
  });

  it("every unscored verdict carries a reason and preserves judgeRaw for debugging", () => {
    const verdict = parseJudgeResponse("S1", "not json at all");
    assert.equal(verdict.status, "unscored");
    if (verdict.status === "unscored") {
      assert.ok(verdict.unscoredReason.length > 0);
      assert.equal(verdict.judgeRaw, "not json at all");
    }
  });
});

// --- reference "couldn't establish" classification --------------------------

describe("summarizeReferenceObservation", () => {
  it("an ok failureClass is a usable reference", () => {
    const summary = summarizeReferenceObservation(runObservation({ failureClass: "ok", answer: "the answer" }));
    assert.equal(summary.status, "ok");
    assert.equal(summary.answer, "the answer");
    assert.equal(summary.reason, null);
  });

  it("http_error is unavailable, not a silent empty string", () => {
    const summary = summarizeReferenceObservation(
      runObservation({ failureClass: "http_error", status: 503, answer: "" }),
    );
    assert.equal(summary.status, "unavailable");
    assert.equal(summary.answer, null);
    assert.ok(summary.reason && summary.reason.includes("http_error"));
  });

  it("malformed is unavailable", () => {
    const summary = summarizeReferenceObservation(runObservation({ failureClass: "malformed" }));
    assert.equal(summary.status, "unavailable");
    assert.ok(summary.reason?.includes("malformed"));
  });

  it("unparseable is unavailable", () => {
    const summary = summarizeReferenceObservation(runObservation({ failureClass: "unparseable", answer: "" }));
    assert.equal(summary.status, "unavailable");
  });

  it("no_tool_call is unavailable — a reference that never touched live data is not a trustworthy bar", () => {
    const summary = summarizeReferenceObservation(
      runObservation({ failureClass: "no_tool_call", toolCallCount: 0, answer: "made-up answer from memory" }),
    );
    assert.equal(summary.status, "unavailable");
    assert.equal(summary.answer, null);
  });
});

// --- model config sanity -----------------------------------------------------

describe("REFERENCE_MODEL / JUDGE_MODEL config", () => {
  it("REFERENCE_MODEL resolves gpt-5.4 on the OpenAI passthrough with the openai-reasoning family", () => {
    assert.equal(REFERENCE_MODEL.model, "gpt-5.4");
    assert.equal(REFERENCE_MODEL.family, "openai-reasoning");
    assert.ok(REFERENCE_MODEL.baseUrl.length > 0);
  });

  it("JUDGE_MODEL resolves gpt-5.5 on the same passthrough", () => {
    // gpt-5.5, not gpt-5.5-pro: the -pro tier 403s at the Clemson gateway
    // ("OpenAI pricing is not configured"). See judge.ts JUDGE_MODEL comment.
    assert.equal(JUDGE_MODEL.model, "gpt-5.5");
    assert.ok(JUDGE_MODEL.baseUrl.length > 0);
  });

  it("REFERENCE_MODEL and JUDGE_MODEL are distinct models (reference != judge)", () => {
    assert.notEqual(REFERENCE_MODEL.model, JUDGE_MODEL.model);
  });
});
