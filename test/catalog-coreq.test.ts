import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

// Point config at a throwaway catalog DB before importing the tool module,
// since findCoreqCourse opens GC_ADVISOR_DB (read from config at call time).
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gc-coreq-")), "gc_advisor.db");
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE course (
    code TEXT PRIMARY KEY, subject TEXT NOT NULL, number TEXT NOT NULL,
    title TEXT, credits TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'active'
  );`);
  const ins = db.prepare(
    "INSERT INTO course (code, subject, number, title, credits, description) VALUES (?,?,?,?,?,?)",
  );
  ins.run("GC 4060", "GC", "4060", "Package and Specialty Printing", "4", "In depth study of package printing.");
  ins.run("GC 4061", "GC", "4061", "Package and Specialty Printing Laboratory", "0", "Non-credit laboratory to accompany GC 4060.");
  ins.run("GC 3010", "GC", "3010", "Some Standalone Course", "3", "A course with no lab.");
  db.close();
}
process.env.GC_ADVISOR_DB = dbPath;

const { findCoreqCourse } = await import("../src/mcp-tools/catalog.ts");

test("a GC lecture returns its required non-credit lab as coreq", () => {
  const c = findCoreqCourse("GC 4060");
  assert.equal(c?.code, "GC 4061");
  assert.equal(c?.credits, "0");
  assert.equal(c?.relationship, "required non-credit lab (coreq)");
});

test("a GC lab returns the lecture it accompanies, tolerating messy input", () => {
  const c = findCoreqCourse("gc4061");
  assert.equal(c?.code, "GC 4060");
  assert.equal(c?.credits, "4");
  assert.equal(c?.relationship, "lecture this lab accompanies");
});

test("a course with no pair returns null", () => {
  assert.equal(findCoreqCourse("GC 3010"), null);
});

test("a non-course string returns null", () => {
  assert.equal(findCoreqCourse("not a code"), null);
});
