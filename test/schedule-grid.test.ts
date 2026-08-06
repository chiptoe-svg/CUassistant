import assert from "node:assert/strict";
import test from "node:test";

import { parseHhmm, checkedScheduleToView } from "../src/schedule-grid.ts";
import type { CheckedSchedule } from "../src/advisor-schedule-verify.ts";

test("parseHhmm converts 4-digit Banner times to minutes; else null", () => {
  assert.equal(parseHhmm("1430"), 870);
  assert.equal(parseHhmm("0800"), 480);
  assert.equal(parseHhmm("TBA"), null);
  assert.equal(parseHhmm(""), null);
});

const SCHED: CheckedSchedule = {
  term: "202608",
  verifiedAgainst: "2026-08-01",
  notes: null,
  sections: [
    { crn: "80763", subjectCourse: "GC 1010", section: "001", title: "Orientation",
      creditHours: 1, days: "MWF", beginTime: "1430", endTime: "1545",
      building: "Godfrey", room: "201" },
    { crn: "88888", subjectCourse: "CU 1000", section: "005", title: "Connect",
      creditHours: 0, days: "", beginTime: "TBA", endTime: "TBA",
      building: null, room: null },
  ],
};

test("checkedScheduleToView maps sections, splits times, derives room + colorKey", () => {
  const view = checkedScheduleToView(SCHED);
  assert.equal(view.term, "202608");
  assert.equal(view.entries.length, 2);
  const gc = view.entries[0];
  assert.equal(gc.label, "GC 1010 001");
  assert.equal(gc.days, "MWF");
  assert.equal(gc.startMin, 870);
  assert.equal(gc.endMin, 945);
  assert.equal(gc.room, "Godfrey 201");
  assert.equal(gc.credits, 1);
  assert.equal(gc.colorKey, "GC");
  // Untimed section: no start/end, empty days preserved.
  const cu = view.entries[1];
  assert.equal(cu.startMin, undefined);
  assert.equal(cu.days, "");
});

import { gridBounds, findConflicts, renderScheduleGrid, scheduleGridHeightPx } from "../src/schedule-grid.ts";
import type { ScheduleView } from "../src/schedule-grid.ts";

const VIEW: ScheduleView = {
  term: "Fall 2026",
  entries: [
    { label: "GC 1010 001", days: "MWF", startMin: 870, endMin: 945, credits: 1, colorKey: "GC" }, // 14:30-15:45
    { label: "GC 1040 001", days: "TR", startMin: 750, endMin: 825, credits: 3, colorKey: "GC" },   // 12:30-13:45
    { label: "GC 1041 002", days: "T",  startMin: 780, endMin: 825, credits: 0, colorKey: "GC" },    // 13:00-13:45 (overlaps GC1040 on T)
    { label: "CU 1000 005", days: "",   credits: 0, colorKey: "CU" },                                 // untimed
  ],
};

test("gridBounds covers only used days and snaps to the hour", () => {
  const b = gridBounds(VIEW.entries);
  assert.deepEqual(b.days, ["M", "T", "W", "R", "F"]); // no S/U — unused
  assert.equal(b.startMin, 720); // 12:00 (floor of 12:30)
  assert.equal(b.endMin, 960);   // 16:00 (ceil of 15:45)
});

test("findConflicts flags the T overlap (GC 1040 vs GC 1041), nothing else", () => {
  const c = findConflicts(VIEW.entries);
  assert.ok(c.has(1) && c.has(2), "the two Tuesday-overlapping entries are flagged");
  assert.ok(!c.has(0), "GC 1010 does not conflict");
});

test("renderScheduleGrid is self-contained and places timed blocks + an unscheduled list", () => {
  const html = renderScheduleGrid(VIEW);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.doesNotMatch(html, /https?:\/\//, "no external URLs — must be self-contained");
  assert.match(html, /GC 1010 001/);
  assert.match(html, /Fall 2026/);
  // Untimed section shown separately, not on the grid.
  assert.match(html, /Unscheduled/);
  assert.match(html, /CU 1000 005/);
  // Conflict surfaced.
  assert.match(html, /conflict/i);
  // Credits caption: 1 + 3 + 0 + 0 = 4.
  assert.match(html, /4 credit/);
});

test("scheduleGridHeightPx grows with the time span", () => {
  const tall = scheduleGridHeightPx(VIEW);
  const shortView: ScheduleView = { term: "x", entries: [
    { label: "A 1 001", days: "M", startMin: 540, endMin: 600, colorKey: "A" }] };
  assert.ok(tall > scheduleGridHeightPx(shortView));
});
