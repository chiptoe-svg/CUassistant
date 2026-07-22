import assert from "node:assert/strict";
import test from "node:test";

import { compactSearchResult } from "../src/mcp-tools/clemson-classes.ts";
import type {
  ClemsonSearchResult,
  ClemsonSection,
} from "../src/clemson-classes.ts";

function section(over: Partial<ClemsonSection> = {}): ClemsonSection {
  return {
    term: "202608",
    termDescription: "Fall 2026",
    crn: "12345",
    subjectCourse: "GC 1010",
    section: "001",
    title: "Intro",
    campus: "Main",
    scheduleType: "Lecture",
    instructionalMethod: "Traditional",
    creditHours: 3,
    enrollment: 20,
    maxEnrollment: 30,
    seatsAvailable: 10,
    waitCount: 0,
    waitCapacity: 0,
    open: true,
    instructors: [{ name: "Ada Lovelace", email: "ada@clemson.edu", primary: true }],
    meetings: [
      {
        days: "MWF",
        beginTime: "1325",
        endTime: "1415",
        building: "Daniel",
        room: "101",
        startDate: "2026-08-19",
        endDate: "2026-12-04",
        type: "Class",
      },
    ],
    ...over,
  };
}

function result(over: Partial<ClemsonSearchResult> = {}): ClemsonSearchResult {
  return {
    totalCount: 1,
    sections: [section()],
    snapshotDate: "2026-07-21",
    scope: "snapshot",
    ...over,
  };
}

test("hoists the row-constant term fields to the envelope", () => {
  const out = compactSearchResult(result());
  assert.equal(out.term, "202608");
  assert.equal(out.termDescription, "Fall 2026");
  const rows = out.sections as Record<string, unknown>[];
  assert.equal("term" in rows[0]!, false);
  assert.equal("termDescription" in rows[0]!, false);
});

test("omits zero waitlist fields, null fields, and empty arrays", () => {
  const out = compactSearchResult(
    result({
      sections: [section({ campus: null, instructors: [], meetings: [] })],
    }),
  );
  const row = (out.sections as Record<string, unknown>[])[0]!;
  assert.equal("waitCount" in row, false);
  assert.equal("waitCapacity" in row, false);
  assert.equal("campus" in row, false);
  assert.equal("instructors" in row, false);
  assert.equal("meetings" in row, false);
});

// Regression: waitCapacity varies per row (172 of 10,726 Fall 2026 sections
// carry a nonzero capacity). Hoisting it to the envelope — as one proposal
// suggested — would silently report those sections as having no waitlist.
test("keeps a nonzero waitCapacity on the row that owns it", () => {
  const out = compactSearchResult(
    result({
      totalCount: 2,
      sections: [
        section({ crn: "1", waitCapacity: 0 }),
        section({ crn: "2", waitCapacity: 5, waitCount: 2 }),
      ],
    }),
  );
  const rows = out.sections as Record<string, unknown>[];
  assert.equal("waitCapacity" in rows[0]!, false);
  assert.equal(rows[1]!.waitCapacity, 5);
  assert.equal(rows[1]!.waitCount, 2);
  assert.equal("waitCapacity" in out, false, "must not be hoisted");
});

// Regression: seatsAvailable:0 means FULL — the most decision-relevant value
// in the payload. A blanket "drop zeros" rule would erase it and make a full
// section indistinguishable from one with no reported seat count.
test("preserves seatsAvailable:0 so full sections stay distinguishable", () => {
  const out = compactSearchResult(
    result({ sections: [section({ seatsAvailable: 0, open: false })] }),
  );
  const row = (out.sections as Record<string, unknown>[])[0]!;
  assert.equal(row.seatsAvailable, 0);
  assert.equal(row.open, false);
});

test("flags truncation when fewer sections are returned than exist", () => {
  const out = compactSearchResult(result({ totalCount: 79 }));
  assert.equal(out.truncated, true);
  assert.match(String(out.hint), /1 of 79/);
});

test("does not flag truncation when the full set is returned", () => {
  const out = compactSearchResult(result({ totalCount: 1 }));
  assert.equal("truncated" in out, false);
  assert.equal("hint" in out, false);
});

test("empty result set does not invent term fields", () => {
  const out = compactSearchResult(result({ totalCount: 0, sections: [] }));
  assert.equal("term" in out, false);
  assert.deepEqual(out.sections, []);
});

// --- Encoding exhaustiveness -------------------------------------------------
//
// compactSearchResult omits fields, so every field needs a deliberate decision
// about what its absence means. The danger is not the fields below — those were
// reasoned about — it is the NEXT field someone adds, which would silently
// inherit the default with nobody deciding anything.
//
// This map is typed Record<keyof ClemsonSection, ...>, so adding a field to
// ClemsonSection without listing it here is a COMPILE ERROR, not a silent pass.
// The runtime tests then check the declared policy is what actually happens.
//
//   hoisted        - moved to the envelope; identical on every row
//   always         - never omitted; absence would be ambiguous or dangerous
//   omit-when-null - absent means "not reported"
//   omit-when-zero - absent means zero (only safe where zero IS "none")
type FieldPolicy = "hoisted" | "always" | "omit-when-null" | "omit-when-zero";

const FIELD_POLICY: Record<keyof ClemsonSection, FieldPolicy> = {
  term: "hoisted",
  termDescription: "hoisted",
  crn: "always",
  subjectCourse: "always",
  section: "always",
  title: "always",
  // 0 credits is a real value (1,497 Fall 2026 sections) — never omit on zero.
  creditHours: "omit-when-null",
  campus: "omit-when-null",
  scheduleType: "omit-when-null",
  instructionalMethod: "omit-when-null",
  // These four carry meaningful zeros. seatsAvailable:0 means FULL — omitting
  // it would make a full section look like one with no reported seat count.
  enrollment: "always",
  maxEnrollment: "always",
  seatsAvailable: "always",
  open: "always",
  // Zero here genuinely means "no waitlist", so absence is unambiguous.
  waitCount: "omit-when-zero",
  waitCapacity: "omit-when-zero",
  instructors: "omit-when-null",
  meetings: "omit-when-null",
};

test("every ClemsonSection field has a declared encoding policy", () => {
  // Compile-time coverage is enforced by the Record type above. This asserts
  // the map and a real section have not drifted apart at runtime.
  const declared = new Set(Object.keys(FIELD_POLICY));
  const actual = new Set(Object.keys(section()));
  assert.deepEqual(
    [...actual].filter((k) => !declared.has(k)),
    [],
    "ClemsonSection has a field with no declared encoding policy",
  );
  assert.deepEqual(
    [...declared].filter((k) => !actual.has(k)),
    [],
    "FIELD_POLICY declares a field that no longer exists",
  );
});

test("a fully-populated section keeps every non-hoisted field", () => {
  // Every field non-empty — the default fixture has a zero waitlist, which is
  // legitimately omitted, so it is not "fully populated" for this purpose.
  const out = compactSearchResult(
    result({ sections: [section({ waitCount: 3, waitCapacity: 5 })] }),
  );
  const row = (out.sections as Record<string, unknown>[])[0]!;
  for (const [field, policy] of Object.entries(FIELD_POLICY)) {
    assert.equal(
      field in row,
      policy !== "hoisted",
      `${field} (${policy}) wrong when populated`,
    );
  }
});

test("an empty section omits exactly the fields its policy allows", () => {
  const out = compactSearchResult(
    result({
      sections: [
        section({
          campus: null,
          scheduleType: null,
          instructionalMethod: null,
          creditHours: null,
          enrollment: 0,
          maxEnrollment: 0,
          seatsAvailable: 0,
          open: false,
          waitCount: 0,
          waitCapacity: 0,
          instructors: [],
          meetings: [],
        }),
      ],
    }),
  );
  const row = (out.sections as Record<string, unknown>[])[0]!;
  for (const [field, policy] of Object.entries(FIELD_POLICY)) {
    if (policy === "hoisted") continue;
    assert.equal(
      field in row,
      policy === "always",
      `${field} (${policy}) wrong when empty — "always" fields must survive`,
    );
  }
});
