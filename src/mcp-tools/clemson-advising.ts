// src/mcp-tools/clemson-advising.ts
// Catalog + schedule join tool for GC advising.
//
// find-eligible-sections opens the per-term schedule DB, ATTACHes gc_advisor.db,
// and runs the requirement → offered-sections join in SQL. Prereq eligibility is
// checked in TypeScript (parse prereq_parsed JSON, test subset of completed_courses).
import Database from "better-sqlite3";

import { GC_ADVISOR_DB } from "../config.js";
import {
  openScheduleDb,
  getScheduleDbMeta,
  getMeetingsForCrns,
  findConflicts,
} from "../clemson-schedule-db.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequirementRule {
  slot_type: string;
  total_credits: number;
  explicit_courses: string[];
  raw_text: string;
}

interface SectionRow {
  crn: string;
  subject_course: string;
  section: string;
  title: string;
  credit_hours: number | null;
  seats_available: number;
  enrollment: number;
  max_enrollment: number;
  open: number;
}
interface MeetingRow {
  crn: string;
  day: string;
  start_min: number | null;
  end_min: number | null;
  building: string | null;
  room: string | null;
  type: string | null;
}
interface InstructorRow {
  crn: string;
  name: string;
  email: string | null;
  primary_i: number;
}
interface CourseRow {
  code: string;
  prereq_text: string | null;
  prereq_parsed: string | null; // JSON array of course codes
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minsToHHMM(m: number): string {
  return (
    String(Math.floor(m / 60)).padStart(2, "0") +
    String(m % 60).padStart(2, "0")
  );
}

// gc_advisor stores course codes with a space ("GC 3010"); Banner's schedule DB
// stores subject_course spaceless ("GC3010"). Normalize both sides to spaceless
// upper-case before any cross-source comparison, or every join silently misses.
function normCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}

function getLatestProgramId(
  db: Database.Database,
  programName: string,
): number | null {
  const row = db
    .prepare(
      `SELECT p.id FROM program p
       JOIN catalog_year cy ON p.catalog_year_id = cy.id
       WHERE p.name = ?
       ORDER BY cy.label DESC LIMIT 1`,
    )
    .get(programName) as { id: number } | undefined;
  return row?.id ?? null;
}

// Year-aware sibling of getLatestProgramId — picks the program row for a
// specific catalog_year.label (e.g. "2025-2026") instead of always the
// newest, so a student grandfathered into an older catalog gets that
// catalog's requirement rule (course lists/credit totals can differ by year).
function getProgramIdForCatalogYear(
  db: Database.Database,
  programName: string,
  catalogYear: string,
): number | null {
  const row = db
    .prepare(
      `SELECT p.id FROM program p
       JOIN catalog_year cy ON p.catalog_year_id = cy.id
       WHERE p.name = ? AND cy.label = ? LIMIT 1`,
    )
    .get(programName, catalogYear) as { id: number } | undefined;
  return row?.id ?? null;
}

// Parse a "HHMM" string (e.g. "0900") into minutes-since-midnight, or null
// if malformed. Mirrors the private hhmMToMins in clemson-schedule-db.ts —
// duplicated here only because it's a trivial parse, not the conflict
// primitive itself (that one IS reused, see getMeetingsForCrns/findConflicts
// below).
function hhmmToMins(t: string): number | null {
  if (!/^\d{4}$/.test(t)) return null;
  const h = parseInt(t.slice(0, 2), 10);
  const m = parseInt(t.slice(2), 10);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function getRequirementRule(
  db: Database.Database,
  programId: number,
  slotType: string,
): RequirementRule | null {
  const row = db
    .prepare(
      "SELECT slot_type, rule FROM requirement_rule WHERE program_id = ? AND slot_type = ? LIMIT 1",
    )
    .get(programId, slotType) as { slot_type: string; rule: string } | undefined;
  if (!row) return null;
  let parsed: { total_credits?: number; explicit_courses?: string[]; raw_text?: string };
  try {
    parsed = JSON.parse(row.rule) as typeof parsed;
  } catch {
    return null;
  }
  return {
    slot_type: row.slot_type,
    total_credits: parsed.total_credits ?? 0,
    explicit_courses: parsed.explicit_courses ?? [],
    raw_text: parsed.raw_text ?? "",
  };
}

function checkPrereqEligible(
  prereqParsed: string | null,
  completedCourses: Set<string>,
): boolean {
  if (!prereqParsed) return true;
  let codes: string[];
  try {
    codes = JSON.parse(prereqParsed) as string[];
  } catch {
    return true;
  }
  if (!Array.isArray(codes) || codes.length === 0) return true;
  // prereq_parsed is a flat list of codes; ALL must be completed.
  // (Simplification — raw_text may have OR logic; agent can read prereq_text for full rule.)
  // completedCourses is already normalized (spaceless upper); normalize each code too.
  return codes.every((c) => completedCourses.has(normCode(c)));
}

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

export const findEligibleSections: McpToolDefinition = {
  operation: "clemson.find_eligible_sections",
  tool: {
    name: "find-eligible-sections",
    description:
      "Find Banner sections offered in a given term that fulfill a GC " +
      "degree requirement slot AND are prereq-eligible for the student, " +
      "optionally ALSO filtered by scheduling constraints (time-of-day, " +
      "excluded days, conflicts with an existing schedule, open seats). " +
      "This is the single call for 'requirement-eligible sections that also " +
      "fit these scheduling constraints' — pass no_meeting_before/" +
      "exclude_days/avoid_conflict_with/open_only instead of pulling the " +
      "full eligible list and filtering it by hand across many turns. " +
      "Returns section details (CRN, title, credits, seats, meetings) plus " +
      "`prereq_eligible` per section based on the completed-courses list. " +
      "Use slot_type values from get-gc-requirement-rules (e.g. " +
      "'Specialty Area Requirement', 'Graphic Communication Technical Requirement'). " +
      "Pass completed_courses as a list of course codes the student has passed " +
      "(e.g. [\"GC 1010\", \"GC 2010\"]) — used only for prereq gating, " +
      "no identity or grade data needed. Only works for the GC (Graphic " +
      "Communications) program, since the join requires a program loaded " +
      "into gc_advisor.db — for other majors use search-clemson-classes " +
      "with course codes from get-gc-program-plan instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: "Term code, e.g. 202608.",
        },
        slot_type: {
          type: "string",
          description:
            "Requirement slot to fill, from get-gc-requirement-rules, " +
            "e.g. 'Specialty Area Requirement'.",
        },
        completed_courses: {
          type: "array",
          items: { type: "string" },
          description: "Course codes the student has completed, e.g. [\"GC 1010\"].",
        },
        program_name: {
          type: "string",
          description:
            "GC program name (default 'Graphic Communications, BS').",
        },
        catalog_year: {
          type: "string",
          description:
            "Optional catalog year label, e.g. '2025-2026', to pick the " +
            "requirement rule for a student grandfathered into an older " +
            "catalog. Default: latest catalog year for program_name.",
        },
        no_meeting_before: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '0900'. Excludes a section if ANY " +
            "of its meetings starts before this time. Sections with no " +
            "meeting rows (async/online) can't be confirmed either way and " +
            "are returned separately in sections_without_meetings instead " +
            "of sections.",
        },
        exclude_days: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional day codes to avoid, e.g. ['F'] (M T W R F S U). " +
            "Excludes a section if ANY of its meetings falls on one of " +
            "these days. Same async handling as no_meeting_before.",
        },
        avoid_conflict_with: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional CRNs already on the student's schedule. Excludes a " +
            "section if any of its meetings time-conflicts (same day, " +
            "overlapping interval) with any meeting of these CRNs.",
        },
        open_only: {
          type: "boolean",
          description:
            "Optional. If true, excludes sections with seats_available <= 0.",
        },
      },
      required: ["term", "slot_type", "completed_courses"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_eligible_sections");
    } catch (e) {
      return permissionErr(e);
    }

    const term = args.term as string | undefined;
    const slotType = args.slot_type as string | undefined;
    const completedCoursesArr = args.completed_courses as string[] | undefined;
    if (!term || !slotType || !Array.isArray(completedCoursesArr))
      return err("term, slot_type, and completed_courses are required");

    const programName =
      typeof args.program_name === "string" && args.program_name
        ? args.program_name
        : "Graphic Communications, BS";

    const catalogYear =
      typeof args.catalog_year === "string" && args.catalog_year
        ? args.catalog_year
        : undefined;

    // --- Scheduling constraints (all optional; unset = today's behavior) ---
    const noMeetingBefore =
      typeof args.no_meeting_before === "string" && args.no_meeting_before
        ? args.no_meeting_before
        : undefined;
    let noMeetingBeforeMins: number | null = null;
    if (noMeetingBefore !== undefined) {
      noMeetingBeforeMins = hhmmToMins(noMeetingBefore);
      if (noMeetingBeforeMins === null)
        return err(
          `no_meeting_before must be an HHMM string, e.g. "0900" (got "${noMeetingBefore}").`,
        );
    }

    const excludeDaySet =
      Array.isArray(args.exclude_days) && args.exclude_days.length > 0
        ? new Set((args.exclude_days as string[]).map((d) => d.toUpperCase()))
        : null;

    const avoidConflictWith =
      Array.isArray(args.avoid_conflict_with) && args.avoid_conflict_with.length > 0
        ? (args.avoid_conflict_with as string[])
        : null;

    const openOnly = args.open_only === true;

    // Whether a section's meetings can be judged against a time/day rule at
    // all — zero-meeting (async) sections can't be, see the filtering loop.
    const timeDayConstraintGiven = noMeetingBeforeMins !== null || excludeDaySet !== null;

    const appliedConstraints: Record<string, unknown> = {};
    if (catalogYear) appliedConstraints.catalog_year = catalogYear;
    if (noMeetingBeforeMins !== null) appliedConstraints.no_meeting_before = noMeetingBefore;
    if (excludeDaySet) appliedConstraints.exclude_days = [...excludeDaySet];
    if (avoidConflictWith) appliedConstraints.avoid_conflict_with = avoidConflictWith;
    if (openOnly) appliedConstraints.open_only = true;

    const schedDb = openScheduleDb(term);
    if (!schedDb)
      return err(
        `No Banner snapshot available for term ${term}. Try again after the 05:00 daily refresh.`,
      );

    try {
      // ATTACH the catalog DB so we can query it alongside the schedule.
      schedDb.prepare("ATTACH DATABASE ? AS catalog").run(GC_ADVISOR_DB);

      const programId = catalogYear
        ? getProgramIdForCatalogYear(schedDb, programName, catalogYear)
        : getLatestProgramId(schedDb, programName);
      if (programId === null) {
        return err(
          catalogYear
            ? `Program "${programName}" not found for catalog year "${catalogYear}" in gc_advisor.db. ` +
                "Check the year and name with get-gc-program-plan, or omit catalog_year for the latest."
            : `Program "${programName}" not found in gc_advisor.db. ` +
                "Check the name with get-gc-program-plan.",
        );
      }

      const rule = getRequirementRule(schedDb, programId, slotType);
      if (!rule) {
        return err(
          `No requirement rule found for slot_type "${slotType}" in program "${programName}". ` +
            "Check valid slot types with get-gc-requirement-rules.",
        );
      }
      if (rule.explicit_courses.length === 0) {
        return okJson({
          term,
          slot_type: slotType,
          total_credits_required: rule.total_credits,
          sections: [],
          applied_constraints: appliedConstraints,
          note:
            "This requirement rule has no explicit course list — it may be " +
            "satisfied by a declared minor or a broad course category. " +
            "Use get-gc-requirement-rules for the full raw_text.",
        });
      }

      const phs = rule.explicit_courses.map(() => "?").join(",");

      const sectionRows = schedDb
        .prepare(
          `SELECT crn, subject_course, section, title, credit_hours,
                  seats_available, enrollment, max_enrollment, open
           FROM sections
           WHERE term = ? AND subject_course IN (${phs})
           ORDER BY subject_course, section`,
        )
        .all(term, ...rule.explicit_courses.map(normCode)) as SectionRow[];

      if (sectionRows.length === 0) {
        return okJson({
          term,
          slot_type: slotType,
          total_credits_required: rule.total_credits,
          sections: [],
          applied_constraints: appliedConstraints,
          note: "No sections are offered in this term for the eligible course list.",
        });
      }

      const crns = sectionRows.map((r) => r.crn);
      const crnPhs = crns.map(() => "?").join(",");

      // avoid_conflict_with: load the candidate sections' meetings together
      // with the student's current-schedule CRNs' meetings in one query, run
      // the shared findConflicts primitive, and pull out which candidate
      // CRNs collide with a current-schedule CRN (candidate-vs-candidate and
      // current-vs-current pairs are not relevant here).
      let conflictingCrns: Set<string> | null = null;
      if (avoidConflictWith) {
        const combinedCrns = [...new Set([...crns, ...avoidConflictWith])];
        const allMeetings = getMeetingsForCrns(schedDb, term, combinedCrns);
        const conflicts = findConflicts(allMeetings);
        const avoidSet = new Set(avoidConflictWith);
        conflictingCrns = new Set<string>();
        for (const c of conflicts) {
          if (avoidSet.has(c.crn_a) && !avoidSet.has(c.crn_b)) conflictingCrns.add(c.crn_b);
          else if (avoidSet.has(c.crn_b) && !avoidSet.has(c.crn_a)) conflictingCrns.add(c.crn_a);
        }
      }

      const meetingRows = schedDb
        .prepare(
          `SELECT crn, day, start_min, end_min, building, room, type
           FROM meetings WHERE term = ? AND crn IN (${crnPhs})
             AND start_min IS NOT NULL AND end_min IS NOT NULL`,
        )
        .all(term, ...crns) as MeetingRow[];

      const instructorRows = schedDb
        .prepare(
          `SELECT crn, name, email, primary_i
           FROM instructors WHERE term = ? AND crn IN (${crnPhs})`,
        )
        .all(term, ...crns) as InstructorRow[];

      // subject_course is spaceless ("GC3010"); catalog.course.code is spaced
      // ("GC 3010"). Compare space-insensitively and key the map spaceless so the
      // per-section lookup below (keyed on subject_course) hits.
      const subjectCourses = [...new Set(sectionRows.map((r) => r.subject_course))];
      const scPhs = subjectCourses.map(() => "?").join(",");
      const courseRows = schedDb
        .prepare(
          `SELECT code, prereq_text, prereq_parsed
           FROM catalog.course WHERE REPLACE(code, ' ', '') IN (${scPhs})`,
        )
        .all(...subjectCourses) as CourseRow[];
      const courseMap = new Map(courseRows.map((c) => [normCode(c.code), c]));

      type MGroup = {
        startMin: number; endMin: number;
        building: string | null; room: string | null; type: string | null;
        days: string[];
      };
      const DAY_ORDER = "MTWRFSU";
      const meetingMap = new Map<string, Map<string, MGroup>>();
      for (const m of meetingRows) {
        if (!meetingMap.has(m.crn)) meetingMap.set(m.crn, new Map());
        const key = `${m.start_min}:${m.end_min}:${m.building ?? ""}:${m.room ?? ""}:${m.type ?? ""}`;
        const byInterval = meetingMap.get(m.crn)!;
        if (!byInterval.has(key)) {
          byInterval.set(key, {
            startMin: m.start_min ?? 0, endMin: m.end_min ?? 0,
            building: m.building, room: m.room, type: m.type, days: [],
          });
        }
        byInterval.get(key)!.days.push(m.day);
      }

      const instMap = new Map<string, Array<{ name: string; email: string | null; primary: boolean }>>();
      for (const i of instructorRows) {
        if (!instMap.has(i.crn)) instMap.set(i.crn, []);
        instMap.get(i.crn)!.push({ name: i.name, email: i.email, primary: i.primary_i === 1 });
      }

      const completedSet = new Set(completedCoursesArr.map(normCode));
      const meta = getScheduleDbMeta(schedDb);

      const sections: Record<string, unknown>[] = [];
      const sectionsWithoutMeetings: Record<string, unknown>[] = [];

      for (const row of sectionRows) {
        // open_only and avoid_conflict_with apply to every section — including
        // zero-meeting (async) ones — and can exclude it outright.
        if (openOnly && row.seats_available <= 0) continue;
        if (conflictingCrns?.has(row.crn)) continue;

        const courseInfo = courseMap.get(normCode(row.subject_course));
        const prereqEligible = checkPrereqEligible(
          courseInfo?.prereq_parsed ?? null,
          completedSet,
        );
        const mgMap = meetingMap.get(row.crn);
        const hasMeetings = !!mgMap && mgMap.size > 0;
        const meetings = mgMap
          ? [...mgMap.values()].map((mg) => ({
              days: [...mg.days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)).join(""),
              beginTime: minsToHHMM(mg.startMin),
              endTime: minsToHHMM(mg.endMin),
              building: mg.building,
              room: mg.room,
              type: mg.type,
            }))
          : [];

        const base = {
          crn: row.crn,
          subject_course: row.subject_course,
          section: row.section,
          title: row.title,
          credit_hours: row.credit_hours,
          seats_available: row.seats_available,
          enrollment: row.enrollment,
          max_enrollment: row.max_enrollment,
          open: row.open === 1,
          instructors: instMap.get(row.crn) ?? [],
          meetings,
          prereq_eligible: prereqEligible,
          prereq_text: courseInfo?.prereq_text ?? null,
        };

        // A section with no meeting rows (async/online) can't be confirmed to
        // satisfy no_meeting_before/exclude_days — it's neither vacuously
        // included nor silently dropped, it goes in a separate array so the
        // advisor still sees it.
        if (timeDayConstraintGiven && !hasMeetings) {
          sectionsWithoutMeetings.push({
            ...base,
            note:
              "No meeting times on file (async/online section) — cannot " +
              "confirm it satisfies the time/day constraint(s); review manually.",
          });
          continue;
        }

        if (timeDayConstraintGiven && hasMeetings) {
          let violates = false;
          for (const mg of mgMap!.values()) {
            if (noMeetingBeforeMins !== null && mg.startMin < noMeetingBeforeMins) {
              violates = true;
              break;
            }
            if (excludeDaySet && mg.days.some((d) => excludeDaySet.has(d))) {
              violates = true;
              break;
            }
          }
          if (violates) continue;
        }

        sections.push(base);
      }

      const result: Record<string, unknown> = {
        term,
        term_description: meta.termDescription,
        slot_type: slotType,
        total_credits_required: rule.total_credits,
        sections,
        applied_constraints: appliedConstraints,
        _source: `Clemson University Online Catalog (gc_advisor) + Banner schedule ${meta.fetchedAt}`,
      };
      // Only present when a time/day constraint was actually given — keeps
      // the response shape identical to today's when no constraints are
      // passed (regression guard).
      if (timeDayConstraintGiven) result.sections_without_meetings = sectionsWithoutMeetings;

      return okJson(result);
    } finally {
      try {
        schedDb.prepare("DETACH DATABASE catalog").run();
      } catch {
        /* ok */
      }
      schedDb.close();
    }
  },
};

// ---------------------------------------------------------------------------
// find-sections-by-schedule — schedule-fit search with NO subject/requirement
// required. This is find-eligible-sections minus the gc_advisor.db join
// (no ATTACH, no program/rule/prereq) — a pure query over the Banner
// schedule snapshot, for "any 3-credit course that fits MWF 12:20 with
// open seats" style requests where the caller doesn't have a subject or a
// GC requirement slot in hand.
// ---------------------------------------------------------------------------

export const findSectionsBySchedule: McpToolDefinition = {
  operation: "clemson.find_sections_by_schedule",
  tool: {
    name: "find-sections-by-schedule",
    description:
      "Finds sections in a term that fit scheduling constraints across ALL " +
      "departments — use for 'any 3-credit course that meets MWF 12:20 with " +
      "seats' or 'something that fits my open Tue/Thu block.' Unlike " +
      "search-clemson-classes (needs a subject) and find-eligible-sections " +
      "(needs a GC requirement slot), this searches by schedule fit. " +
      "Requires at least one constraint besides term. Narrow with subject, " +
      "days_within, a time window, or min_seats (minimum open seats). Sections " +
      "come back most-open-first. If too many fit, it returns needs_narrowing " +
      "with the total and a by_subject breakdown INSTEAD of a list — relay the " +
      "count, suggest a subject area or tighter constraint, and re-run. " +
      "Async/online sections (no meeting time) are excluded from a time search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: "Term code, e.g. 202608.",
        },
        credits: {
          type: "number",
          description:
            "Match sections whose credit_hours is within 0.01 of this value.",
        },
        subject: {
          type: "string",
          description:
            "Optional subject prefix to narrow to, e.g. 'CPSC'.",
        },
        days_within: {
          type: "string",
          description:
            "The days the student is free, e.g. 'MWF' or 'TR'. A section " +
            "qualifies only if EVERY one of its meeting days is in this " +
            "set (a MW course fits 'MWF'; a MWF course does NOT fit 'MW').",
        },
        starts_at: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '1220'. At least one of the " +
            "section's meetings must start exactly at this time.",
        },
        no_meeting_before: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '0900'. Excludes a section if ANY " +
            "of its meetings starts before this time.",
        },
        no_meeting_after: {
          type: "string",
          description:
            "Optional HHMM string, e.g. '1700'. Excludes a section if ANY " +
            "of its meetings ends after this time.",
        },
        exclude_days: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional day codes to avoid, e.g. ['F'] (M T W R F S U). " +
            "Excludes a section if ANY of its meetings falls on one of " +
            "these days.",
        },
        avoid_conflict_with: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional CRNs already on the student's schedule. Excludes a " +
            "section if any of its meetings time-conflicts (same day, " +
            "overlapping interval) with any meeting of these CRNs.",
        },
        open_only: {
          type: "boolean",
          description:
            "Optional. If true, excludes sections with seats_available <= 0.",
        },
        min_seats: {
          type: "number",
          description:
            "Optional. Only sections with at least this many seats available. " +
            "Use to narrow a broad result to sections with real room (e.g. 5).",
        },
      },
      required: ["term"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_sections_by_schedule");
    } catch (e) {
      return permissionErr(e);
    }

    const term = args.term as string | undefined;
    if (!term) return err("term is required");

    const credits = typeof args.credits === "number" ? args.credits : undefined;

    const subject =
      typeof args.subject === "string" && args.subject ? args.subject : undefined;

    const daysWithin =
      typeof args.days_within === "string" && args.days_within
        ? args.days_within.toUpperCase()
        : undefined;

    const startsAt =
      typeof args.starts_at === "string" && args.starts_at ? args.starts_at : undefined;
    let startsAtMins: number | null = null;
    if (startsAt !== undefined) {
      startsAtMins = hhmmToMins(startsAt);
      if (startsAtMins === null)
        return err(
          `starts_at must be an HHMM string, e.g. "1220" (got "${startsAt}").`,
        );
    }

    const noMeetingBefore =
      typeof args.no_meeting_before === "string" && args.no_meeting_before
        ? args.no_meeting_before
        : undefined;
    let noMeetingBeforeMins: number | null = null;
    if (noMeetingBefore !== undefined) {
      noMeetingBeforeMins = hhmmToMins(noMeetingBefore);
      if (noMeetingBeforeMins === null)
        return err(
          `no_meeting_before must be an HHMM string, e.g. "0900" (got "${noMeetingBefore}").`,
        );
    }

    const noMeetingAfter =
      typeof args.no_meeting_after === "string" && args.no_meeting_after
        ? args.no_meeting_after
        : undefined;
    let noMeetingAfterMins: number | null = null;
    if (noMeetingAfter !== undefined) {
      noMeetingAfterMins = hhmmToMins(noMeetingAfter);
      if (noMeetingAfterMins === null)
        return err(
          `no_meeting_after must be an HHMM string, e.g. "1700" (got "${noMeetingAfter}").`,
        );
    }

    const excludeDaySet =
      Array.isArray(args.exclude_days) && args.exclude_days.length > 0
        ? new Set((args.exclude_days as string[]).map((d) => d.toUpperCase()))
        : null;

    const avoidConflictWith =
      Array.isArray(args.avoid_conflict_with) && args.avoid_conflict_with.length > 0
        ? (args.avoid_conflict_with as string[])
        : null;

    const openOnly = args.open_only === true;
    const minSeats =
      typeof args.min_seats === "number" && Number.isFinite(args.min_seats)
        ? args.min_seats
        : undefined;

    // Bounding-constraint check: open_only / min_seats / exclude_days /
    // avoid_conflict_with alone don't bound the scan — they only filter within
    // whatever the bounding constraints already narrowed it to.
    if (
      credits === undefined &&
      subject === undefined &&
      daysWithin === undefined &&
      startsAtMins === null &&
      noMeetingBeforeMins === null &&
      noMeetingAfterMins === null
    ) {
      return err(
        "Give at least one bounding constraint besides term — credits, " +
          "subject, days_within, starts_at, or a no_meeting_before/after " +
          "window — so this doesn't scan the whole term.",
      );
    }

    // Whether a section's meetings can be judged against a time/day rule at
    // all — zero-meeting (async) sections can't be, see the filtering loop.
    const timeDayConstraintGiven =
      daysWithin !== undefined ||
      startsAtMins !== null ||
      noMeetingBeforeMins !== null ||
      noMeetingAfterMins !== null ||
      excludeDaySet !== null;

    const appliedConstraints: Record<string, unknown> = {};
    if (credits !== undefined) appliedConstraints.credits = credits;
    if (subject !== undefined) appliedConstraints.subject = subject;
    if (daysWithin !== undefined) appliedConstraints.days_within = daysWithin;
    if (startsAtMins !== null) appliedConstraints.starts_at = startsAt;
    if (noMeetingBeforeMins !== null) appliedConstraints.no_meeting_before = noMeetingBefore;
    if (noMeetingAfterMins !== null) appliedConstraints.no_meeting_after = noMeetingAfter;
    if (excludeDaySet) appliedConstraints.exclude_days = [...excludeDaySet];
    if (avoidConflictWith) appliedConstraints.avoid_conflict_with = avoidConflictWith;
    if (openOnly) appliedConstraints.open_only = true;
    if (minSeats !== undefined) appliedConstraints.min_seats = minSeats;

    const schedDb = openScheduleDb(term);
    if (!schedDb)
      return err(
        `No Banner snapshot available for term ${term}. Try again after the 05:00 daily refresh.`,
      );

    try {
      const conditions: string[] = ["term = ?"];
      const bindings: unknown[] = [term];
      if (credits !== undefined) {
        conditions.push("ABS(credit_hours - ?) < 0.01");
        bindings.push(credits);
      }
      if (subject !== undefined) {
        conditions.push("subject_course LIKE ?");
        bindings.push(`${normCode(subject)}%`);
      }

      const meta = getScheduleDbMeta(schedDb);

      const sectionRows = schedDb
        .prepare(
          `SELECT crn, subject_course, section, title, credit_hours,
                  seats_available, enrollment, max_enrollment, open
           FROM sections
           WHERE ${conditions.join(" AND ")}
           ORDER BY subject_course, section`,
        )
        .all(...bindings) as SectionRow[];

      if (sectionRows.length === 0) {
        return okJson({
          term,
          applied_constraints: appliedConstraints,
          total_matched: 0,
          sections: [],
          sections_without_meetings: [],
          note: "No sections in this term match the given credits/subject.",
          _source: `Banner schedule ${meta.fetchedAt}`,
        });
      }

      const crns = sectionRows.map((r) => r.crn);
      const crnPhs = crns.map(() => "?").join(",");

      // avoid_conflict_with: same combined-meetings + findConflicts approach
      // as find-eligible-sections.
      let conflictingCrns: Set<string> | null = null;
      if (avoidConflictWith) {
        const combinedCrns = [...new Set([...crns, ...avoidConflictWith])];
        const allMeetings = getMeetingsForCrns(schedDb, term, combinedCrns);
        const conflicts = findConflicts(allMeetings);
        const avoidSet = new Set(avoidConflictWith);
        conflictingCrns = new Set<string>();
        for (const c of conflicts) {
          if (avoidSet.has(c.crn_a) && !avoidSet.has(c.crn_b)) conflictingCrns.add(c.crn_b);
          else if (avoidSet.has(c.crn_b) && !avoidSet.has(c.crn_a)) conflictingCrns.add(c.crn_a);
        }
      }

      const meetingRows = schedDb
        .prepare(
          `SELECT crn, day, start_min, end_min, building, room, type
           FROM meetings WHERE term = ? AND crn IN (${crnPhs})
             AND start_min IS NOT NULL AND end_min IS NOT NULL`,
        )
        .all(term, ...crns) as MeetingRow[];

      const instructorRows = schedDb
        .prepare(
          `SELECT crn, name, email, primary_i
           FROM instructors WHERE term = ? AND crn IN (${crnPhs})`,
        )
        .all(term, ...crns) as InstructorRow[];

      type MGroup = {
        startMin: number; endMin: number;
        building: string | null; room: string | null; type: string | null;
        days: string[];
      };
      const DAY_ORDER = "MTWRFSU";
      const meetingMap = new Map<string, Map<string, MGroup>>();
      for (const m of meetingRows) {
        if (!meetingMap.has(m.crn)) meetingMap.set(m.crn, new Map());
        const key = `${m.start_min}:${m.end_min}:${m.building ?? ""}:${m.room ?? ""}:${m.type ?? ""}`;
        const byInterval = meetingMap.get(m.crn)!;
        if (!byInterval.has(key)) {
          byInterval.set(key, {
            startMin: m.start_min ?? 0, endMin: m.end_min ?? 0,
            building: m.building, room: m.room, type: m.type, days: [],
          });
        }
        byInterval.get(key)!.days.push(m.day);
      }

      const instMap = new Map<string, Array<{ name: string; email: string | null; primary: boolean }>>();
      for (const i of instructorRows) {
        if (!instMap.has(i.crn)) instMap.set(i.crn, []);
        instMap.get(i.crn)!.push({ name: i.name, email: i.email, primary: i.primary_i === 1 });
      }

      const matches: Record<string, unknown>[] = [];
      // Async/online sections (no meeting rows) can't fit a specific time slot,
      // so a time/day query EXCLUDES them — but count them for a one-line note
      // rather than dumping the whole (often huge) pile into the result, which
      // buries the real time-matches and overwhelms the model.
      let asyncSkipped = 0;

      for (const row of sectionRows) {
        // open_only / min_seats / avoid_conflict_with apply to every section —
        // including zero-meeting (async) ones — and can exclude it outright.
        if (openOnly && row.seats_available <= 0) continue;
        if (minSeats !== undefined && row.seats_available < minSeats) continue;
        if (conflictingCrns?.has(row.crn)) continue;

        const mgMap = meetingMap.get(row.crn);
        const hasMeetings = !!mgMap && mgMap.size > 0;
        const meetings = mgMap
          ? [...mgMap.values()].map((mg) => ({
              days: [...mg.days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)).join(""),
              beginTime: minsToHHMM(mg.startMin),
              endTime: minsToHHMM(mg.endMin),
              building: mg.building,
              room: mg.room,
              type: mg.type,
            }))
          : [];

        const base = {
          crn: row.crn,
          subject_course: row.subject_course,
          section: row.section,
          title: row.title,
          credit_hours: row.credit_hours,
          seats_available: row.seats_available,
          enrollment: row.enrollment,
          max_enrollment: row.max_enrollment,
          open: row.open === 1,
          instructors: instMap.get(row.crn) ?? [],
          meetings,
        };

        // A section with no meeting rows (async/online) can't fit a specific
        // time/day slot. Count it (surfaced as a one-line note) and exclude it
        // from a time search rather than dumping it into the result.
        if (timeDayConstraintGiven && !hasMeetings) {
          asyncSkipped++;
          continue;
        }

        if (timeDayConstraintGiven && hasMeetings) {
          const mgs = [...mgMap!.values()];
          let violates = false;

          if (daysWithin !== undefined) {
            for (const mg of mgs) {
              if (mg.days.some((d) => !daysWithin.includes(d))) {
                violates = true;
                break;
              }
            }
          }
          if (!violates && startsAtMins !== null) {
            if (!mgs.some((mg) => mg.startMin === startsAtMins)) violates = true;
          }
          if (!violates && noMeetingBeforeMins !== null) {
            if (mgs.some((mg) => mg.startMin < noMeetingBeforeMins!)) violates = true;
          }
          if (!violates && noMeetingAfterMins !== null) {
            if (mgs.some((mg) => mg.endMin > noMeetingAfterMins!)) violates = true;
          }
          if (!violates && excludeDaySet) {
            if (mgs.some((mg) => mg.days.some((d) => excludeDaySet.has(d)))) violates = true;
          }
          if (violates) continue;
        }

        matches.push(base);
      }

      // Most-open sections first — for filling a slot, room to add matters.
      matches.sort(
        (a, b) => (b.seats_available as number) - (a.seats_available as number),
      );

      const totalMatched = matches.length;
      const NARROW_THRESHOLD = 15;
      const asyncNote =
        asyncSkipped > 0
          ? ` ${asyncSkipped} async/online section(s) also match the credit/seat filters but have no scheduled time, so they can't fit a slot and were excluded.`
          : "";

      // Too many to list usefully in a chat: return a subject breakdown so the
      // advisor can ask the student to narrow (with concrete suggestions) rather
      // than dumping a long list.
      if (totalMatched > NARROW_THRESHOLD) {
        const bySubject = new Map<string, number>();
        for (const m of matches) {
          const subj = String(m.subject_course ?? "").match(/^[A-Za-z]+/)?.[0] ?? "?";
          bySubject.set(subj, (bySubject.get(subj) ?? 0) + 1);
        }
        const by_subject = [...bySubject.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([subject, count]) => ({ subject, count }));
        return okJson({
          term,
          applied_constraints: appliedConstraints,
          total_matched: totalMatched,
          needs_narrowing: true,
          by_subject,
          _source: `Banner schedule ${meta.fetchedAt}`,
          note:
            `${totalMatched} sections fit — too many to list well. Ask the advisor to narrow first: ` +
            `a subject area (the most common are in by_subject), tighter days/time, or more open ` +
            `seats (min_seats).` + asyncNote,
        });
      }

      const result: Record<string, unknown> = {
        term,
        applied_constraints: appliedConstraints,
        total_matched: totalMatched,
        sections: matches,
        _source: `Banner schedule ${meta.fetchedAt}`,
      };
      if (asyncNote) result.note = asyncNote.trim();

      return okJson(result);
    } finally {
      schedDb.close();
    }
  },
};

// ---------------------------------------------------------------------------
// get-program-requirements — surfaces the requirement_rule rows in
// gc_advisor.db for any program (minor, certificate, or the GC BS), by name.
// Unlike find-eligible-sections/find-sections-by-schedule this does NOT open
// a Banner schedule snapshot — it's a pure read of the catalog DB, so the GC
// program-loaded restriction that gates those tools doesn't apply here: any
// of the 133 minors/certificates plus the GC BS can be looked up.
// ---------------------------------------------------------------------------

interface ProgramRow {
  id: number;
  name: string;
  year: string;
}

export const getProgramRequirements: McpToolDefinition = {
  operation: "clemson.gc_program_requirements",
  tool: {
    name: "get-program-requirements",
    description:
      "Get the requirement rules a Clemson MINOR or CERTIFICATE requires " +
      "(total credits, required courses, elective rules) from the catalog. " +
      "Use for 'what does the Accounting minor require?'. Partial/misspelled " +
      "names return candidate program names to pick from. NOTE: only " +
      "Graphic Communications, BS has a full semester-by-semester plan — use " +
      "get-gc-program-plan for that; other full majors are not loaded.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Program name, e.g. 'Accounting Minor' or 'Cybersecurity Minor'. " +
            "A partial name returns candidates.",
        },
        year: {
          type: "string",
          description:
            "Optional catalog year, e.g. '2025-2026'. Defaults to the latest.",
        },
      },
      required: ["name"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_program_requirements");
    } catch (e) {
      return permissionErr(e);
    }

    const name = args.name as string | undefined;
    if (!name || typeof name !== "string" || !name.trim())
      return err("name is required");

    const year =
      typeof args.year === "string" && args.year ? args.year : undefined;

    let db: Database.Database;
    try {
      db = new Database(GC_ADVISOR_DB, { readonly: true });
    } catch {
      return err(
        `Could not open the Clemson catalog database (gc_advisor.db). It may not be loaded yet.`,
      );
    }

    try {
      const exactRow = db
        .prepare(
          `SELECT p.id, p.name, cy.label AS year FROM program p
           JOIN catalog_year cy ON p.catalog_year_id = cy.id
           WHERE LOWER(p.name) = LOWER(?) ${year ? "AND cy.label = ?" : ""}
           ORDER BY cy.label DESC LIMIT 1`,
        )
        .get(...(year ? [name, year] : [name])) as ProgramRow | undefined;

      if (!exactRow) {
        const candidates = db
          .prepare(
            "SELECT DISTINCT name FROM program WHERE name LIKE ? ORDER BY name LIMIT 20",
          )
          .all(`%${name}%`) as { name: string }[];

        if (candidates.length > 0) {
          return okJson({
            query: name,
            candidates: candidates.map((c) => c.name),
            note: "No exact match — pick one of these program names and call again.",
          });
        }

        return err(
          `No Clemson program matches "${name}". Check the spelling, or ask for a minor/certificate by its full name.`,
        );
      }

      const ruleRows = db
        .prepare("SELECT slot_type, rule FROM requirement_rule WHERE program_id = ?")
        .all(exactRow.id) as { slot_type: string; rule: string }[];

      const requirements: Record<string, unknown>[] = [];
      for (const row of ruleRows) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.rule) as Record<string, unknown>;
        } catch {
          continue;
        }
        requirements.push({ slot_type: row.slot_type, ...parsed });
      }

      return okJson({
        program: exactRow.name,
        catalog_year: exactRow.year,
        requirements,
        _source: "Clemson Online Catalog (gc_advisor)",
        note:
          "Minor/certificate requirement rules. Only Graphic Communications, " +
          "BS has a full semester-by-semester plan (get-gc-program-plan).",
      });
    } finally {
      db.close();
    }
  },
};

registerTools([findEligibleSections, findSectionsBySchedule, getProgramRequirements]);
