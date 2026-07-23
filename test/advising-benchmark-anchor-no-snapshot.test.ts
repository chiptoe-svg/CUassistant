// test/advising-benchmark-anchor-no-snapshot.test.ts
//
// The advising-benchmark anchor's behaviour when the schedule snapshot it
// reads ground truth from is absent. Lives in its own file (not a `describe`
// in advising-benchmark-anchor.test.ts) for the same reason
// fabrication-probe-no-snapshot.test.ts does: STATE_DIR is resolved once, at
// import time, from the environment, and `node --test` runs each test file in
// its own process — so pointing STATE_DIR at an empty temp directory here
// cannot leak into the sibling file, which deliberately reads the real
// state/clemson/202608.db.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-advbench-"));
fs.mkdirSync(path.join(TMP, "clemson"), { recursive: true });
process.env.STATE_DIR = TMP;

const { anchorS1, anchorS2, anchorS3, anchorS4, anchorS5 } = await import(
  "../scripts/advising-benchmark/scenarios.ts"
);

describe("advising-benchmark anchors with no snapshot present", () => {
  it("anchorS1 is UNAVAILABLE, not a wrong-answer resolved value", () => {
    const res = anchorS1();
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") {
      assert.match(res.reason, /no snapshot at/);
      assert.equal(res.fetchedAt, null);
    }
  });

  it("anchorS2 is UNAVAILABLE", () => {
    const res = anchorS2();
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") assert.match(res.reason, /no snapshot at/);
  });

  it("anchorS3 is UNAVAILABLE", () => {
    const res = anchorS3();
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") assert.match(res.reason, /no snapshot at/);
  });

  it("anchorS4 is UNAVAILABLE", () => {
    const res = anchorS4();
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") assert.match(res.reason, /no snapshot at/);
  });

  it("anchorS5 is UNAVAILABLE even when gc_advisor itself answers fine — both sources are required", async () => {
    // A stubbed run that succeeds, so the ONLY reason this can fail is the
    // missing schedule snapshot the time/day half depends on.
    const stubRun = async () =>
      JSON.stringify([
        {
          slot_type: "Specialty Area Requirement",
          rule: { slot_type: "Specialty Area Requirement", explicit_courses: ["GC 3720"] },
        },
      ]);
    const res = await anchorS5({ run: stubRun });
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") assert.match(res.reason, /no snapshot at/);
  });
});
