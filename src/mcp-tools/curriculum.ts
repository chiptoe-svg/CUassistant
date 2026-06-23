// Public GC curriculum tools — backed by the gc_advisor project's query.py CLI
// (see src/gc-curriculum.ts). Read-only, public catalog data, no credentials.
import { getGcProgramPlan, listGcCatalogYears } from "../gc-curriculum.js";
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

registerTools([catalogYears, programPlan]);
