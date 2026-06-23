// Public GC curriculum tools — backed by the gc_advisor project's query.py CLI
// (see src/gc-curriculum.ts). Read-only, public catalog data, no credentials.
import { getGcProgramPlan, listGcCatalogYears, getGcRequirementRules, getGcGenEd, getGcCourse } from "../gc-curriculum.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

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
      return okJson({ years });
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
      return okJson(plan);
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
      "total credits, and raw footnote text. Read-only, no login.",
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
      return okJson(rules);
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
      "Read-only, no login.",
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
      return okJson(cats);
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
      'Example code: "GC 3010" or "MKTG 3010".',
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
      return okJson(c);
    } catch (e) {
      return err(`GC course lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

registerTools([catalogYears, programPlan, requirementRules, genEd, course]);
