// scripts/advising-benchmark/scenarios.ts
//
// Scenario definitions + deterministic ground-truth anchor for the
// advising-model benchmark. See
// docs/superpowers/specs/2026-07-23-advising-model-benchmark.md for the full
// design. This is Task 1 of that spec's build order: scenario data + anchor +
// anchor unit tests. NO model endpoints, NO MCP, NO network are touched here —
// `getGcRequirementRules` shells out to a LOCAL `query.py` subprocess (see
// src/gc-curriculum.ts), which is not a network call.
//
// Discipline inherited from scripts/fabrication-probe.ts (do not relitigate):
//   - Ground truth is READ LIVE from state/clemson/<term>.db (and, for S5,
//     gc_advisor req-rules) at call time, never transcribed into a constant.
//   - Every anchor returns a TruthResolution-shaped result:
//       { status: "resolved", value, fetchedAt }
//     | { status: "unavailable", reason, fetchedAt }
//     A missing snapshot, a cancelled/renumbered CRN, or an unreachable
//     gc_advisor process is UNAVAILABLE — it is NEVER classified as a model
//     failure, and it never throws such that a caller could mistake "the
//     instrument broke" for "the model was wrong". "Could not establish" and
//     "the model was wrong" must never be the same value.
//   - S5's two data sources have DIFFERENT strength and that asymmetry is
//     load-bearing: the time/day filter (schedule DB) confirms `clear` or
//     `violates` from a recorded meeting, but is NOT a simple boolean — a
//     section with zero recorded meetings is `undetermined`, never assumed
//     `clear`, because "no meeting recorded" cannot distinguish genuine async
//     from a data gap that is really an MWF 8am meeting. The eligibility
//     check (gc_advisor explicit_courses) is separately ONE-SIDED — membership
//     confirms eligibility, absence does not prove ineligibility (wildcard
//     rules like "Any ENGR course" exist and are not enumerated in
//     explicit_courses). Do not flatten either into a single boolean.
//
// Conflict primitive: this module does NOT reinvent interval overlap. It
// reuses `getMeetingsForCrns` / `findConflicts` from src/clemson-schedule-db.ts
// (half-open [start_min, end_min) overlap on the same day — already the
// primitive src/mcp-tools/clemson-schedule.ts drives). src/advisor-schedule-verify.ts
// was also read per the brief; it verifies a PROPOSED schedule's fields against
// the snapshot (throws on mismatch) but does not itself define a multi-CRN
// conflict check — clemson-schedule-db.ts's findConflicts is that primitive,
// and its semantics (same day, half-open interval, adjacent = no conflict)
// match the spec exactly, so it is reused as-is rather than duplicated.

import type DatabaseType from "better-sqlite3";

import {
  findConflicts,
  getMeetingsForCrns,
  getScheduleDbMeta,
  openScheduleDb,
  scheduleDbPath,
  type MeetingInterval,
} from "../../src/clemson-schedule-db.ts";
import { getGcRequirementRules, type QueryRunner } from "../../src/gc-curriculum.ts";

// ---------------------------------------------------------------------------
// Shared fixture constants
// ---------------------------------------------------------------------------

/** Term whose snapshot holds every scenario's ground truth. */
export const TERM = "202608";

/** S5's program + catalog year. Grandfathering makes catalog year
 *  load-bearing (a student's requirement rules are pinned to the catalog they
 *  entered under), so this is pinned and exposed as a constant rather than
 *  left to whatever `listGcCatalogYears()` returns as "current". */
export const PROGRAM = "Graphic Communications, BS";
export const CATALOG_YEAR = "2025-2026";

/**
 * The REAL advising-profile paste format: tab-separated
 * `Title | Details | CRN | Hours | Status | Instructor`, with screen-reader
 * cruft glued directly onto the CRN column (no separator). Reproduced
 * verbatim from a real paste — do not "clean up" the cruft, it is the point
 * of S3's robustness sub-check (CRN must be stripped correctly from it).
 *
 * Shared by S3, S4 and S5 — all three scenarios advise the same synthetic
 * student's current schedule.
 */
export const FIXTURE_PASTE = [
  "Co-Op Education\tCOOP 2020 001\t80268Press enter key to view additional class details for Co-Op Education COOP 2020 001 for term 202608 Press Escape key to select the entire rowPress enter to activate popup\t0\tWeb Registered\tJeff Neal",
  "Package and Specialty Printing\tGC 4060 001\t80833Press enter key to view additional class details for Package and Specialty Printing GC 4060 001 for term 202608 Press Escape key to select the entire rowPress enter to activate popup\t4\tWeb Registered\tKern T Cox",
  "Graphic Communications Internship II\tGC 4500 001\t82200Press enter key to view additional class details for Graphic Communications Internship II GC 4500 001 for term 202608 Press Escape key to select the entire rowPress enter to activate popup\t1\tWeb Registered\tBobby Congdon",
  "Package and Specialty Printing Laboratory\tGC 4061 003\t83845Press enter key to view additional class details for Package and Specialty Printing Laboratory GC 4061 003 for term 202608 Press Escape key to select the entire rowPress enter to activate popup\t0\tWeb Registered\tKern T Cox",
  "Technical Communication and Information Design\tPCID 3140 402\t88733Press enter key to view additional class details for Technical Communication and Information Design PCID 3140 402 for term 202608 Press Escape key to select the entire rowPress enter to activate popup\t3\tWeb Registered\tLisa Meloncon",
].join("\n");

// ---------------------------------------------------------------------------
// Scenario data — prompt + fixture only. Parsing the paste is the MODEL's
// job at run time; the anchor below works from CRNs directly. No parsing
// logic lives in this module.
// ---------------------------------------------------------------------------

export interface Scenario {
  id: "S1" | "S2" | "S3" | "S4" | "S5";
  term: string;
  prompt: string;
  /** The raw pasted advising-profile schedule, when the scenario supplies one. */
  fixture?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    term: TERM,
    prompt:
      "A student is interested in GC 3400, the section that meets Monday/Wednesday " +
      "at 10:10. How many credit hours is it, and can she still get a seat?",
  },
  {
    id: "S2",
    term: TERM,
    prompt: "She wants to add GC 4060, Tuesday/Thursday at 11.",
  },
  {
    id: "S3",
    term: TERM,
    fixture: FIXTURE_PASTE,
    prompt:
      "Here is her current schedule (pasted from the advising profile):\n\n" +
      FIXTURE_PASTE +
      "\n\nShe wants one more 3-credit brand course. Do GC 3720, GC 3630, or GC 3730 " +
      "fit with no conflict?",
  },
  {
    id: "S4",
    term: TERM,
    fixture: FIXTURE_PASTE,
    prompt:
      "Here is her current schedule (pasted from the advising profile):\n\n" +
      FIXTURE_PASTE +
      "\n\nShe's in GC 4061 section 003. She wants to add GC 4440 — does it fit, " +
      "and if not, is there any way to make it work?",
  },
  {
    id: "S5",
    term: TERM,
    fixture: FIXTURE_PASTE,
    prompt:
      "Here is her current schedule (pasted from the advising profile):\n\n" +
      FIXTURE_PASTE +
      "\n\nFind some options for an additional class that would count toward either " +
      "her Specialty Area or GC Technical requirement, nothing that meets before " +
      "9:00 a.m., and nothing on Fridays.",
  },
];

// ---------------------------------------------------------------------------
// Anchor result shape — mirrors fabrication-probe.ts's TruthResolution.
// "Could not establish" (unavailable) and "the model was wrong" (a resolved
// value the model's answer disagrees with) are different types on purpose;
// collapsing them is the exact defect this discipline exists to prevent.
// ---------------------------------------------------------------------------

export type AnchorResolution<T> =
  | { status: "resolved"; value: T; fetchedAt: string }
  | { status: "unavailable"; reason: string; fetchedAt: string | null };

function resolved<T>(value: T, fetchedAt: string): AnchorResolution<T> {
  return { status: "resolved", value, fetchedAt };
}

function unavailable<T>(reason: string, fetchedAt: string | null): AnchorResolution<T> {
  return { status: "unavailable", reason, fetchedAt };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the term snapshot, resolve its `fetched_at`, and hand both to `fn`.
 * Every failure mode (no snapshot, unreadable meta, a query that throws) is
 * caught here and turned into `unavailable` — an anchor built on this helper
 * can never throw its way into looking like a crashed trial.
 */
function withScheduleDb<T>(
  term: string,
  fn: (db: DatabaseType.Database, fetchedAt: string) => AnchorResolution<T>,
): AnchorResolution<T> {
  const db = openScheduleDb(term);
  if (!db) return unavailable(`no snapshot at ${scheduleDbPath(term)}`, null);
  try {
    let fetchedAt: string;
    try {
      fetchedAt = getScheduleDbMeta(db).fetchedAt;
    } catch (err) {
      return unavailable(`snapshot meta unreadable: ${errMsg(err)}`, null);
    }
    if (!fetchedAt) {
      return unavailable("snapshot has no meta.fetched_at, so its age cannot be stated", null);
    }
    try {
      return fn(db, fetchedAt);
    } catch (err) {
      return unavailable(`query failed: ${errMsg(err)}`, fetchedAt);
    }
  } finally {
    db.close();
  }
}

/**
 * The conflict primitive both S3 and S4 anchor on: do two CRNs' meetings
 * overlap on the same day? Thin wrapper over the reused
 * getMeetingsForCrns/findConflicts pair so callers don't have to remember to
 * filter findConflicts' output back down to the one pair they asked about.
 */
export function crnsConflict(
  db: DatabaseType.Database,
  term: string,
  crnA: string,
  crnB: string,
): boolean {
  const meetings = getMeetingsForCrns(db, term, [crnA, crnB]);
  return findConflicts(meetings).length > 0;
}

// ---------------------------------------------------------------------------
// S1 — natural key, fact + a signal to catch
// ---------------------------------------------------------------------------

export const S1_CRN = "80822"; // GC 3400 section 001

export interface S1Fact {
  creditHours: number;
  seatsAvailable: number;
}

export function anchorS1(opts: { term?: string; crn?: string } = {}): AnchorResolution<S1Fact> {
  const term = opts.term ?? TERM;
  const crn = opts.crn ?? S1_CRN;
  return withScheduleDb(term, (db, fetchedAt) => {
    const row = db
      .prepare(
        "select credit_hours as creditHours, seats_available as seatsAvailable " +
          "from sections where term = ? and crn = ?",
      )
      .get(term, crn) as { creditHours: number | null; seatsAvailable: number | null } | undefined;
    if (!row) {
      return unavailable(
        `CRN ${crn} not found in the ${term} snapshot (cancelled or renumbered)`,
        fetchedAt,
      );
    }
    if (row.creditHours === null) {
      return unavailable(`CRN ${crn} has no credit_hours recorded in the ${term} snapshot`, fetchedAt);
    }
    return resolved(
      { creditHours: row.creditHours, seatsAvailable: row.seatsAvailable ?? 0 },
      fetchedAt,
    );
  });
}

// ---------------------------------------------------------------------------
// S2 — ambiguous key: two sections share the same natural-language slot
// ---------------------------------------------------------------------------

export const S2_COURSE = "GC4060"; // Banner's spaceless subject_course form

export interface S2Fact {
  count: number;
  crns: string[];
}

/** "ambiguous (N sections: crn, crn, ...)" — a display helper, not the value
 *  itself. The resolved value is the count + CRN list; this just formats it
 *  the way the spec's prose does. */
export function describeS2(fact: S2Fact): string {
  return `ambiguous (${fact.count} section${fact.count === 1 ? "" : "s"}: ${fact.crns.join(", ")})`;
}

export function anchorS2(
  opts: { term?: string; course?: string; day1?: string; day2?: string; startMin?: number } = {},
): AnchorResolution<S2Fact> {
  const term = opts.term ?? TERM;
  const course = opts.course ?? S2_COURSE;
  const day1 = opts.day1 ?? "T";
  const day2 = opts.day2 ?? "R";
  const startMin = opts.startMin ?? 660; // 11:00
  return withScheduleDb(term, (db, fetchedAt) => {
    const rows = db
      .prepare(
        `select distinct s.crn as crn
           from sections s join meetings m on m.crn = s.crn and m.term = s.term
          where s.term = ? and s.subject_course = ? and m.day in (?, ?) and m.start_min = ?
          order by s.crn`,
      )
      .all(term, course, day1, day2, startMin) as { crn: string }[];
    if (rows.length === 0) {
      return unavailable(
        `no ${course} section meets ${day1}/${day2} at start_min=${startMin} in the ${term} snapshot`,
        fetchedAt,
      );
    }
    const crns = rows.map((r) => r.crn);
    return resolved({ count: crns.length, crns }, fetchedAt);
  });
}

// ---------------------------------------------------------------------------
// S3 — messy pasted schedule → conflict screen against candidate courses
// ---------------------------------------------------------------------------

export const S3_ANCHOR_CRN = "80833"; // GC 4060 section 001, from the fixture paste
export const S3_CANDIDATES = ["GC3720", "GC3630", "GC3730"];

export interface S3Fact {
  /** Courses whose offered 202608 section does NOT conflict with the anchor. */
  fits: string[];
  /** Courses whose offered 202608 section DOES conflict with the anchor. */
  conflicts: string[];
  /** The single 202608 CRN resolved for each candidate course. */
  byCourseCrn: Record<string, string>;
}

export function anchorS3(
  opts: { term?: string; anchorCrn?: string; candidates?: string[] } = {},
): AnchorResolution<S3Fact> {
  const term = opts.term ?? TERM;
  const anchorCrn = opts.anchorCrn ?? S3_ANCHOR_CRN;
  const candidates = opts.candidates ?? S3_CANDIDATES;
  return withScheduleDb(term, (db, fetchedAt) => {
    const anchorRow = db
      .prepare("select crn from sections where term = ? and crn = ?")
      .get(term, anchorCrn);
    if (!anchorRow) {
      return unavailable(`anchor CRN ${anchorCrn} not found in the ${term} snapshot`, fetchedAt);
    }

    const byCourseCrn: Record<string, string> = {};
    for (const course of candidates) {
      const rows = db
        .prepare("select crn from sections where term = ? and subject_course = ?")
        .all(term, course) as { crn: string }[];
      if (rows.length !== 1) {
        return unavailable(
          `expected exactly one ${term} section for ${course}, found ${rows.length} — ` +
            "cannot resolve which section the question means",
          fetchedAt,
        );
      }
      byCourseCrn[course] = rows[0]!.crn;
    }

    const fits: string[] = [];
    const conflicts: string[] = [];
    for (const course of candidates) {
      const crn = byCourseCrn[course]!;
      if (crnsConflict(db, term, anchorCrn, crn)) conflicts.push(course);
      else fits.push(course);
    }
    return resolved({ fits, conflicts, byCourseCrn }, fetchedAt);
  });
}

// ---------------------------------------------------------------------------
// S4 — counterfactual: does switching the current lab section free the add?
// ---------------------------------------------------------------------------

export const S4_CURRENT_LAB_CRN = "83845"; // GC 4061 section 003 (the fixture's current lab)
export const S4_TARGET_CRN = "80843"; // GC 4440 section 001
export const S4_ALT_LAB_CRNS = ["80836", "80837"]; // GC 4061 sections 001, 002

export interface S4Fact {
  /** Does the CURRENT lab section conflict with the target course? */
  currentConflicts: boolean;
  /** Of the alternate lab CRNs, which ones do NOT conflict with the target —
   *  i.e. which switch frees the add. */
  freeingSections: string[];
}

export function anchorS4(
  opts: {
    term?: string;
    currentLabCrn?: string;
    targetCrn?: string;
    altLabCrns?: string[];
  } = {},
): AnchorResolution<S4Fact> {
  const term = opts.term ?? TERM;
  const currentLabCrn = opts.currentLabCrn ?? S4_CURRENT_LAB_CRN;
  const targetCrn = opts.targetCrn ?? S4_TARGET_CRN;
  const altLabCrns = opts.altLabCrns ?? S4_ALT_LAB_CRNS;
  return withScheduleDb(term, (db, fetchedAt) => {
    for (const crn of [currentLabCrn, targetCrn, ...altLabCrns]) {
      const row = db.prepare("select crn from sections where term = ? and crn = ?").get(term, crn);
      if (!row) {
        return unavailable(`CRN ${crn} not found in the ${term} snapshot`, fetchedAt);
      }
    }
    const currentConflicts = crnsConflict(db, term, currentLabCrn, targetCrn);
    const freeingSections = altLabCrns.filter((crn) => !crnsConflict(db, term, crn, targetCrn));
    return resolved({ currentConflicts, freeingSections }, fetchedAt);
  });
}

// ---------------------------------------------------------------------------
// S5 — open-ended requirement search with hard scheduling constraints.
//
// Two data sources of DIFFERENT strength — kept separate on purpose:
//   - timeDayStatus: reads only the schedule DB, but is itself THREE-VALUED,
//     not a sound/unsound boolean split. A section with recorded meetings is
//     `clear` (every meeting starts at/after 9:00 and none is on Friday) or
//     `violates` (at least one meeting fails that). A section with ZERO
//     meeting rows is `undetermined` — NOT `clear`. "No meeting recorded"
//     is ambiguous between genuine async and a data gap that is really an
//     MWF 8am meeting the snapshot failed to capture, and this instrument
//     does not get to assert soundness it cannot back. Treating an absence of
//     data as a pass is exactly the "couldn't establish" == "satisfies"
//     conflation this project keeps getting burned by (see
//     scripts/fabrication-probe.ts's whole reason for existing) — so
//     `undetermined` is its own bucket, mirroring the eligibility half's own
//     one-sidedness rather than silently resolving it.
//   - explicitCourseUnion: ONE-SIDED. Reads gc_advisor req-rules. Membership
//     in the union CONFIRMS eligibility; absence does NOT prove ineligibility
//     — some rules are empty wildcard rules ("Any ENGR course") that
//     explicit_courses does not enumerate. This is a LOWER BOUND, never
//     treated as a closed set.
//
// Neither half is allowed to manufacture a positive from missing data. That
// symmetry is the point: `undetermined` (time/day) and
// `eligibility_unverifiable` (requirement membership) are the same shape of
// admission — "I could not confirm this, so I am not counting it as valid,
// but I am also not calling it a violation."
// ---------------------------------------------------------------------------

/** Banner stores subject_course spaceless ("GC3720"); gc_advisor's
 *  explicit_courses are spaced ("GC 3720"). Normalize both to the same form
 *  before comparing — same normalization advisor-schedule-verify.ts uses for
 *  course codes. */
function normCourse(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase();
}

export const S5_ELIGIBILITY_SLOT_TYPES = [
  "Specialty Area Requirement",
  "Graphic Communication Technical Requirement",
];

export type TimeDayStatus = "clear" | "violates" | "undetermined";

/**
 * Three-valued, on purpose (see the block comment above this section):
 *   - `undetermined` — zero meeting rows recorded for this CRN. Cannot
 *     confirm either way; this is NOT the same as "clear" and must never be
 *     scored as a pass.
 *   - `violates` — at least one recorded meeting starts before 9:00
 *     (start_min < 540) or falls on Friday.
 *   - `clear` — at least one meeting recorded, and every one of them starts
 *     at/after 9:00 and none is on Friday.
 */
export function timeDayStatus(meetings: MeetingInterval[]): TimeDayStatus {
  if (meetings.length === 0) return "undetermined";
  return meetings.every((m) => m.startMin >= 540 && m.day !== "F") ? "clear" : "violates";
}

/**
 * Union of `explicit_courses` across every row of `getGcRequirementRules`'s
 * result whose slot type is one of S5_ELIGIBILITY_SLOT_TYPES. The live shape
 * (confirmed against gc_advisor's real query.py) is an array of
 * `{ slot_type, rule: { slot_type, total_credits, explicit_courses, raw_text } }`.
 *
 * Returns null when the response cannot be trusted for the rows this
 * scenario actually needs: `rows` is not an array at all, or a row whose
 * slot_type IS one of the two target types is missing a usable
 * `explicit_courses` array. That is a gc_advisor contract break for data this
 * anchor depends on, and the caller must not silently treat it as an empty
 * (and therefore everything-is-unverifiable) union.
 *
 * Rows for OTHER slot types (or garbage entries) that don't match are
 * skipped rather than failing the whole union — this anchor only needs the
 * two named slot types, and being strict about catalog data it never reads
 * would make the scenario UNAVAILABLE for reasons unrelated to what it asks.
 */
export function explicitCourseUnion(rows: unknown): Set<string> | null {
  if (!Array.isArray(rows)) return null;
  const union = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const rule = r.rule as Record<string, unknown> | undefined;
    const slotType = typeof r.slot_type === "string" ? r.slot_type : rule?.slot_type;
    if (typeof slotType !== "string" || !S5_ELIGIBILITY_SLOT_TYPES.includes(slotType)) continue;
    const courses = rule?.explicit_courses;
    if (!Array.isArray(courses)) return null; // a row we NEED is malformed
    for (const c of courses) {
      if (typeof c === "string") union.add(normCourse(c));
    }
  }
  return union;
}

export interface S5Fact {
  program: string;
  catalogYear: string;
  /** The one-sided lower bound: courses confirmed eligible via explicit_courses. */
  explicitEligible: string[];
  /** BOTH in explicitEligible AND `timeDayStatus === "clear"` — the
   *  definitely-valid answer set per the spec. Sections with zero recorded
   *  meetings (`undetermined`) are deliberately EXCLUDED here even when their
   *  course is eligibility-confirmed: this is the set `false_empty` is
   *  measured against, and false_empty must fire only when a CONFIRMED
   *  in-person, timed option existed — not an async section the instrument
   *  cannot vouch for. */
  validSet: Array<{ course: string; crn: string }>;
}

export async function anchorS5(
  opts: { term?: string; program?: string; catalogYear?: string; run?: QueryRunner } = {},
): Promise<AnchorResolution<S5Fact>> {
  const term = opts.term ?? TERM;
  const program = opts.program ?? PROGRAM;
  const catalogYear = opts.catalogYear ?? CATALOG_YEAR;

  let rawRules: unknown;
  try {
    rawRules =
      opts.run !== undefined
        ? await getGcRequirementRules(catalogYear, program, opts.run)
        : await getGcRequirementRules(catalogYear, program);
  } catch (err) {
    // gc_advisor unreachable (process missing, DB missing, bad exit code, ...)
    // is UNAVAILABLE, never a model failure — same rule as a missing schedule
    // snapshot.
    return unavailable(`gc_advisor req-rules unreachable: ${errMsg(err)}`, null);
  }

  const union = explicitCourseUnion(rawRules);
  if (union === null) {
    return unavailable(
      `gc_advisor req-rules returned an unexpected shape for "${program}" (${catalogYear})`,
      null,
    );
  }

  return withScheduleDb(term, (db, fetchedAt) => {
    if (union.size === 0) {
      return resolved({ program, catalogYear, explicitEligible: [], validSet: [] }, fetchedAt);
    }
    const placeholders = [...union].map(() => "?").join(",");
    const offered = db
      .prepare(
        `select crn, subject_course from sections
          where term = ? and subject_course in (${placeholders})
          order by subject_course, crn`,
      )
      .all(term, ...union) as { crn: string; subject_course: string }[];

    const validSet: Array<{ course: string; crn: string }> = [];
    for (const row of offered) {
      const meetings = getMeetingsForCrns(db, term, [row.crn]);
      if (timeDayStatus(meetings) === "clear") {
        validSet.push({ course: row.subject_course, crn: row.crn });
      }
    }
    return resolved(
      { program, catalogYear, explicitEligible: [...union].sort(), validSet },
      fetchedAt,
    );
  });
}

// ---------------------------------------------------------------------------
// S5 per-suggestion classifier — what the later scoring task calls to grade
// one (course, crn) the model proposed. Four outcomes (per the Task 1 brief's
// scope, extended for the three-valued time/day filter); `false_empty` from
// the spec is a whole-answer check ("model claimed nothing fits but a valid
// option existed"), not a per-suggestion classification, and belongs to the
// scoring task that has the model's full answer to inspect.
//
// Precedence is load-bearing:
//   1. `violates` short-circuits everything — a course that IS in the
//      explicit union but meets on Friday is still a definitive
//      time_day_violation; eligibility can never rescue a broken hard
//      constraint.
//   2. `undetermined` is checked next, BEFORE eligibility — a zero-meeting
//      section is never scored `valid` even if its course is
//      eligibility-confirmed, because the reason it can't be `valid` is the
//      unconfirmed schedule fact, not the (possibly perfectly fine)
//      eligibility fact. Don't credit it, don't penalize it: its own bucket.
//   3. Only a `clear` section proceeds to the eligibility check.
// ---------------------------------------------------------------------------

export type S5Outcome =
  | "time_day_violation"
  | "time_day_undetermined"
  | "valid"
  | "eligibility_unverifiable";

export function classifySuggestion(
  course: string,
  meetings: MeetingInterval[],
  explicitEligible: Set<string> | string[],
): S5Outcome {
  const status = timeDayStatus(meetings);
  if (status === "violates") return "time_day_violation";
  if (status === "undetermined") return "time_day_undetermined";
  const union =
    explicitEligible instanceof Set ? explicitEligible : new Set(explicitEligible.map(normCourse));
  return union.has(normCourse(course)) ? "valid" : "eligibility_unverifiable";
}

/** Convenience wrapper: look the CRN's meetings up live, then classify. */
export function classifySuggestionLive(
  db: DatabaseType.Database,
  term: string,
  course: string,
  crn: string,
  explicitEligible: Set<string> | string[],
): S5Outcome {
  const meetings = getMeetingsForCrns(db, term, [crn]);
  return classifySuggestion(course, meetings, explicitEligible);
}
