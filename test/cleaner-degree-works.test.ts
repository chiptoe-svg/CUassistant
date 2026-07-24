import assert from "node:assert/strict";
import test from "node:test";

import { degreeWorksModule } from "../advisor/cleaner/modules/degree-works.js";

const SAMPLE = [
  "Clemson University Degree Works",
  "Student name John Q Public C12345678",
  "Overall GPA 3.45",
  "Major Graphic Communications Minor None",
  "Credits required: 122 Credits applied: 45 Catalog year: 2023-2024",
  "Course Title Grade Credits Term",
  "GC 1040 Introduction to Graphic Communications A 3 Fall 2023",
  "GC 2050 Digital Imaging IP 3 Spring 2024",
].join("\n");

test("emits gc-course-ledger-v1 with the completed courses", () => {
  const out = degreeWorksModule.clean(SAMPLE);
  assert.equal(out.schema, "gc-course-ledger-v1");
  assert.equal(out.sanitized.schema, "gc-course-ledger-v1");
  assert.equal(out.sanitized.catalogYear, "2023-2024");
  const codes = out.sanitized.courses.map((c) => c.code);
  assert.ok(codes.includes("GC 1040"));
  assert.ok(codes.includes("GC 2050"));
});

test("sanitized output carries no PII and no grades", () => {
  const out = degreeWorksModule.clean(SAMPLE);
  const json = JSON.stringify(out.sanitized);
  assert.ok(!json.includes("C12345678"), "student ID leaked");
  assert.ok(!json.includes("3.45"), "GPA leaked");
  assert.ok(!json.includes("John"), "name leaked");
  assert.ok(!/"grade"/i.test(json), "grade field present");
  assert.ok(!out.preview.includes("C12345678"));
});

test("warns when the catalog year is missing", () => {
  const out = degreeWorksModule.clean(SAMPLE.replace(/Catalog year: 2023-2024/, ""));
  assert.ok(out.warnings.some((w) => /Catalog year was not found/i.test(w)));
});
