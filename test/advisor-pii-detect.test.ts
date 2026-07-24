import assert from "node:assert/strict";
import test from "node:test";

import { flagLikelyPrivate } from "../src/advisor-pii-detect.ts";

test("flags structured identifiers", () => {
  const cats = (s: string) => flagLikelyPrivate(s).map((f) => f.category);
  assert.deepEqual(cats("student C12345678"), ["Clemson student ID"]);
  assert.ok(cats("reach me at jdoe@clemson.edu").includes("email address"));
  assert.ok(cats("call 864-555-1212").includes("phone number"));
  assert.ok(cats("SSN 123-45-6789").includes("SSN"));
  assert.ok(cats("her GPA is 3.42").includes("GPA"));
  assert.ok(cats("id 900123456").includes("long digit sequence"));
});

test("does NOT flag ordinary advising prose or public course data", () => {
  assert.deepEqual(flagLikelyPrivate("Can she take GC 3400 and GC 3410 in Fall 2024?"), []);
  assert.deepEqual(flagLikelyPrivate("CRN 12345 meets MWF 9:05"), []); // 5-digit CRN, 4-digit course, time
  assert.deepEqual(flagLikelyPrivate("Prof. Sarah Johnson teaches the lab"), []); // names not gated
});

test("returns the matched sample so the advisor can find it", () => {
  const flags = flagLikelyPrivate("her id is C87654321");
  assert.equal(flags[0].category, "Clemson student ID");
  assert.equal(flags[0].sample, "C87654321");
});
