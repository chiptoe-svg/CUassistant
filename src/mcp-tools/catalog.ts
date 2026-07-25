// Public GC curriculum tools — backed by the gc_advisor project's query.py CLI
// (see src/gc-curriculum.ts). Read-only, public catalog data, no credentials.
import Database from "better-sqlite3";

import { getGcProgramPlan, listGcCatalogYears, getGcRequirementRules, getGcGenEd, getGcCourse, auditGcProgress } from "../gc-curriculum.js";
import { GC_ADVISOR_DB } from "../config.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// GC core courses come in lecture/lab pairs: a graded lecture (e.g. GC 4060)
// and a non-credit lab COREQ (GC 4061) taken together — advisors say "4060"
// meaning "4060/4061". gc_advisor now carries this structurally in
// course.coreq_parsed (a JSON array of codes, both directions), so we read that
// and just enrich each code with its title/credits (which the column lacks).
// The description-parse remains only as a transitional fallback for a catalog
// snapshot old enough to predate the coreq backfill.

export interface CoreqCourse {
  code: string;
  title: string | null;
  credits: string | null;
  relationship: string;
}

interface CourseRow {
  code: string;
  title: string | null;
  credits: string | null;
}

/** Normalize "gc4060"/"GC 4060" -> "GC 4060" (uppercase subject + space + number). */
function normCourseCode(raw: string): string | null {
  const m = /^\s*([A-Za-z]{2,4})\s*(\d{3,4}[A-Za-z]?)\s*$/.exec(raw);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

function isLabLike(title: string | null, credits: string | null): boolean {
  return credits === "0" || (title ?? "").toLowerCase().includes("laborator");
}

/** Describe the pair direction from which side is the non-credit lab. */
function relationshipFor(queried: CourseRow, paired: CourseRow): string {
  if (isLabLike(paired.title, paired.credits)) return "required non-credit lab (coreq)";
  if (isLabLike(queried.title, queried.credits)) return "lecture this lab accompanies";
  return "corequisite";
}

/**
 * Return the corequisite course(s) paired with `code`, enriched with title and
 * credits. Reads the structured coreq_parsed column (authoritative, both
 * directions); falls back to parsing the lab-description prose only when that
 * column is empty. Empty array when there is no coreq or the DB is unavailable.
 */
export function findCoreqs(rawCode: string): CoreqCourse[] {
  const code = normCourseCode(rawCode);
  if (!code) return [];

  let db: Database.Database;
  try {
    db = new Database(GC_ADVISOR_DB, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const queried = db
      .prepare("SELECT code, title, credits, coreq_parsed, description FROM course WHERE code = ? LIMIT 1")
      .get(code) as
      | (CourseRow & { coreq_parsed: string | null; description: string | null })
      | undefined;
    if (!queried) return [];

    // Preferred path: the structured coreq_parsed JSON array.
    let codes: string[] = [];
    if (queried.coreq_parsed) {
      try {
        const arr = JSON.parse(queried.coreq_parsed);
        if (Array.isArray(arr)) codes = arr.filter((x): x is string => typeof x === "string");
      } catch {
        /* malformed — fall through to the prose fallback */
      }
    }

    if (codes.length === 0) {
      const fb = deriveCoreqFromDescription(db, code, queried.description);
      return fb ? [{ ...fb, relationship: relationshipFor(queried, fb) }] : [];
    }

    const out: CoreqCourse[] = [];
    for (const raw of codes) {
      const norm = normCourseCode(raw);
      if (!norm) continue;
      const row = db
        .prepare("SELECT code, title, credits FROM course WHERE code = ? LIMIT 1")
        .get(norm) as CourseRow | undefined;
      const paired: CourseRow = row ?? { code: norm, title: null, credits: null };
      out.push({ ...paired, relationship: relationshipFor(queried, paired) });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Transitional fallback: derive the pair from the lab-description prose the way
 *  we did before gc_advisor populated coreq_parsed. Single result or null. */
function deriveCoreqFromDescription(
  db: Database.Database,
  code: string,
  description: string | null,
): CourseRow | null {
  // Is the queried course itself a lab that names its lecture?
  const m = description ? /accompany\s+(GC\s*\d{3,4})/i.exec(description) : null;
  if (m) {
    const lectureCode = normCourseCode(m[1]);
    const lec = lectureCode
      ? (db.prepare("SELECT code, title, credits FROM course WHERE code = ? LIMIT 1").get(lectureCode) as CourseRow | undefined)
      : undefined;
    if (lec) return lec;
  }
  // Otherwise, is there a non-credit lab that accompanies THIS course?
  const lab = db
    .prepare(
      `SELECT code, title, credits FROM course
       WHERE description LIKE '%accompany%' AND description LIKE ?
         AND (credits = '0' OR title LIKE '%Laboratory%')
       LIMIT 1`,
    )
    .get(`%${code}%`) as CourseRow | undefined;
  return lab ?? null;
}

export const catalogYears: McpToolDefinition = {
  operation: "clemson.gc_catalog_years",
  tool: {
    name: "list-gc-catalog-years",
    description:
      "List Clemson catalog years available for Graphic Communications " +
      'curriculum lookups, e.g. "2026-2027". Read-only, no login. Pass a ' +
      "returned year to get-gc-program-plan.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  async handler() {
    try {
      assertMcpOperation("clemson.gc_catalog_years");
    } catch (e) {
      return permissionErr(e);
    }
    try {
      const years = await listGcCatalogYears();
      return okJson({
        years,
        _source: "Clemson University Online Catalog (gc_advisor)",
      });
    } catch (e) {
      return err(
        `GC catalog years unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export const programPlan: McpToolDefinition = {
  operation: "clemson.gc_program_plan",
  tool: {
    name: "get-gc-program-plan",
    description:
      "Get the full semester-by-semester degree plan for a Clemson program " +
      "in a given catalog year: required courses, choice sets (one-of), " +
      "requirement slots, per-term and total credits, and footnotes. " +
      "Read-only, no login. Defaults to the Graphic Communications, BS. " +
      "Get a valid year from list-gc-catalog-years.",
    inputSchema: {
      type: "object" as const,
      properties: {
        year: {
          type: "string",
          description:
            "Catalog year, e.g. 2026-2027 (from list-gc-catalog-years).",
        },
        name: {
          type: "string",
          description: 'Program name (default "Graphic Communications, BS").',
        },
      },
      required: ["year"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_program_plan");
    } catch (e) {
      return permissionErr(e);
    }
    const year = args.year as string | undefined;
    if (!year) return err("year is required (see list-gc-catalog-years)");
    const name =
      typeof args.name === "string" && args.name
        ? args.name
        : "Graphic Communications, BS";
    try {
      const plan = await getGcProgramPlan(year, name);
      return okJson({
        ...(plan as object),
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(
        `GC program plan lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export const requirementRules: McpToolDefinition = {
  operation: "clemson.gc_requirement_rules",
  tool: {
    name: "get-gc-requirement-rules",
    description:
      "Get the requirement rules for the GC Graphic Communications BS degree " +
      "in a given catalog year: lab science, specialty area (minor or 15-credit " +
      "course set), and technical requirement — with explicit course codes, " +
      "total credits, and raw footnote text. Read-only, no login. Does not " +
      "include General Education requirements (use get-gc-gen-ed) or the " +
      "full semester-by-semester course plan (use get-gc-program-plan).",
    inputSchema: {
      type: "object" as const,
      properties: {
        year: {
          type: "string",
          description: "Catalog year, e.g. 2026-2027 (from list-gc-catalog-years).",
        },
      },
      required: ["year"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_requirement_rules");
    } catch (e) {
      return permissionErr(e);
    }
    const year = args.year as string | undefined;
    if (!year) return err("year is required");
    try {
      const rules = await getGcRequirementRules(year, "Graphic Communications, BS");
      return okJson({
        ...(rules as object),
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(`GC requirement rules lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const genEd: McpToolDefinition = {
  operation: "clemson.gc_gen_ed",
  tool: {
    name: "get-gc-gen-ed",
    description:
      "Get Clemson's General Education requirements for a given catalog year: " +
      "6 categories (Communication, Mathematics, Natural Sciences with Lab, " +
      "Arts and Humanities, Social Sciences, Global Challenges) with minimum " +
      "credits, allowed course lists, constraint rules, and student learning outcomes. " +
      "Read-only, no login. For major-specific requirements (lab science, " +
      "specialty area, technical) use get-gc-requirement-rules instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        year: {
          type: "string",
          description: "Catalog year, e.g. 2026-2027 (from list-gc-catalog-years).",
        },
      },
      required: ["year"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_gen_ed");
    } catch (e) {
      return permissionErr(e);
    }
    const year = args.year as string | undefined;
    if (!year) return err("year is required");
    try {
      const cats = await getGcGenEd(year);
      return okJson({
        ...(cats as object),
        _source: `Clemson University Online Catalog, ${year} edition (gc_advisor)`,
      });
    } catch (e) {
      return err(`GC gen-ed lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const course: McpToolDefinition = {
  operation: "clemson.gc_course",
  tool: {
    name: "get-gc-course",
    description:
      "Get details for a Clemson course by code: title, credits, description, " +
      "prerequisites (raw text and parsed course codes). Read-only, no login. " +
      'Example code: "GC 3010" or "MKTG 3010". For a course with a corequisite ' +
      "(notably GC lecture/lab pairs), the result also includes a `coreqs` array " +
      "with the paired course(s) and their title/credits (e.g. GC 4060 returns " +
      "GC 4061, its required non-credit lab) — report them when asked about either.",
    inputSchema: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: 'Course code, e.g. "GC 3010" or "MKTG 3010".',
        },
      },
      required: ["code"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_course");
    } catch (e) {
      return permissionErr(e);
    }
    const code = args.code as string | undefined;
    if (!code) return err("code is required");
    try {
      const c = await getGcCourse(code);
      const coreqs = findCoreqs(code);
      return okJson({
        ...(c as object),
        ...(coreqs.length ? { coreqs } : {}),
        _source: "Clemson University Online Catalog (gc_advisor)",
      });
    } catch (e) {
      return err(`GC course lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const auditProgress: McpToolDefinition = {
  operation: "clemson.gc_audit_progress",
  tool: {
    name: "audit-gc-progress",
    description:
      "Run a deterministic GC BS degree audit on a sanitized gc-progress-v1 " +
      "record (passed course codes + terms + credits, in-progress, declared " +
      "minor — NO grades or identity; produced by the GC Advisor clean flow). " +
      "Returns requirements met/remaining, gen-ed progress, credits left, and " +
      "prereq-eligible next courses. Use the results to advise; never compute " +
      "the audit yourself.",
    inputSchema: {
      type: "object" as const,
      properties: {
        progress: {
          type: "object",
          description: "gc-progress-v1 JSON object (from the GC Advisor page's cleaned output).",
        },
      },
      required: ["progress"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_audit_progress");
    } catch (e) {
      return permissionErr(e);
    }
    if (!args.progress || typeof args.progress !== "object")
      return err("progress (gc-progress-v1 object) is required");
    try {
      return okJson(await auditGcProgress(args.progress));
    } catch (e) {
      return err(`GC audit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

registerTools([catalogYears, programPlan, requirementRules, genEd, course, auditProgress]);
