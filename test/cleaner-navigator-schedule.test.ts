import assert from "node:assert/strict";
import test from "node:test";

import { navigatorScheduleModule } from "../advisor/cleaner/modules/navigator-schedule.js";

// A trimmed copy of a real Clemson Navigator schedule paste: a multi-line block
// per course, dash-delimited codes, a tab before the instructor, and days/times
// + room lines.
const SAMPLE = [
  "COURSE\tPROFESSOR\tDAYS/TIMES\tMID\tFINAL",
  "",
  "ACCT-2020-001-LEC Managerial Accounting Concepts\tDavid Garrison",
  "Begins on 08/19/2026",
  "",
  "08/19/2026 - 12/11/2026",
  "MW 2:30pm - 3:45pm ET",
  "TILLMN-160\t\t",
  "",
  "GC-1041-002-LWF Graphic Com I Lab\tCarla Marchione",
  "Begins on 08/19/2026",
  "",
  "08/19/2026 - 12/11/2026",
  "TR 8:00am - 10:45am ET",
  "GODFRY-105A\t\t",
].join("\n");

test("detect() recognizes a Navigator paste and not a plain question", () => {
  assert.equal(navigatorScheduleModule.detect(SAMPLE), true);
  assert.equal(navigatorScheduleModule.detect("What are the GC 4061 conflicts?"), false);
});

test("extracts code, title, instructor, days/times, and room per course", () => {
  const out = navigatorScheduleModule.clean(SAMPLE);
  assert.equal(out.schema, "navigator-schedule-v1");
  assert.equal(out.sanitized.courses.length, 2);

  const acct = out.sanitized.courses[0];
  assert.equal(acct.code, "ACCT 2020 001");
  assert.equal(acct.type, "LEC");
  assert.equal(acct.title, "Managerial Accounting Concepts");
  assert.equal(acct.instructor, "David Garrison");
  assert.equal(acct.days, "MW");
  assert.equal(acct.time, "2:30pm - 3:45pm ET");
  assert.equal(acct.room, "TILLMN-160");
  assert.equal(acct.dates, "08/19/2026 - 12/11/2026");

  const lab = out.sanitized.courses[1];
  assert.equal(lab.code, "GC 1041 002");
  assert.equal(lab.type, "LWF");
  assert.equal(lab.room, "GODFRY-105A");
});

test("emits a Markdown table with days/times and room columns", () => {
  const out = navigatorScheduleModule.clean(SAMPLE);
  assert.match(out.markdown, /\| Code \| Title \| Days\/Times \| Room \| Instructor \|/);
  assert.match(out.markdown, /\| ACCT 2020 001 \| Managerial Accounting Concepts \| MW 2:30pm - 3:45pm ET \| TILLMN-160 \| David Garrison \|/);
  // The header/"Begins on" noise must not survive.
  assert.ok(!out.markdown.includes("Begins on"), "Navigator boilerplate leaked");
  assert.ok(!out.markdown.includes("PROFESSOR"), "header row leaked");
});
