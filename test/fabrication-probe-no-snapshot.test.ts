// test/fabrication-probe-no-snapshot.test.ts
//
// The fabrication probe's behaviour when the snapshot it reads ground truth
// from is absent or damaged.
//
// This lives in its own FILE rather than its own `describe` because STATE_DIR is
// resolved once, at import time, from the environment. `node --test` runs each
// test file in its own process, so pointing STATE_DIR at a temp directory here
// isolates it from test/fabrication-probe.test.ts, which deliberately reads the
// real state/clemson/202608.db. Writing these synthetic snapshots into the real
// state/ directory instead would put fake term codes in front of the advisor.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-fabprobe-"));
fs.mkdirSync(path.join(TMP, "clemson"), { recursive: true });
process.env.STATE_DIR = TMP;

const {
  FACT_QUESTIONS,
  buildingVocabulary,
  buildingVocabularyDrift,
  DB_BUILDINGS,
  readDbBuildings,
  resolveTruth,
  resolveTruths,
  runExtractorValidation,
  validationPassed,
  TRUTH_TERM,
} = await import("../scripts/fabrication-probe.ts");

/** A snapshot that parses as SQLite but carries no `meta` table. */
function writeSnapshotWithoutMeta(term: string): void {
  const db = new Database(path.join(TMP, "clemson", `${term}.db`));
  db.exec(
    "CREATE TABLE sections (crn TEXT, term TEXT, credit_hours REAL);" +
      `INSERT INTO sections VALUES ('80777','${term}',3.0);`,
  );
  db.close();
}

describe("fabrication probe with no snapshot present", () => {
  it("resolves EVERY question to UNAVAILABLE rather than to a stale constant", () => {
    // The load-bearing assertion. Before this change the expected values were
    // string literals in the source, so they would have resolved perfectly well
    // with no database at all — and gone on being compared against the model.
    const resolutions = resolveTruths(FACT_QUESTIONS);
    assert.equal(resolutions.length, FACT_QUESTIONS.length);
    for (const r of resolutions) {
      assert.equal(
        r.status,
        "unavailable",
        `${r.question.id} produced a truth with no snapshot to read it from`,
      );
      assert.match(
        r.status === "unavailable" ? r.reason : "",
        /no snapshot at/,
        "the reason must name the missing snapshot",
      );
      assert.equal(r.status === "unavailable" && r.fetchedAt, null);
      assert.ok(!("truth" in r.question), "an unavailable question must carry no truth");
    }
  });

  it("SKIPS every extractor case instead of reporting a clean sweep of passes", () => {
    const rows = runExtractorValidation();
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((r) => r.status === "skipped"),
      "with no ground truth every case is unchecked",
    );
    assert.ok(
      rows.every((r) => !validationPassed(r)),
      "an unchecked case must never read as a pass",
    );
    assert.equal(
      rows.filter((r) => r.status === "fail").length,
      0,
      "unchecked is not the same as failed either",
    );
  });

  it("falls back to the baked building vocabulary rather than an empty one", () => {
    assert.equal(readDbBuildings(TRUTH_TERM), null);
    assert.deepEqual(buildingVocabulary(), DB_BUILDINGS);
    assert.ok(buildingVocabulary().length > 20);
  });

  it("reports drift as UNKNOWN (null), never as 'no drift'", () => {
    // "I could not check" and "I checked and it is clean" must not be the same
    // value, for the same reason roomCapacity() returns null rather than 0.
    assert.equal(buildingVocabularyDrift(TRUTH_TERM), null);
  });

  it("treats a snapshot with no readable meta as UNAVAILABLE, not a thrown run", () => {
    // Losing every other question's measurement to one damaged snapshot would be
    // strictly worse than reporting that one question as unmeasured.
    writeSnapshotWithoutMeta("209911");
    const res = resolveTruth({
      id: "no-meta",
      question: "For term 209911, CRN 80777: how many credit hours?",
      kind: "credits",
      term: "209911",
      truthSql: "select credit_hours from sections where term='209911' and crn='80777'",
      normalizeTruth: (raw) => (raw === null || raw === undefined ? null : String(raw)),
      hard: true,
      note: "synthetic",
    });
    assert.equal(res.status, "unavailable");
    assert.match(
      res.status === "unavailable" ? res.reason : "",
      /meta unreadable/,
      "an unreadable meta table must be reported as a reason, not thrown",
    );
    assert.equal(res.status === "unavailable" && res.fetchedAt, null);
  });
});
