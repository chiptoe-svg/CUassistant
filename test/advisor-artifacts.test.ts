import assert from "node:assert/strict";
import test from "node:test";

import {
  createProposeScheduleTool,
  parseSchedule,
  renderSchedule,
  SCHEDULE_SCHEMA,
} from "../src/advisor-artifacts.ts";
import type { ProposedSchedule } from "../src/advisor-artifacts.ts";

const VALID = JSON.stringify({
  term: "202608",
  notes: null,
  sections: [
    {
      crn: "80833",
      subjectCourse: "GC4060",
      section: "001",
      title: "Advanced Packaging",
      creditHours: 3,
      days: "TR",
      beginTime: "1100",
      endTime: "1150",
      building: "Godfrey Hall",
      room: "201",
    },
  ],
});

test("a valid payload parses into a schedule", () => {
  const s = parseSchedule(VALID);
  assert.equal(s.term, "202608");
  assert.equal(s.sections.length, 1);
  assert.equal(s.sections[0]!.crn, "80833");
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

test("rendering produces a printable document with the section data", () => {
  const html = renderSchedule(parseSchedule(VALID));
  assert.match(html, /@media print/);
  assert.match(html, /GC4060/);
  assert.match(html, /11:00/);
  assert.match(html, /Godfrey Hall 201/);
  assert.match(html, /3 credits?/);
});

test("rendering escapes values rather than interpolating them raw", () => {
  const evil = JSON.parse(VALID) as { sections: { title: string }[] };
  evil.sections[0]!.title = '<script>alert("x")</script>';
  const html = renderSchedule(parseSchedule(JSON.stringify(evil)));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// The structured output arrives as a tool call, not a response format: the tool
// parameters ARE the schedule, so this reuses the tool-calling path already
// verified on every provider rather than a runner-specific output mode.
test("the propose_schedule tool exposes the schema as its parameters", () => {
  const tool = createProposeScheduleTool({});
  assert.equal(tool.name, "propose_schedule");
  const schema = SCHEDULE_SCHEMA as { required: string[] };
  assert.deepEqual(schema.required, ["term", "sections", "notes"]);
});

test("calling the tool hands the validated schedule back to the host", async () => {
  const holder: { lastSchedule?: ProposedSchedule } = {};
  const tool = createProposeScheduleTool(holder);
  const result = await tool.execute("call-1", JSON.parse(VALID));
  assert.equal(holder.lastSchedule?.sections[0]!.crn, "80833");
  assert.match(
    (result.content[0] as { text: string }).text,
    /schedule/i,
  );
});

// A refused call must leave nothing behind for /export/schedule to serve.
// Throwing is Pi's recoverable-tool-failure path: agent-loop turns it into an
// error tool result and the model gets a chance to correct its arguments.
test("a malformed tool call stores nothing and tells the model why", async () => {
  const holder: { lastSchedule?: ProposedSchedule } = {};
  const tool = createProposeScheduleTool(holder);
  await assert.rejects(
    () => tool.execute("call-1", { term: "202608" }),
    /missing sections/,
  );
  assert.equal(holder.lastSchedule, undefined);
});
