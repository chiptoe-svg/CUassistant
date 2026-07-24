import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

// Point the config at a throwaway catalog DB BEFORE importing the module under
// test, since config reads GC_ADVISOR_DB at import time. Node's per-file test
// isolation keeps this env override from leaking to other suites.
const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "gc-catalog-")), "gc_advisor.db");
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE course (
    code TEXT PRIMARY KEY, subject TEXT NOT NULL, number TEXT NOT NULL,
    title TEXT, credits TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'active'
  );`);
  db.prepare(
    "INSERT INTO course (code, subject, number, title, credits, description) VALUES (?,?,?,?,?,?)",
  ).run("GC 4061", "GC", "4061", "Package and Specialty Printing Laboratory", "3", "A lab in package printing.");
  db.close();
}
process.env.GC_ADVISOR_DB = dbPath;

const { normalizeCourseCode, lookupCourse } = await import("../src/advisor-catalog.ts");

test("normalizeCourseCode canonicalizes spacing and case", () => {
  assert.equal(normalizeCourseCode("gc4061"), "GC 4061");
  assert.equal(normalizeCourseCode("GC 4061"), "GC 4061");
  assert.equal(normalizeCourseCode("  gc   4061 "), "GC 4061");
  assert.equal(normalizeCourseCode("ENGL 3140"), "ENGL 3140");
  // Trailing letter suffixes (e.g. a lab section code) are kept, uppercased.
  assert.equal(normalizeCourseCode("bio 1030l"), "BIO 1030L");
});

test("normalizeCourseCode rejects non-course text", () => {
  assert.equal(normalizeCourseCode("hello"), null);
  assert.equal(normalizeCourseCode("80836"), null);       // a bare CRN
  assert.equal(normalizeCourseCode("../etc/passwd"), null);
  assert.equal(normalizeCourseCode(""), null);
});

test("lookupCourse returns the catalog row for a known code, tolerating format", () => {
  const a = lookupCourse("GC4061");
  assert.equal(a?.code, "GC 4061");
  assert.equal(a?.credits, "3");
  assert.equal(a?.title, "Package and Specialty Printing Laboratory");
  assert.match(a?.description ?? "", /package printing/i);
  // Same course, messy input.
  assert.equal(lookupCourse("gc 4061")?.code, "GC 4061");
});

test("lookupCourse returns null for an unknown or junk code", () => {
  assert.equal(lookupCourse("ENGL 9999"), null);
  assert.equal(lookupCourse("not-a-code"), null);
});
