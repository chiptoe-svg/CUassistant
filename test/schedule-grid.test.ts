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
