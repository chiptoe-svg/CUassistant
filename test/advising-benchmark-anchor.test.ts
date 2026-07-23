// test/advising-benchmark-anchor.test.ts
//
// Unit tests for scripts/advising-benchmark/scenarios.ts. Per the discipline
// this module inherits from scripts/fabrication-probe.ts: these tests assert
// LOGIC and instrument honesty, not brittle live values. Where a live value IS
// asserted (S2/S3/S4's expected answer sets), it is computed independently in
// the test by reading the same DB the anchor reads — never hardcoded — so a
// legitimate schedule change moves the expectation instead of breaking the
// test.
//
// This file exercises the REAL state/clemson/202608.db snapshot and (for the
// live S5 case) the REAL gc_advisor query.py subprocess — both are read-only,
// local and offline, matching Task 1's "no network / no model endpoints"
// constraint. Every such test is `skip`-guarded so a machine without the
// snapshot or without gc_advisor checked out still runs the pure-logic tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import {
  findConflicts,
  getMeetingsForCrns,
  openScheduleDb,
  type MeetingInterval,
} from "../src/clemson-schedule-db.ts";
import { GC_ADVISOR_DB } from "../src/config.ts";
import {
  anchorS1,
  anchorS2,
  anchorS3,
  anchorS4,
  anchorS5,
  classifySuggestion,
  crnsConflict,
  describeS2,
  explicitCourseUnion,
  S1_CRN,
  S2_COURSE,
  S3_ANCHOR_CRN,
  S3_CANDIDATES,
  S4_ALT_LAB_CRNS,
  S4_CURRENT_LAB_CRN,
  S4_TARGET_CRN,
  SCENARIOS,
  TERM,
  timeDayStatus,
} from "../scripts/advising-benchmark/scenarios.ts";

function hasSnapshot(term: string): boolean {
  const db = openScheduleDb(term);
  if (!db) return false;
  db.close();
  return true;
}

const SNAPSHOT_AVAILABLE = hasSnapshot(TERM);
const GC_ADVISOR_AVAILABLE = fs.existsSync(GC_ADVISOR_DB);

function mi(crn: string, day: string, startMin: number, endMin: number): MeetingInterval {
  return { crn, day, startMin, endMin, building: null, room: null };
}

// ---------------------------------------------------------------------------
// Scenario data sanity
// ---------------------------------------------------------------------------

describe("scenario definitions", () => {
  it("defines exactly S1-S5, all at term 202608", () => {
    assert.deepEqual(
      SCENARIOS.map((s) => s.id),
      ["S1", "S2", "S3", "S4", "S5"],
    );
    for (const s of SCENARIOS) assert.equal(s.term, TERM);
  });

  it("S3/S4/S5 carry the real advising-profile fixture with the CRN cruft intact", () => {
    for (const id of ["S3", "S4", "S5"]) {
      const s = SCENARIOS.find((x) => x.id === id)!;
      assert.ok(s.fixture, `${id} must carry a fixture`);
      // The screen-reader cruft glued to the CRN — the whole point of S3's
      // robustness sub-check. If this ever reads as clean, the fixture was
      // "tidied up" and the test coverage it exists for is gone.
      assert.match(s.fixture!, /80833Press enter key to view/);
      assert.match(s.fixture!, /83845Press enter key to view/);
    }
  });

  it("S1/S2 do not carry a fixture (they are natural-key questions, not paste-parsing ones)", () => {
    assert.equal(SCENARIOS.find((s) => s.id === "S1")!.fixture, undefined);
    assert.equal(SCENARIOS.find((s) => s.id === "S2")!.fixture, undefined);
  });
});

// ---------------------------------------------------------------------------
// Conflict primitive — reused from src/clemson-schedule-db.ts. These assert
// the semantics the whole anchor depends on directly, with synthetic data, so
// no live snapshot is required.
// ---------------------------------------------------------------------------

describe("conflict primitive (reused findConflicts)", () => {
  it("overlapping same-day meetings conflict", () => {
    const conflicts = findConflicts([mi("A", "T", 660, 710), mi("B", "T", 700, 750)]);
    assert.equal(conflicts.length, 1);
  });

  it("disjoint same-day meetings do not conflict", () => {
    const conflicts = findConflicts([mi("A", "T", 660, 710), mi("B", "T", 800, 850)]);
    assert.equal(conflicts.length, 0);
  });

  it("adjacent meetings (10:45 end vs 11:00 start) do not conflict", () => {
    // 8:00-10:45 then 10:45-11:40 — half-open interval, the shared boundary
    // is not an overlap.
    const conflicts = findConflicts([mi("A", "T", 480, 645), mi("B", "T", 645, 700)]);
    assert.equal(conflicts.length, 0);
  });

  it("same time, different day, does not conflict", () => {
    const conflicts = findConflicts([mi("A", "M", 660, 710), mi("B", "T", 660, 710)]);
    assert.equal(conflicts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// S1
// ---------------------------------------------------------------------------

describe("anchorS1", () => {
  it(
    "resolves credit hours and seats for CRN 80822 from the live snapshot",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS1();
      assert.equal(res.status, "resolved");
      if (res.status !== "resolved") return;
      assert.equal(typeof res.value.creditHours, "number");
      assert.equal(typeof res.value.seatsAvailable, "number");
      assert.ok(res.fetchedAt.length > 0);
    },
  );

  it(
    "a bogus CRN is UNAVAILABLE, never a resolved (and therefore judgeable) value",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS1({ crn: "00000" });
      assert.equal(res.status, "unavailable");
      if (res.status === "unavailable") assert.match(res.reason, /not found/);
    },
  );
});

// ---------------------------------------------------------------------------
// S2
// ---------------------------------------------------------------------------

describe("anchorS2", () => {
  it(
    `resolves the ${S2_COURSE} T/R 11:00 ambiguity to exactly the live section count`,
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS2();
      assert.equal(res.status, "resolved");
      if (res.status !== "resolved") return;

      // Recompute independently from the same DB rather than hardcoding "2".
      const db = openScheduleDb(TERM)!;
      try {
        const rows = db
          .prepare(
            `select distinct s.crn as crn
               from sections s join meetings m on m.crn = s.crn and m.term = s.term
              where s.term = ? and s.subject_course = ? and m.day in ('T','R') and m.start_min = 660`,
          )
          .all(TERM, S2_COURSE) as { crn: string }[];
        assert.deepEqual([...res.value.crns].sort(), rows.map((r) => r.crn).sort());
        assert.equal(res.value.count, rows.length);
      } finally {
        db.close();
      }

      assert.match(describeS2(res.value), /^ambiguous \(\d+ sections?: /);
    },
  );

  it(
    "a slot with no matching section is UNAVAILABLE, not a false zero",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS2({ course: "GC4060", startMin: 1 }); // 00:01 — no section meets then
      assert.equal(res.status, "unavailable");
    },
  );
});

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

describe("anchorS3", () => {
  it(
    "returns exactly the live no-conflict set, computed independently in-test",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS3();
      assert.equal(res.status, "resolved");
      if (res.status !== "resolved") return;

      const db = openScheduleDb(TERM)!;
      try {
        const expectedFits: string[] = [];
        const expectedConflicts: string[] = [];
        for (const course of S3_CANDIDATES) {
          const crn = res.value.byCourseCrn[course];
          assert.ok(crn, `${course} should have resolved to a CRN`);
          if (crnsConflict(db, TERM, S3_ANCHOR_CRN, crn!)) expectedConflicts.push(course);
          else expectedFits.push(course);
        }
        assert.deepEqual([...res.value.fits].sort(), expectedFits.sort());
        assert.deepEqual([...res.value.conflicts].sort(), expectedConflicts.sort());
        // Sanity: the candidate set partitions completely, nothing dropped.
        assert.equal(res.value.fits.length + res.value.conflicts.length, S3_CANDIDATES.length);
      } finally {
        db.close();
      }
    },
  );

  it(
    "an unresolvable anchor CRN is UNAVAILABLE",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS3({ anchorCrn: "00000" });
      assert.equal(res.status, "unavailable");
      if (res.status === "unavailable") assert.match(res.reason, /not found/);
    },
  );

  it(
    "a candidate course with zero or multiple 202608 sections is UNAVAILABLE, not guessed",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS3({ candidates: ["GC9999XX"] });
      assert.equal(res.status, "unavailable");
      if (res.status === "unavailable") assert.match(res.reason, /found 0/);
    },
  );
});

// ---------------------------------------------------------------------------
// S4
// ---------------------------------------------------------------------------

describe("anchorS4", () => {
  it(
    "identifies the MW alternate lab sections as the sections that free the add",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS4();
      assert.equal(res.status, "resolved");
      if (res.status !== "resolved") return;

      const db = openScheduleDb(TERM)!;
      try {
        const expectedCurrentConflicts = crnsConflict(db, TERM, S4_CURRENT_LAB_CRN, S4_TARGET_CRN);
        const expectedFreeing = S4_ALT_LAB_CRNS.filter(
          (crn) => !crnsConflict(db, TERM, crn, S4_TARGET_CRN),
        );
        assert.equal(res.value.currentConflicts, expectedCurrentConflicts);
        assert.deepEqual([...res.value.freeingSections].sort(), expectedFreeing.sort());
      } finally {
        db.close();
      }

      // The flagship behaviour the spec names: the current section conflicts,
      // and at least one alternate frees it, per the current snapshot.
      assert.equal(res.value.currentConflicts, true);
      assert.ok(res.value.freeingSections.length > 0);
    },
  );

  it(
    "an unresolvable target CRN is UNAVAILABLE",
    { skip: SNAPSHOT_AVAILABLE ? false : "no live 202608 snapshot" },
    () => {
      const res = anchorS4({ targetCrn: "00000" });
      assert.equal(res.status, "unavailable");
      if (res.status === "unavailable") assert.match(res.reason, /not found/);
    },
  );
});

// ---------------------------------------------------------------------------
// S5 — explicitCourseUnion shape handling (pure logic, no live data needed)
// ---------------------------------------------------------------------------

describe("explicitCourseUnion", () => {
  it("unions explicit_courses across only the two target slot types", () => {
    const rows = [
      {
        slot_type: "Specialty Area Requirement",
        rule: { slot_type: "Specialty Area Requirement", explicit_courses: ["GC 3720", "ART 1030"] },
      },
      {
        slot_type: "Graphic Communication Technical Requirement",
        rule: {
          slot_type: "Graphic Communication Technical Requirement",
          explicit_courses: ["GC 3600", "GC 3720"],
        },
      },
      {
        slot_type: "Approved Laboratory Science Requirement",
        rule: { slot_type: "Approved Laboratory Science Requirement", explicit_courses: ["CH 1010"] },
      },
    ];
    const union = explicitCourseUnion(rows);
    assert.ok(union);
    assert.deepEqual([...union!].sort(), ["ART1030", "GC3600", "GC3720"]);
    assert.ok(!union!.has("CH1010"), "a non-target slot type must not leak into the union");
  });

  it("returns null (not an empty set) when the top-level shape is not an array", () => {
    assert.equal(explicitCourseUnion({ not: "an array" }), null);
    assert.equal(explicitCourseUnion(null), null);
    assert.equal(explicitCourseUnion("oops"), null);
  });

  it("returns null when a MATCHING slot type's rule is missing explicit_courses", () => {
    const rows = [{ slot_type: "Specialty Area Requirement", rule: { slot_type: "Specialty Area Requirement" } }];
    assert.equal(explicitCourseUnion(rows), null);
  });

  it("returns an empty (not null) set when every row is present but none match the target slot types", () => {
    const rows = [
      {
        slot_type: "Approved Laboratory Science Requirement",
        rule: { slot_type: "Approved Laboratory Science Requirement", explicit_courses: ["CH 1010"] },
      },
    ];
    const union = explicitCourseUnion(rows);
    assert.ok(union);
    assert.equal(union!.size, 0);
  });
});

// ---------------------------------------------------------------------------
// S5 — timeDayStatus is three-valued, on purpose. A zero-meeting section is
// `undetermined`, never assumed `clear` — "no meeting recorded" cannot
// distinguish genuine async from a data gap. Pure synthetic data, no live
// snapshot required.
// ---------------------------------------------------------------------------

describe("timeDayStatus", () => {
  it("zero meeting rows is undetermined, NOT clear", () => {
    assert.equal(timeDayStatus([]), "undetermined");
  });

  it("every meeting at/after 9:00 and never on Friday is clear", () => {
    const meetings = [mi("A", "T", 660, 710), mi("A", "R", 660, 710)];
    assert.equal(timeDayStatus(meetings), "clear");
  });

  it("a meeting before 9:00 violates, even alongside otherwise-clear meetings", () => {
    const meetings = [mi("A", "M", 480, 530), mi("A", "W", 660, 710)]; // 8:00 Monday
    assert.equal(timeDayStatus(meetings), "violates");
  });

  it("a Friday meeting violates, even alongside otherwise-clear meetings", () => {
    const meetings = [mi("A", "T", 660, 710), mi("A", "F", 660, 710)];
    assert.equal(timeDayStatus(meetings), "violates");
  });
});

// ---------------------------------------------------------------------------
// S5 — anchor + classifier, against the REAL gc_advisor process and REAL
// snapshot. Skipped where either is unavailable.
// ---------------------------------------------------------------------------

describe("anchorS5 (live gc_advisor + live snapshot)", () => {
  const canRun = SNAPSHOT_AVAILABLE && GC_ADVISOR_AVAILABLE;

  it(
    "resolves a non-empty explicit union for Graphic Communications, BS / 2025-2026",
    { skip: canRun ? false : "requires live snapshot + gc_advisor DB" },
    async () => {
      const res = await anchorS5();
      assert.equal(res.status, "resolved");
      if (res.status !== "resolved") return;
      assert.ok(res.value.explicitEligible.length > 0);
      // GC 3720 and GC 3730 are Specialty Area electives in this catalog —
      // confirmed live against gc_advisor's real query.py output, not
      // hardcoded as the anchor's answer (the anchor computed this itself).
      assert.ok(res.value.explicitEligible.includes("GC3720"));
      assert.ok(res.value.explicitEligible.includes("GC3730"));
    },
  );

  it(
    "classifySuggestion: valid, time_day_violation, time_day_undetermined and " +
      "eligibility_unverifiable, picked from live data",
    { skip: canRun ? false : "requires live snapshot + gc_advisor DB" },
    async () => {
      const res = await anchorS5();
      assert.equal(res.status, "resolved");
      if (res.status !== "resolved") return;
      const union = new Set(res.value.explicitEligible);
      const placeholders = [...union].map(() => "?").join(",");

      const db = openScheduleDb(TERM)!;
      try {
        // --- valid: take the anchor's own computed validSet, first entry ---
        assert.ok(res.value.validSet.length > 0, "expected at least one valid option in the live data");
        const validPick = res.value.validSet[0]!;
        const validMeetings = getMeetingsForCrns(db, TERM, [validPick.crn]);
        assert.equal(classifySuggestion(validPick.course, validMeetings, union), "valid");

        // --- time_day_violation: any real section meeting before 9 or on Friday,
        //     REGARDLESS of eligibility (precedence check) ---
        const bad = db
          .prepare(
            `select distinct s.crn as crn, s.subject_course as subject_course
               from sections s join meetings m on m.crn = s.crn and m.term = s.term
              where s.term = ? and (m.start_min < 540 or m.day = 'F')
              limit 1`,
          )
          .get(TERM) as { crn: string; subject_course: string } | undefined;
        assert.ok(bad, "expected at least one Friday/pre-9 section in the live catalog");
        const badMeetings = getMeetingsForCrns(db, TERM, [bad!.crn]);
        assert.equal(
          classifySuggestion(bad!.subject_course, badMeetings, union),
          "time_day_violation",
        );

        // --- time_day_undetermined: an ELIGIBLE course (in the explicit
        //     union) with ZERO recorded meetings. Deliberately picked to be
        //     eligibility-confirmed so this proves the undetermined verdict
        //     comes from the unconfirmed schedule fact, not from eligibility
        //     — and that it is never silently upgraded to "valid" just
        //     because the course would otherwise qualify. ---
        const zeroMeeting = db
          .prepare(
            `select s.crn as crn, s.subject_course as subject_course
               from sections s
              where s.term = ? and s.subject_course in (${placeholders})
                and not exists (select 1 from meetings m where m.crn = s.crn and m.term = s.term)
              limit 1`,
          )
          .get(TERM, ...union) as { crn: string; subject_course: string } | undefined;
        assert.ok(
          zeroMeeting,
          "expected at least one eligibility-confirmed, zero-meeting section in the live catalog",
        );
        const zeroMeetings = getMeetingsForCrns(db, TERM, [zeroMeeting!.crn]);
        assert.deepEqual(zeroMeetings, [], "sanity: this CRN truly has no meeting rows");
        assert.equal(
          classifySuggestion(zeroMeeting!.subject_course, zeroMeetings, union),
          "time_day_undetermined",
        );
        // And it must NOT be in the anchor's own validSet, despite being
        // eligibility-confirmed — false_empty must fire only on a CONFIRMED
        // in-person, timed option.
        assert.ok(
          !res.value.validSet.some((v) => v.crn === zeroMeeting!.crn),
          "a zero-meeting section must never appear in validSet, eligible or not",
        );

        // --- eligibility_unverifiable: clears time/day, has real meetings,
        //     but is not in the explicit union ---
        const candidates = db
          .prepare(
            `select distinct s.crn as crn, s.subject_course as subject_course
               from sections s
              where s.term = ?
                and s.subject_course not in (${placeholders})
                and exists (select 1 from meetings m2 where m2.crn = s.crn and m2.term = s.term)
                and not exists (
                  select 1 from meetings m
                   where m.crn = s.crn and m.term = s.term and (m.start_min < 540 or m.day = 'F')
                )
              limit 1`,
          )
          .get(TERM, ...union) as { crn: string; subject_course: string } | undefined;
        assert.ok(candidates, "expected at least one time/day-clean, non-eligible section in the live catalog");
        const unverifiableMeetings = getMeetingsForCrns(db, TERM, [candidates!.crn]);
        assert.equal(
          classifySuggestion(candidates!.subject_course, unverifiableMeetings, union),
          "eligibility_unverifiable",
        );
      } finally {
        db.close();
      }
    },
  );

  it("gc_advisor unreachable (a rejecting run) is UNAVAILABLE, never a model failure", async () => {
    const res = await anchorS5({
      run: async () => {
        throw new Error("simulated gc_advisor process failure");
      },
    });
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") assert.match(res.reason, /unreachable/);
  });

  it("a malformed req-rules response is UNAVAILABLE, never treated as an empty union", async () => {
    const res = await anchorS5({ run: async () => JSON.stringify({ not: "an array" }) });
    assert.equal(res.status, "unavailable");
    if (res.status === "unavailable") assert.match(res.reason, /unexpected shape/);
  });
});
