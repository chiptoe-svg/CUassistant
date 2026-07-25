import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-analytics-"));
process.env.ADVISOR_ANALYTICS_DIR = DIR;

const { classifyQuestion, deriveToolOutcome, recordTurn } = await import(
  "../src/advisor-analytics.ts"
);

function readLines(): Record<string, unknown>[] {
  const p = path.join(DIR, "turns.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("classifyQuestion maps to the fixed enum and falls back to general_advising", () => {
  assert.equal(classifyQuestion("Which sections of GC 4061 have open seats?"), "seat_availability");
  assert.equal(classifyQuestion("Is the student prereq eligible for GC 3400?"), "prereq_eligibility");
  assert.equal(classifyQuestion("Build a schedule with no class before 10"), "schedule_build");
  assert.equal(classifyQuestion("What does the GC major require in the junior year?"), "degree_requirements");
  assert.equal(classifyQuestion("What room fits 30 and what's its capacity?"), "room_capacity");
  assert.equal(classifyQuestion("Which AI model does this use behind the scenes?"), "how_it_works");
  assert.equal(classifyQuestion("Tell me a joke"), "general_advising");
});

test("deriveToolOutcome reads only structural flags, ignoring non-JSON", () => {
  assert.deepEqual(deriveToolOutcome('{"needs_narrowing":true}'), { needsNarrowing: true });
  assert.deepEqual(deriveToolOutcome('{"total_matched":0}'), { empty: true });
  assert.deepEqual(deriveToolOutcome('{"sections":[]}'), { empty: true });
  assert.deepEqual(deriveToolOutcome('{"has_snapshot":false}'), { empty: true });
  assert.deepEqual(deriveToolOutcome('{"sections":[{"crn":"1"}]}'), {});
  assert.deepEqual(deriveToolOutcome("not json"), {});
});

test("recordTurn writes structure but NEVER the question text or arg values", () => {
  // A question full of PII — none of it may reach disk.
  const question = "Does C12345678 named Jane Doe with GPA 3.92 have a seat in GC 4061?";
  recordTurn(question, {
    mode: "private",
    outcome: "complete",
    latencyMs: 812,
    toolLog: [
      { name: "find-sections-by-schedule", argKeys: ["term", "min_seats"], needsNarrowing: true },
      { name: "get-schedule-freshness", argKeys: ["term"], empty: true },
    ],
  });

  const lines = readLines();
  assert.equal(lines.length, 1);
  const rec = lines[0];
  // Structure captured.
  assert.equal(rec.mode, "private");
  assert.equal(rec.category, "seat_availability");
  assert.equal(rec.outcome, "complete");
  assert.equal(rec.tool_count, 2);
  assert.equal(rec.needs_narrowing, true);
  assert.deepEqual(rec.empty_tools, ["get-schedule-freshness"]);
  assert.deepEqual(rec.arg_keys, {
    "find-sections-by-schedule": ["term", "min_seats"],
    "get-schedule-freshness": ["term"],
  });
  assert.equal(rec.latency_ms, 812);

  // Privacy contract: the whole serialized record must contain none of the PII.
  const blob = JSON.stringify(rec);
  for (const secret of ["C12345678", "Jane", "Doe", "3.92", question]) {
    assert.equal(blob.includes(secret), false, `record leaked "${secret}"`);
  }
});

test("recordTurn is a no-op when ADVISOR_ANALYTICS=off", () => {
  const before = readLines().length;
  process.env.ADVISOR_ANALYTICS = "off";
  try {
    recordTurn("Which sections have open seats?", {
      mode: "private",
      outcome: "complete",
      latencyMs: 1,
      toolLog: [],
    });
    assert.equal(readLines().length, before, "no line should be appended when disabled");
  } finally {
    delete process.env.ADVISOR_ANALYTICS;
  }
});
