// test/clemson-schedule-db.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-sched-"));
process.env.STATE_DIR = TMP;

const { writeScheduleDb, openScheduleDb, queryScheduleDb, getMeetingsForCrns, findConflicts } =
  await import("../src/clemson-schedule-db.ts");
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

const SNAP: ClemsonTermSnapshot = {
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: "2026-07-16T05:00:00.000Z",
  sectionCount: 2,
  sections: [
    {
      term: "202608",
      termDescription: "Fall 2026",
      crn: "80001",
      // Banner stores subject_course spaceless ("GC3010") — fixtures must match
      // real data, not "GC 3010" (that spaced assumption is exactly what hid the
      // subject-filter bug).
      subjectCourse: "GC3010",
      section: "001",
      title: "Graphic Comm Studio",
      campus: "Main",
      scheduleType: "Lecture",
      instructionalMethod: null,
      creditHours: 3,
      enrollment: 20,
      maxEnrollment: 30,
      seatsAvailable: 10,
      waitCount: 0,
      waitCapacity: 5,
      open: true,
      instructors: [{ name: "Tonkin, Chip", email: "chip@clemson.edu", primary: true }],
      meetings: [
        { days: "MWF", beginTime: "1115", endTime: "1205",
          building: "Jordan Hall", room: "G33", startDate: null, endDate: null, type: "Lecture" },
      ],
    },
    {
      term: "202608",
      termDescription: "Fall 2026",
      crn: "80002",
      subjectCourse: "GC3020",
      section: "001",
      title: "Print Technology",
      campus: "Main",
      scheduleType: "Lecture",
      instructionalMethod: null,
      creditHours: 3,
      enrollment: 15,
      maxEnrollment: 25,
      seatsAvailable: 10,
      waitCount: 0,
      waitCapacity: 5,
      open: true,
      instructors: [],
      meetings: [
        { days: "TR", beginTime: "1100", endTime: "1215",
          building: "Jordan Hall", room: "203", startDate: null, endDate: null, type: "Lecture" },
      ],
    },
  ],
};

test("writeScheduleDb creates a readable .db file", () => {
  writeScheduleDb(SNAP);
  const p = path.join(TMP, "clemson", "202608.db");
  assert.ok(fs.existsSync(p), ".db file should exist");
});

test("openScheduleDb returns null for missing term", () => {
  const db = openScheduleDb("999999");
  assert.equal(db, null);
});

test("queryScheduleDb returns all sections without filter", () => {
  const db = openScheduleDb("202608");
  assert.ok(db, "db should open");
  try {
    const result = queryScheduleDb(db, { term: "202608" });
    assert.equal(result.totalCount, 2);
    assert.equal(result.sections.length, 2);
    assert.equal(result.snapshotDate, "2026-07-16T05:00:00.000Z");
    assert.equal(result.scope, "snapshot");
  } finally {
    db.close();
  }
});

test("queryScheduleDb filters by subject and courseNumber", () => {
  const db = openScheduleDb("202608")!;
  try {
    // subject "GC" matches both GC 3010 and GC 3020
    const r1 = queryScheduleDb(db, { term: "202608", subject: "GC" });
    assert.equal(r1.totalCount, 2);
    // subject + courseNumber narrows to one
    const r2 = queryScheduleDb(db, { term: "202608", subject: "GC", courseNumber: "3010" });
    assert.equal(r2.totalCount, 1);
    assert.equal(r2.sections[0].crn, "80001");
  } finally {
    db.close();
  }
});

test("queryScheduleDb reconstructs meetings with MTWRFSU-ordered days string", () => {
  const db = openScheduleDb("202608")!;
  try {
    const result = queryScheduleDb(db, { term: "202608", subject: "GC", courseNumber: "3010" });
    const sec = result.sections[0];
    assert.equal(sec.meetings.length, 1);
    // MWF stored as 3 per-day rows; reconstructed in MTWRFSU order → "MWF"
    assert.equal(sec.meetings[0].days, "MWF");
    assert.equal(sec.meetings[0].beginTime, "1115");
    assert.equal(sec.meetings[0].endTime, "1205");
  } finally {
    db.close();
  }
});

test("getMeetingsForCrns returns per-day intervals", () => {
  const db = openScheduleDb("202608")!;
  try {
    const meetings = getMeetingsForCrns(db, "202608", ["80001"]);
    // MWF → 3 rows
    assert.equal(meetings.length, 3);
    assert.ok(meetings.every(m => m.crn === "80001"));
    assert.equal(meetings[0].startMin, 11 * 60 + 15); // 675
    assert.equal(meetings[0].endMin,   12 * 60 + 5);  // 725
  } finally {
    db.close();
  }
});

test("findConflicts detects no conflict on different days", () => {
  // 80001: MWF 1115-1205.  80002: TR 1100-1215.  No shared days → no conflict.
  const db = openScheduleDb("202608")!;
  try {
    const meetings = getMeetingsForCrns(db, "202608", ["80001", "80002"]);
    const conflicts = findConflicts(meetings);
    assert.equal(conflicts.length, 0, "different days → no conflict");
  } finally {
    db.close();
  }
});

test("findConflicts detects same-day overlap", () => {
  const conflicts = findConflicts([
    { crn: "AAA", day: "M", startMin: 600, endMin: 700, building: null, room: null },
    { crn: "BBB", day: "M", startMin: 650, endMin: 750, building: null, room: null },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].crn_a, "AAA");
  assert.equal(conflicts[0].crn_b, "BBB");
  assert.equal(conflicts[0].day, "M");
  assert.equal(conflicts[0].overlap_start, "1050"); // 650 min = 10h50m
  assert.equal(conflicts[0].overlap_end,   "1140"); // 700 min = 11h40m
});

test("writeScheduleDb is atomic — .tmp is gone after write", () => {
  const tmp = path.join(TMP, "clemson", "202608.db.tmp");
  assert.ok(!fs.existsSync(tmp), ".tmp file should not exist after successful write");
});
