import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

// Verification reads the real snapshot the advisor tools read. STATE_DIR is
// captured as a module const at import time, so it has to be set before the
// dynamic imports below. Pointing at the repo's own state/ (not cwd) is what
// makes the fixtures below exercise the real lookup path with real CRNs.
const REPO_STATE = path.resolve(import.meta.dirname, "../state");
process.env.STATE_DIR = REPO_STATE;

const SNAPSHOT = path.join(REPO_STATE, "clemson", "202608.db");
assert.ok(
  fs.existsSync(SNAPSHOT),
  `these tests verify against the real ${SNAPSHOT} snapshot; it is missing`,
);

const {
  createProposeScheduleTool,
  parseSchedule,
  renderSchedule,
  SCHEDULE_SCHEMA,
} = await import("../src/advisor-artifacts.ts");
const { verifySchedule } = await import("../src/advisor-schedule-verify.ts");
import type { CheckedSchedule } from "../src/advisor-schedule-verify.ts";

// Real 202608 records:
//   80773  GC1040-001  Graphic Communications I   4.0 cr  TR 1230-1345  Godfrey Hall 201
//   80763  GC1010-001  Orientation to GC          1.0 cr  F  1115-1205  Jordan Hall G33
//   80771  GC1020-001  Intro to Digital Graphics  2.0 cr  no meetings (async)
const VALID = JSON.stringify({
  term: "202608",
  notes: null,
  sections: [
    {
      crn: "80773",
      subjectCourse: "GC1040",
      section: "001",
      title: "Graphic Communications I",
      creditHours: 4,
      days: "TR",
      beginTime: "1230",
      endTime: "1345",
      building: "Godfrey Hall",
      room: "201",
    },
    {
      crn: "80763",
      subjectCourse: "GC1010",
      section: "001",
      title: "Orientation to Graphic Communications",
      creditHours: 1,
      days: "F",
      beginTime: "1115",
      endTime: "1205",
      building: "Jordan Hall",
      room: "G33",
    },
  ],
});

/** Deep-clone VALID and hand the copy to a mutator. */
function mutated(fn: (s: Record<string, any>) => void): string {
  const s = JSON.parse(VALID) as Record<string, any>;
  fn(s);
  return JSON.stringify(s);
}

const checked = (raw: string): CheckedSchedule => verifySchedule(parseSchedule(raw));

test("a valid payload parses into a schedule", () => {
  const s = parseSchedule(VALID);
  assert.equal(s.term, "202608");
  assert.equal(s.sections.length, 2);
  assert.equal(s.sections[0]!.crn, "80773");
});

// The whole point of schema-validated artifact turns: malformed model output is
// refused, not rendered into a document an advisor might hand to a student.
test("malformed output is rejected rather than rendered", () => {
  assert.throws(() => parseSchedule("not json"), /could not be parsed/);
  assert.throws(() => parseSchedule('{"term":"202608"}'), /missing sections/);
  assert.throws(
    () => parseSchedule('{"term":"202608","notes":null,"sections":[{"crn":"1"}]}'),
    /incomplete section/,
  );
});

test("wrongly typed fields are rejected rather than coerced", () => {
  // creditHours as a string would silently turn the credit total into string
  // concatenation ("33" for two 3-credit courses) on a printed document.
  const bad = JSON.parse(VALID) as { sections: { creditHours: unknown }[] };
  bad.sections[0]!.creditHours = "3";
  assert.throws(() => parseSchedule(JSON.stringify(bad)), /creditHours/);
  assert.throws(() => parseSchedule("[]"), /not an object/);
  assert.throws(
    () => parseSchedule('{"term":"","notes":null,"sections":[]}'),
    /missing term/,
  );
});

// ---------------------------------------------------------------------------
// Host-side verification against the real snapshot
// ---------------------------------------------------------------------------

test("a schedule whose sections all exist in the snapshot verifies", () => {
  const s = checked(VALID);
  assert.equal(s.sections.length, 2);
  // Not merely "did not throw": the snapshot's fetchedAt is the evidence that a
  // real snapshot was consulted, and null would mean it was not.
  assert.ok(
    s.verifiedAgainst && /^\d{4}-\d{2}-\d{2}T/.test(s.verifiedAgainst),
    `expected a snapshot timestamp, got ${String(s.verifiedAgainst)}`,
  );
});

// A model that fabricates a CRN believes it is correct, so only the host can
// catch this. Structure is fine here; truth is not.
test("a CRN that does not exist in the snapshot is refused", () => {
  assert.throws(
    () => checked(mutated((s) => { s.sections[0].crn = "99999"; })),
    /CRN 99999 does not exist in the 202608 schedule snapshot/,
  );
});

// A real CRN carrying fabricated times is just as harmful as an invented CRN.
test("a real CRN with wrong meeting times is refused", () => {
  assert.throws(
    () => checked(mutated((s) => { s.sections[0].beginTime = "0900";
                                   s.sections[0].endTime = "0950"; })),
    /CRN 80773: meeting time 0900-0950 does not match the 202608 snapshot/,
  );
});

test("a real CRN with wrong meeting days is refused", () => {
  assert.throws(
    () => checked(mutated((s) => { s.sections[0].days = "MWF"; })),
    /CRN 80773: meeting days "MWF" do not match/,
  );
});

test("a real CRN with wrong credit hours is refused", () => {
  assert.throws(
    () => checked(mutated((s) => { s.sections[0].creditHours = 3; })),
    /CRN 80773: creditHours 3 does not match the 202608 snapshot, which records 4/,
  );
});

test("a real CRN attached to the wrong course is refused", () => {
  assert.throws(
    () => checked(mutated((s) => { s.sections[0].subjectCourse = "GC4060"; })),
    /CRN 80773: subjectCourse "GC4060" does not match/,
  );
});

test("a real CRN with a fabricated room is refused", () => {
  assert.throws(
    () => checked(mutated((s) => { s.sections[0].room = "999"; })),
    /CRN 80773: room "999" does not match/,
  );
});

// Banner's spaceless subject_course and unordered day letters are formatting,
// not disagreement — refusing these would train the model to fight the checker.
test("spacing and day order are normalised rather than refused", () => {
  const s = checked(
    mutated((x) => { x.sections[0].subjectCourse = "GC 1040";
                     x.sections[0].days = "RT";
                     x.sections[0].beginTime = "12:30"; }),
  );
  assert.ok(s.verifiedAgainst);
});

// 45% of a term's sections have no meeting rows at all. The schema still forces
// non-empty day/time strings, so TBA is the only truthful answer — and claiming
// a time the snapshot does not have must still be refused.
test("an asynchronous section may say TBA but may not invent a time", () => {
  const async = (days: string, begin: string, end: string, bldg: string | null) =>
    JSON.stringify({
      term: "202608",
      notes: null,
      sections: [{ crn: "80771", subjectCourse: "GC1020", section: "001",
        title: "Introduction to Digital Graphics", creditHours: 2,
        days, beginTime: begin, endTime: end, building: bldg, room: null }],
    });
  assert.ok(checked(async("TBA", "TBA", "TBA", null)).verifiedAgainst);
  assert.throws(
    () => checked(async("MWF", "1000", "1050", null)),
    /CRN 80771: the 202608 snapshot records no meeting times/,
  );
  assert.throws(
    () => checked(async("TBA", "TBA", "TBA", "Godfrey Hall")),
    /CRN 80771: the 202608 snapshot records no meeting location/,
  );
});

// The decision for "no snapshot for that term": render, but visibly marked.
// Silently allowing it would make unverifiable look identical to verified;
// refusing outright would assert "this is wrong" with exactly the confidence we
// just said we do not have. Same reasoning as roomCapacity()'s null.
test("a term with no snapshot yields an unverified schedule, not a refusal", () => {
  assert.ok(!fs.existsSync(path.join(REPO_STATE, "clemson", "209999.db")));
  const s = checked(mutated((x) => { x.term = "209999"; }));
  assert.equal(s.verifiedAgainst, null);
  assert.equal(s.sections.length, 2);
});

test("an unverified document says so on its face; a verified one says that", () => {
  const unverified = renderSchedule(checked(mutated((x) => { x.term = "209999"; })));
  assert.match(unverified, /NOT VERIFIED/);
  assert.match(unverified, /class="unverified"/);
  assert.doesNotMatch(unverified, /checked\s*\nagainst the published/);

  const verified = renderSchedule(checked(VALID));
  assert.doesNotMatch(verified, /NOT VERIFIED/);
  assert.match(verified, /checked/);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("rendering produces a printable document with the section data", () => {
  const html = renderSchedule(checked(VALID));
  assert.match(html, /@media print/);
  assert.match(html, /GC1040/);
  assert.match(html, /12:30/);
  assert.match(html, /Godfrey Hall 201/);
  assert.match(html, /4 credits?/);
  // The disclaimer stays: it was never the control, but it is still true.
  assert.match(html, /Verify before\s*\nregistration/);
});

test("rendering escapes values rather than interpolating them raw", () => {
  // Titles are not verified against the snapshot, so they remain untrusted model
  // text reaching a page an advisor opens in a browser.
  const evil = mutated((s) => { s.sections[0].title = '<script>alert("x")</script>'; });
  const html = renderSchedule(checked(evil));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

// The structured output arrives as a tool call, not a response format: the tool
// parameters ARE the schedule, so this reuses the tool-calling path already
// verified on every provider rather than a runner-specific output mode.
test("the propose_schedule tool exposes the schema as its parameters", () => {
  const tool = createProposeScheduleTool({});
  assert.equal(tool.name, "propose_schedule");
  const schema = SCHEDULE_SCHEMA as { required: string[] };
  assert.deepEqual(schema.required, ["term", "sections", "notes"]);
});

test("calling the tool hands the verified schedule back to the host", async () => {
  const holder: { lastSchedule?: CheckedSchedule } = {};
  const tool = createProposeScheduleTool(holder);
  const result = await tool.execute("call-1", JSON.parse(VALID));
  assert.equal(holder.lastSchedule?.sections[0]!.crn, "80773");
  assert.ok(holder.lastSchedule?.verifiedAgainst);
  assert.match((result.content[0] as { text: string }).text, /verified/i);
});

// A refused call must leave nothing behind for /export/schedule to serve.
// Throwing is Pi's recoverable-tool-failure path: agent-loop turns it into an
// error tool result and the model gets a chance to correct its arguments.
test("a malformed tool call stores nothing and tells the model why", async () => {
  const holder: { lastSchedule?: CheckedSchedule } = {};
  const tool = createProposeScheduleTool(holder);
  await assert.rejects(
    () => tool.execute("call-1", { term: "202608" }),
    /missing sections/,
  );
  assert.equal(holder.lastSchedule, undefined);
});

test("a tool call with a hallucinated CRN stores nothing and names the CRN", async () => {
  const holder: { lastSchedule?: CheckedSchedule } = {};
  const tool = createProposeScheduleTool(holder);
  await assert.rejects(
    () => tool.execute("call-1", JSON.parse(mutated((s) => { s.sections[1].crn = "99999"; }))),
    /CRN 99999 does not exist/,
  );
  assert.equal(holder.lastSchedule, undefined);
});
