import assert from "node:assert/strict";
import test from "node:test";

import { bannerScheduleModule } from "../advisor/cleaner/modules/banner-schedule.js";

// A trimmed copy of a real Banner "Advising Profile" schedule paste: tab-
// delimited, with the CRN column followed by screen-reader instructions.
const CRUFT = (title: string, code: string) =>
  `Press enter key to view additional class details for ${title} ${code} for term 202608 Press Escape key to select the entire rowPress enter to activate popup`;

const SAMPLE = [
  `Orientation to Graphic Communications\tGC 1010 001\t80763${CRUFT("Orientation to Graphic Communications", "GC 1010 001")}\t1\tWeb Registered\tChip Tonkin`,
  `Clemson Connect\tCU 1000 005\t82855${CRUFT("Clemson Connect", "CU 1000 005")}\t0\tWeb Registered\tSusan S Whorton`,
  `Principles of Microeconomics\tECON 2110 032\t88803${CRUFT("Principles of Microeconomics", "ECON 2110 032")}\t3\tWeb Registered\tLawrence Reed Watson`,
].join("\n");

test("extracts code, section, CRN, credits, status, instructor and the term", () => {
  const out = bannerScheduleModule.clean(SAMPLE);
  assert.equal(out.schema, "banner-schedule-v1");
  assert.equal(out.sanitized.term, "202608");
  assert.equal(out.sanitized.courses.length, 3);

  const gc = out.sanitized.courses[0];
  assert.equal(gc.code, "GC 1010");
  assert.equal(gc.section, "001");
  assert.equal(gc.crn, "80763");
  assert.equal(gc.credits, 1);
  assert.equal(gc.status, "Web Registered");
  assert.equal(gc.instructor, "Chip Tonkin");
});

test("sums credits, including a 0-credit course", () => {
  const out = bannerScheduleModule.clean(SAMPLE);
  assert.equal(out.sanitized.totalCredits, 4); // 1 + 0 + 3
  const zero = out.sanitized.courses.find((c) => c.code === "CU 1000");
  assert.equal(zero!.credits, 0);
});

test("emits a Markdown table with the screen-reader cruft stripped", () => {
  const out = bannerScheduleModule.clean(SAMPLE);
  assert.match(out.markdown, /\| Code \| Title \| CRN \| Cr \| Status \| Instructor \|/);
  assert.match(out.markdown, /\| GC 1010 001 \| Orientation to Graphic Communications \| 80763 \| 1 \|/);
  assert.match(out.markdown, /term 202608 — 3 courses, 4 credits/);
  // The accessibility noise must not survive into the output.
  assert.ok(!out.markdown.includes("Press enter key"), "screen-reader text leaked");
});

test("warns on and skips a row that is not a registered course", () => {
  const out = bannerScheduleModule.clean(`${SAMPLE}\nsome stray footer line`);
  assert.equal(out.sanitized.courses.length, 3);
  assert.ok(out.warnings.some((w) => /did not look like a registered course/i.test(w)));
});
