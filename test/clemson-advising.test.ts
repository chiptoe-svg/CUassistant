// test/clemson-advising.test.ts
//
// find-eligible-sections: requirement -> offered-sections join plus the
// scheduling-constraint filters (no_meeting_before, exclude_days,
// avoid_conflict_with, open_only, catalog_year). Uses a small hermetic
// fixture gc_advisor.db (mirrors the real schema — catalog_year, program,
// requirement_rule, course) rather than the live project DB, so this test
// doesn't drift when that project's data changes; the schedule DB is built
// the same way test/clemson-schedule-db.test.ts does.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-advising-"));
process.env.STATE_DIR = TMP;

const GC_DB_PATH = path.join(TMP, "gc_advisor.db");
process.env.GC_ADVISOR_DB = GC_DB_PATH;

const TERM = "202608";
const PROGRAM = "Graphic Communications, BS";
const SLOT = "Specialty Area Requirement";

function buildGcAdvisorFixture(): void {
  const db = new Database(GC_DB_PATH);
  db.exec(`
    CREATE TABLE catalog_year (
      id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, catoid INTEGER,
      level TEXT NOT NULL DEFAULT 'undergraduate', source_urls TEXT, ingested_at TEXT
    );
    CREATE TABLE program (
      id INTEGER PRIMARY KEY, catalog_year_id INTEGER NOT NULL REFERENCES catalog_year(id),
      poid INTEGER, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'major',
      degree TEXT, total_credits INTEGER, description TEXT, source_url TEXT, source_hash TEXT
    );
    CREATE TABLE requirement_rule (
      id INTEGER PRIMARY KEY, program_id INTEGER NOT NULL REFERENCES program(id),
      slot_type TEXT NOT NULL, rule TEXT NOT NULL
    );
    CREATE TABLE course (
      code TEXT PRIMARY KEY, subject TEXT NOT NULL, number TEXT NOT NULL,
      title TEXT, credits TEXT, description TEXT, prereq_text TEXT, prereq_parsed TEXT,
      coreq_text TEXT, coreq_parsed TEXT, terms_offered TEXT, restrictions TEXT,
      cross_listed_as TEXT, status TEXT NOT NULL DEFAULT 'active',
      first_seen TEXT, last_synced TEXT, source_url TEXT
    );
  `);

  db.prepare("INSERT INTO catalog_year (id, label, catoid) VALUES (?, ?, ?)").run(1, "2024-2025", 100);
  db.prepare("INSERT INTO catalog_year (id, label, catoid) VALUES (?, ?, ?)").run(2, "2025-2026", 101);

  db.prepare(
    "INSERT INTO program (id, catalog_year_id, poid, name, kind) VALUES (?, ?, ?, ?, 'major')",
  ).run(1, 1, 500, PROGRAM); // 2024-2025 — older catalog
  db.prepare(
    "INSERT INTO program (id, catalog_year_id, poid, name, kind) VALUES (?, ?, ?, ?, 'major')",
  ).run(2, 2, 501, PROGRAM); // 2025-2026 — latest

  const insertRule = db.prepare(
    "INSERT INTO requirement_rule (program_id, slot_type, rule) VALUES (?, ?, ?)",
  );
  // Old catalog year: 2 eligible courses, 6 credits.
  insertRule.run(
    1,
    SLOT,
    JSON.stringify({
      slot_type: SLOT,
      total_credits: 6,
      explicit_courses: ["GC 3010", "GC 3020"],
      raw_text: "old catalog rule",
    }),
  );
  // Latest catalog year: 4 eligible courses (incl. an async one), 12 credits.
  insertRule.run(
    2,
    SLOT,
    JSON.stringify({
      slot_type: SLOT,
      total_credits: 12,
      explicit_courses: ["GC 3010", "GC 3020", "GC 3030", "GC 3040"],
      raw_text: "latest catalog rule",
    }),
  );

  const insertCourse = db.prepare(
    "INSERT INTO course (code, subject, number, prereq_text, prereq_parsed) VALUES (?, ?, ?, ?, ?)",
  );
  for (const code of ["GC 3010", "GC 3020", "GC 3030", "GC 3040"]) {
    insertCourse.run(code, "GC", code.split(" ")[1], null, null);
  }

  db.close();
}
buildGcAdvisorFixture();

const { writeScheduleDb } = await import("../src/clemson-schedule-db.ts");
const { findEligibleSections, findSectionsBySchedule } = await import(
  "../src/mcp-tools/clemson-advising.ts"
);
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

function meeting(days: string, beginTime: string, endTime: string) {
  return {
    days,
    beginTime,
    endTime,
    building: "Lee Hall",
    room: "100",
    roomCapacity: null,
    startDate: null,
    endDate: null,
    type: "Lecture",
  };
}

const SNAP: ClemsonTermSnapshot = {
  term: TERM,
  termDescription: "Fall 2026",
  fetchedAt: "2026-07-20T05:00:00.000Z",
  sectionCount: 0,
  sections: [
    // GC3010-001: Friday meeting — excluded by exclude_days:["F"].
    {
      term: TERM, termDescription: "Fall 2026", crn: "90001", subjectCourse: "GC3010",
      section: "001", title: "Studio A", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("F", "1000", "1050")],
    },
    // GC3010-002: pre-9:00 Monday meeting — excluded by no_meeting_before:"0900".
    {
      term: TERM, termDescription: "Fall 2026", crn: "90002", subjectCourse: "GC3010",
      section: "002", title: "Studio B", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "0800", "0850")],
    },
    // GC3020-001: 9:00+ Monday meeting — kept under no_meeting_before:"0900".
    {
      term: TERM, termDescription: "Fall 2026", crn: "90003", subjectCourse: "GC3020",
      section: "001", title: "Print Systems", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "0900", "0950")],
    },
    // GC3020-002: conflicts with the student's current CRN 90010 (10:30-11:30
    // overlaps 10:00-11:00) — excluded by avoid_conflict_with:["90010"].
    {
      term: TERM, termDescription: "Fall 2026", crn: "90004", subjectCourse: "GC3020",
      section: "002", title: "Print Systems Lab", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1000", "1100")],
    },
    // GC3030-001: back-to-back (11:00-12:00) with current CRN 90011
    // (12:00-13:00) — adjacent boundary, must NOT be excluded.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90005", subjectCourse: "GC3030",
      section: "001", title: "Color Theory", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1100", "1200")],
    },
    // GC3030-002: full — excluded by open_only:true.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90006", subjectCourse: "GC3030",
      section: "002", title: "Color Theory Lab", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 20, maxEnrollment: 20,
      seatsAvailable: 0, waitCount: 0, waitCapacity: 0, open: false, instructors: [],
      meetings: [meeting("T", "1300", "1350")],
    },
    // GC3040-001: zero-meeting async section (no meetings array entries).
    {
      term: TERM, termDescription: "Fall 2026", crn: "90007", subjectCourse: "GC3040",
      section: "001", title: "Async Elective", campus: "Main", scheduleType: "Online",
      instructionalMethod: "DE", creditHours: 3, enrollment: 5, maxEnrollment: 20,
      seatsAvailable: 15, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [],
    },
    // Not in any explicit_courses list — represents the student's own current
    // schedule (avoid_conflict_with input), not a candidate section.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90010", subjectCourse: "MATH1060",
      section: "001", title: "Trig", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 5, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1030", "1130")],
    },
    {
      term: TERM, termDescription: "Fall 2026", crn: "90011", subjectCourse: "MATH1080",
      section: "001", title: "Calc", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 5, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("M", "1200", "1300")],
    },
    // ENGL1010-001: MWF 12:20-13:10, 3 credits, open seats — target match for
    // find-sections-by-schedule's credits+days_within+starts_at test. Not in
    // any explicit_courses list, so it's invisible to find-eligible-sections.
    {
      term: TERM, termDescription: "Fall 2026", crn: "90020", subjectCourse: "ENGL1010",
      section: "001", title: "Composition", campus: "Main", scheduleType: "Lecture",
      instructionalMethod: null, creditHours: 3, enrollment: 10, maxEnrollment: 20,
      seatsAvailable: 10, waitCount: 0, waitCapacity: 0, open: true, instructors: [],
      meetings: [meeting("MWF", "1220", "1310")],
    },
  ],
};
SNAP.sectionCount = SNAP.sections.length;
writeScheduleDb(SNAP);

async function call(args: Record<string, unknown>) {
  const res = await findEligibleSections.handler(args);
  assert.notEqual(res.isError, true, (res.content[0] as { text: string }).text);
  return JSON.parse((res.content[0] as { text: string }).text) as {
    sections: Array<{ crn: string; [k: string]: unknown }>;
    sections_without_meetings?: Array<{ crn: string; [k: string]: unknown }>;
    applied_constraints: Record<string, unknown>;
    total_credits_required: number;
  };
}

const BASE_ARGS = { term: TERM, slot_type: SLOT, completed_courses: [] as string[] };

test("no constraints given -> identical to today's behavior (regression guard)", async () => {
  const out = await call({ ...BASE_ARGS });
  // Latest catalog year (2025-2026) is used by default; all 4 sections present,
  // no filtering, no sections_without_meetings field at all.
  const crns = out.sections.map((s) => s.crn).sort();
  assert.deepEqual(crns, ["90001", "90002", "90003", "90004", "90005", "90006", "90007"]);
  assert.equal(out.total_credits_required, 12);
  assert.equal("sections_without_meetings" in out, false);
  assert.deepEqual(out.applied_constraints, {});
});

test("exclude_days excludes a Friday-meeting section", async () => {
  const out = await call({ ...BASE_ARGS, exclude_days: ["F"] });
  const crns = out.sections.map((s) => s.crn);
  assert.ok(!crns.includes("90001"), "Friday section 90001 should be excluded");
  assert.ok(crns.includes("90002"), "non-Friday section 90002 should remain");
});

test("no_meeting_before excludes a pre-9:00 section and keeps a 9:00+ one", async () => {
  const out = await call({ ...BASE_ARGS, no_meeting_before: "0900" });
  const crns = out.sections.map((s) => s.crn);
  assert.ok(!crns.includes("90002"), "0800 section should be excluded");
  assert.ok(crns.includes("90003"), "0900 section should be kept");
});

test("avoid_conflict_with excludes a section that overlaps a current-schedule CRN", async () => {
  const out = await call({ ...BASE_ARGS, avoid_conflict_with: ["90010"] });
  const crns = out.sections.map((s) => s.crn);
  assert.ok(!crns.includes("90004"), "90004 (10:00-11:00) overlaps current 90010 (10:30-11:30)");
});

test("avoid_conflict_with keeps a section that is only adjacent (touching boundary) to a current-schedule CRN", async () => {
  // 90005 (Monday 11:00-12:00) touches current 90011 (Monday 12:00-13:00)
  // exactly at the boundary — findConflicts' half-open interval semantics
  // mean this is NOT a conflict. (90005 is deliberately not checked against
  // 90010 here — it does overlap 90010's 10:30-11:30 window — this test
  // isolates the adjacent-boundary case.)
  const out = await call({ ...BASE_ARGS, avoid_conflict_with: ["90011"] });
  const crns = out.sections.map((s) => s.crn);
  assert.ok(crns.includes("90005"), "90005 (11:00-12:00) is adjacent to current 90011 (12:00-13:00), not a conflict");
});

test("open_only excludes a seats_available<=0 section", async () => {
  const out = await call({ ...BASE_ARGS, open_only: true });
  const crns = out.sections.map((s) => s.crn);
  assert.ok(!crns.includes("90006"), "full section 90006 should be excluded");
  assert.ok(crns.includes("90005"), "open section 90005 should remain");
});

test("zero-meeting async section with a time/day constraint lands in sections_without_meetings, not sections, not dropped", async () => {
  const out = await call({ ...BASE_ARGS, no_meeting_before: "0900" });
  const sectionCrns = out.sections.map((s) => s.crn);
  assert.ok(!sectionCrns.includes("90007"), "async section must not be in sections");
  assert.ok(out.sections_without_meetings, "sections_without_meetings must be present");
  const asyncCrns = out.sections_without_meetings!.map((s) => s.crn);
  assert.ok(asyncCrns.includes("90007"), "async section must be surfaced, not silently dropped");
  const asyncEntry = out.sections_without_meetings!.find((s) => s.crn === "90007")!;
  assert.equal(typeof asyncEntry.note, "string");
});

test("zero-meeting async section with NO time/day constraint goes in sections normally", async () => {
  const out = await call({ ...BASE_ARGS, open_only: true });
  const crns = out.sections.map((s) => s.crn);
  assert.ok(crns.includes("90007"), "async section belongs in sections when no time/day constraint given");
  assert.equal("sections_without_meetings" in out, false);
});

test("catalog_year selects the older program/rule instead of latest", async () => {
  const out = await call({ ...BASE_ARGS, catalog_year: "2024-2025" });
  assert.equal(out.total_credits_required, 6);
  const crns = out.sections.map((s) => s.crn).sort();
  // Old catalog's explicit_courses is only GC3010/GC3020 (no GC3030/GC3040).
  assert.deepEqual(crns, ["90001", "90002", "90003", "90004"]);
  assert.equal(out.applied_constraints.catalog_year, "2024-2025");
});

test("unknown catalog_year returns a clear error", async () => {
  const res = await findEligibleSections.handler({ ...BASE_ARGS, catalog_year: "1999-2000" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /not found for catalog year/);
});

test("invalid no_meeting_before format returns a clear error", async () => {
  const res = await findEligibleSections.handler({ ...BASE_ARGS, no_meeting_before: "9am" });
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /HHMM/);
});

test("applied_constraints echoes back exactly what was passed", async () => {
  const out = await call({ ...BASE_ARGS, exclude_days: ["f"], open_only: true });
  // normalized to uppercase
  assert.deepEqual(out.applied_constraints.exclude_days, ["F"]);
  assert.equal(out.applied_constraints.open_only, true);
});

// ---------------------------------------------------------------------------
// find-sections-by-schedule — schedule-fit search with no subject/requirement
// required. Reuses the same schedule DB fixture written above (no gc_advisor
// join at all).
// ---------------------------------------------------------------------------

async function callSchedule(args: Record<string, unknown>) {
  const res = await findSectionsBySchedule.handler(args);
  return {
    res,
    body: res.isError
      ? null
      : (JSON.parse((res.content[0] as { text: string }).text) as {
          total_matched: number;
          sections: Array<{ crn: string; [k: string]: unknown }>;
          note?: string;
          applied_constraints: Record<string, unknown>;
        }),
  };
}

test("find-sections-by-schedule: missing bounding constraint returns a clear error", async () => {
  const { res } = await callSchedule({ term: TERM });
  assert.equal(res.isError, true);
  assert.match(
    (res.content[0] as { text: string }).text,
    /at least one bounding constraint/,
  );
});

test("find-sections-by-schedule: credits + days_within + starts_at matches the MWF 12:20 section", async () => {
  const { body } = await callSchedule({
    term: TERM,
    credits: 3,
    days_within: "MWF",
    starts_at: "1220",
  });
  assert.ok(body);
  const crns = body!.sections.map((s) => s.crn);
  assert.ok(crns.includes("90020"), "ENGL1010 MWF 12:20 section should match");
});

test("find-sections-by-schedule: open_only excludes a zero-seat section", async () => {
  const { body } = await callSchedule({ term: TERM, credits: 3, open_only: true });
  assert.ok(body);
  const crns = body!.sections.map((s) => s.crn);
  assert.ok(!crns.includes("90006"), "full section 90006 should be excluded by open_only");
});

test("find-sections-by-schedule: a section on a day outside days_within is excluded", async () => {
  const { body } = await callSchedule({ term: TERM, credits: 3, days_within: "MW" });
  assert.ok(body);
  const crns = body!.sections.map((s) => s.crn);
  assert.ok(!crns.includes("90001"), "Friday-only section 90001 does not fit days_within 'MW'");
  assert.ok(crns.includes("90003"), "Monday-only section 90003 fits days_within 'MW'");
});

test("find-sections-by-schedule: a time/day query excludes async (no-meeting) sections and reports the count in a note", async () => {
  const { body } = await callSchedule({ term: TERM, credits: 3, days_within: "MWF" });
  assert.ok(body);
  const sectionCrns = body!.sections.map((s) => s.crn);
  assert.ok(!sectionCrns.includes("90007"), "async section can't fit a day/time slot — excluded from sections");
  assert.equal("sections_without_meetings" in body!, false, "no async pile is returned for a time query");
  assert.match(body!.note ?? "", /async/i, "the excluded async count is surfaced in a note");
});
