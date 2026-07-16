// src/mcp-tools/clemson-advising.ts
// Catalog + schedule join tool for GC advising.
//
// find-eligible-sections opens the per-term schedule DB, ATTACHes gc_advisor.db,
// and runs the requirement → offered-sections join in SQL. Prereq eligibility is
// checked in TypeScript (parse prereq_parsed JSON, test subset of completed_courses).
import Database from "better-sqlite3";

import { GC_ADVISOR_DB } from "../config.js";
import { openScheduleDb, getScheduleDbMeta } from "../clemson-schedule-db.js";
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
  return codes.every((c) => completedCourses.has(c));
}

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

const findEligibleSections: McpToolDefinition = {
  operation: "clemson.find_eligible_sections",
  tool: {
    name: "find-eligible-sections",
    description:
      "Find Banner sections offered in a given term that fulfill a GC " +
      "degree requirement slot AND are prereq-eligible for the student. " +
      "Returns section details (CRN, title, credits, seats, meetings) plus " +
      "`prereq_eligible` per section based on the completed-courses list. " +
      "Use slot_type values from get-gc-requirement-rules (e.g. " +
      "'Specialty Area Requirement', 'Graphic Communication Technical Requirement'). " +
      "Pass completed_courses as a list of course codes the student has passed " +
      "(e.g. [\"GC 1010\", \"GC 2010\"]) — used only for prereq gating, " +
      "no identity or grade data needed.",
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

    const schedDb = openScheduleDb(term);
    if (!schedDb)
      return err(
        `No Banner snapshot available for term ${term}. Try again after the 05:00 daily refresh.`,
      );

    try {
      // ATTACH the catalog DB so we can query it alongside the schedule.
      schedDb.prepare("ATTACH DATABASE ? AS catalog").run(GC_ADVISOR_DB);

      const programId = getLatestProgramId(schedDb, programName);
      if (programId === null) {
        return err(
          `Program "${programName}" not found in gc_advisor.db. ` +
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
        .all(term, ...rule.explicit_courses) as SectionRow[];

      if (sectionRows.length === 0) {
        return okJson({
          term,
          slot_type: slotType,
          total_credits_required: rule.total_credits,
          sections: [],
          note: "No sections are offered in this term for the eligible course list.",
        });
      }

      const crns = sectionRows.map((r) => r.crn);
      const crnPhs = crns.map(() => "?").join(",");

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

      const subjectCourses = [...new Set(sectionRows.map((r) => r.subject_course))];
      const scPhs = subjectCourses.map(() => "?").join(",");
      const courseRows = schedDb
        .prepare(
          `SELECT code, prereq_text, prereq_parsed
           FROM catalog.course WHERE code IN (${scPhs})`,
        )
        .all(...subjectCourses) as CourseRow[];
      const courseMap = new Map(courseRows.map((c) => [c.code, c]));

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

      const completedSet = new Set(completedCoursesArr);
      const meta = getScheduleDbMeta(schedDb);

      const sections = sectionRows.map((row) => {
        const courseInfo = courseMap.get(row.subject_course);
        const prereqEligible = checkPrereqEligible(
          courseInfo?.prereq_parsed ?? null,
          completedSet,
        );
        const mgMap = meetingMap.get(row.crn);
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
        return {
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
      });

      return okJson({
        term,
        term_description: meta.termDescription,
        slot_type: slotType,
        total_credits_required: rule.total_credits,
        sections,
        _source: `Clemson University Online Catalog (gc_advisor) + Banner schedule ${meta.fetchedAt}`,
      });
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

registerTools([findEligibleSections]);
