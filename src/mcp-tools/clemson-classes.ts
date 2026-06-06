// Clemson public class-schedule tools — backed by Banner 9 Browse Classes.
//
// Read-only, no login, works on or off the Clemson network. No Graph token and
// no Microsoft consent are involved; the only backend is the public Banner
// self-service search at regssb.sis.clemson.edu (see src/clemson-classes.ts).

import {
  getClemsonSectionDetails,
  listClemsonTerms,
  searchClemsonClasses,
} from "../clemson-classes.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const listTerms: McpToolDefinition = {
  operation: "clemson.list_terms",
  tool: {
    name: "list-clemson-terms",
    description:
      "List Clemson academic terms available in the public Banner class " +
      "search, e.g. {code:'202608', description:'Fall 2026'}. Read-only, no " +
      "login. Pass a term code to search-clemson-classes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        max: {
          type: "integer",
          description: "Max terms to return (default 20).",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.list_terms");
    } catch (e) {
      return permissionErr(e);
    }
    const max = typeof args.max === "number" ? args.max : 20;
    const terms = await listClemsonTerms(max);
    if (terms === null) return err("Clemson term list unavailable.");
    return okJson({ terms });
  },
};

const searchClasses: McpToolDefinition = {
  operation: "clemson.search_classes",
  tool: {
    name: "search-clemson-classes",
    description:
      "Search Clemson's public class schedule (Banner Browse Classes). " +
      "Read-only, no login, works on or off campus. Returns sections with " +
      "CRN, title, credit hours, seats available/max, waitlist counts, " +
      "instructor (name + email), and meeting days/time/building/room. " +
      "Requires a term code from list-clemson-terms; narrow with subject " +
      "(e.g. CPSC), courseNumber (e.g. 1010), and/or openOnly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: "Term code, e.g. 202608 (Fall 2026).",
        },
        subject: {
          type: "string",
          description: "Subject abbreviation, e.g. CPSC.",
        },
        courseNumber: {
          type: "string",
          description: "Course number, e.g. 1010.",
        },
        openOnly: {
          type: "boolean",
          description: "Only return sections with seats available.",
        },
        max: {
          type: "integer",
          description: "Max sections to return (default 50, capped at 500).",
        },
        offset: {
          type: "integer",
          description: "Page offset for paging (default 0).",
        },
      },
      required: ["term"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.search_classes");
    } catch (e) {
      return permissionErr(e);
    }
    const term = args.term as string | undefined;
    if (!term) return err("term is required (see list-clemson-terms)");
    const result = await searchClemsonClasses({
      term,
      subject: args.subject as string | undefined,
      courseNumber: args.courseNumber as string | undefined,
      openOnly: Boolean(args.openOnly),
      max: typeof args.max === "number" ? args.max : undefined,
      offset: typeof args.offset === "number" ? args.offset : undefined,
    });
    if (result === null) return err("Clemson class search failed.");
    return okJson(result);
  },
};

const sectionDetails: McpToolDefinition = {
  operation: "clemson.section_details",
  tool: {
    name: "get-clemson-section-details",
    description:
      "Get catalog detail for one section by term + CRN: course " +
      "description, prerequisites, corequisites, restrictions, section " +
      "attributes, and a bookstore link for required materials. Read-only, " +
      "no login. Get the CRN from search-clemson-classes. (There is no " +
      "parsed textbook list — Banner only exposes a bookstore URL.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: "Term code, e.g. 202608 (Fall 2026).",
        },
        crn: {
          type: "string",
          description: "Course Reference Number, e.g. 85865.",
        },
      },
      required: ["term", "crn"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.section_details");
    } catch (e) {
      return permissionErr(e);
    }
    const term = args.term as string | undefined;
    const crn = args.crn as string | undefined;
    if (!term || !crn) return err("term and crn are required");
    const details = await getClemsonSectionDetails(term, crn);
    if (details === null) return err("Clemson section details unavailable.");
    return okJson(details);
  },
};

registerTools([listTerms, searchClasses, sectionDetails]);
