import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

// Point config at a throwaway catalog DB before importing the tool module,
// since findCoreqs opens GC_ADVISOR_DB (read from config at call time).
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gc-coreq-")), "gc_advisor.db");
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE course (
    code TEXT PRIMARY KEY, subject TEXT NOT NULL, number TEXT NOT NULL,
    title TEXT, credits TEXT, description TEXT, coreq_parsed TEXT,
    status TEXT NOT NULL DEFAULT 'active'
  );`);
  const ins = db.prepare(
    "INSERT INTO course (code, subject, number, title, credits, description, coreq_parsed) VALUES (?,?,?,?,?,?,?)",
  );
  // Structured path: coreq_parsed populated (both directions), as gc_advisor now ships.
  ins.run("GC 4060", "GC", "4060", "Package and Specialty Printing", "4", "In depth study of package printing.", '["GC 4061"]');
  ins.run("GC 4061", "GC", "4061", "Package and Specialty Printing Laboratory", "0", "Non-credit laboratory to accompany GC 4060.", '["GC 4060"]');
  // No coreq at all.
  ins.run("GC 3010", "GC", "3010", "Some Standalone Course", "3", "A course with no lab.", null);
  // Transitional-fallback path: coreq_parsed empty, but the lab's prose names its lecture.
  ins.run("GC 9990", "GC", "9990", "Legacy Lecture", "4", "A lecture whose lab predates the coreq backfill.", null);
  ins.run("GC 9991", "GC", "9991", "Legacy Lecture Laboratory", "0", "Non-credit laboratory to accompany GC 9990.", null);
  db.close();
}
process.env.GC_ADVISOR_DB = dbPath;

const { findCoreqs } = await import("../src/mcp-tools/catalog.ts");

test("a lecture returns its non-credit lab from the structured coreq_parsed column", () => {
  const c = findCoreqs("GC 4060");
  assert.equal(c.length, 1);
  assert.equal(c[0].code, "GC 4061");
  assert.equal(c[0].credits, "0");
  assert.equal(c[0].title, "Package and Specialty Printing Laboratory");
  assert.equal(c[0].relationship, "required non-credit lab (coreq)");
});

test("a lab returns the lecture it accompanies, tolerating messy input", () => {
  const c = findCoreqs("gc4061");
  assert.equal(c.length, 1);
  assert.equal(c[0].code, "GC 4060");
  assert.equal(c[0].credits, "4");
  assert.equal(c[0].relationship, "lecture this lab accompanies");
});

test("falls back to lab-description prose when coreq_parsed is empty", () => {
  const c = findCoreqs("GC 9990");
  assert.equal(c.length, 1);
  assert.equal(c[0].code, "GC 9991");
  assert.equal(c[0].relationship, "required non-credit lab (coreq)");
});

test("a course with no coreq returns an empty array", () => {
  assert.deepEqual(findCoreqs("GC 3010"), []);
});

test("a non-course string returns an empty array", () => {
  assert.deepEqual(findCoreqs("not a code"), []);
});
