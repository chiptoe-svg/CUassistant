// Clemson public class-schedule tools — backed by Banner 9 Browse Classes.
//
// Read-only, no login, works on or off the Clemson network. No Graph token and
// no Microsoft consent are involved; the only backend is the public Banner
// self-service search at regssb.sis.clemson.edu (see src/clemson-classes.ts).

import {
  findClemsonInstructorClasses,
  getClemsonRoomAvailability,
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
      "(e.g. CPSC), courseNumber (e.g. 1010), and/or openOnly. " +
      "Served from the daily snapshot when available (fast, no Banner load); " +
      "falls back to a live Banner query if no snapshot exists yet. " +
      "Pass refresh:true only if you need up-to-the-minute seat counts.",
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
        refresh: {
          type: "boolean",
          description:
            "Force a live Banner query instead of the daily snapshot " +
            "(slower; use only when you need up-to-the-minute seat counts).",
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
      refresh: Boolean(args.refresh),
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

const instructorClasses: McpToolDefinition = {
  operation: "clemson.instructor_classes",
  tool: {
    name: "find-clemson-instructor-classes",
    description:
      "Find every section a Clemson instructor is teaching in a given " +
      "semester, with meeting times, rooms, and seats. Read-only, no login. " +
      "Give a faculty name (e.g. 'Kern Cox') and a semester as either a term " +
      "code (202608) or text ('Fall 2026'). If the name is ambiguous (e.g. " +
      "just 'Cox') it returns `candidates` to choose from and no sections; " +
      "when it resolves to one person, `matched` is set and `sections` is " +
      "populated. Normally served from the daily class snapshot, so it is fast " +
      "and needs no `subject`. Pass `subject` (e.g. GC, CPSC) only as a " +
      "fallback for a term with no snapshot yet — it scopes a live scan to one " +
      "department instead of the full term.",
    inputSchema: {
      type: "object" as const,
      properties: {
        instructor: {
          type: "string",
          description: "Faculty name, e.g. 'Kern Cox' or 'Cox'.",
        },
        term: {
          type: "string",
          description: "Term code (202608) or text ('Fall 2026').",
        },
        subject: {
          type: "string",
          description:
            "Optional. Subject/department, e.g. GC or CPSC. Only used as a " +
            "cold-term fallback (no snapshot yet) to scope a live scan; " +
            "ignored when the snapshot is present.",
        },
        openOnly: {
          type: "boolean",
          description: "Only return sections with seats available.",
        },
        max: {
          type: "integer",
          description: "Max sections to return (default 50).",
        },
        refresh: {
          type: "boolean",
          description:
            "Force a fresh full-term scan instead of using the daily " +
            "snapshot (slower; use when you need up-to-the-minute data).",
        },
      },
      required: ["instructor", "term"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.instructor_classes");
    } catch (e) {
      return permissionErr(e);
    }
    const instructor = args.instructor as string | undefined;
    const term = args.term as string | undefined;
    if (!instructor || !term) return err("instructor and term are required");
    const result = await findClemsonInstructorClasses({
      instructor,
      term,
      subject: args.subject as string | undefined,
      openOnly: Boolean(args.openOnly),
      max: typeof args.max === "number" ? args.max : undefined,
      refresh: Boolean(args.refresh),
    });
    if (result === null) {
      return err(
        "Could not resolve the term, or the Clemson lookup was unavailable.",
      );
    }
    return okJson(result);
  },
};

const roomAvailability: McpToolDefinition = {
  operation: "clemson.room_availability",
  tool: {
    name: "get-clemson-room-availability",
    description:
      "Show when a classroom is free vs. occupied on a day pattern, derived " +
      "from scheduled classes. Give building (e.g. 'Godfrey'), room (e.g. " +
      "'205'), semester (code or text), and an optional day pattern (default " +
      "'MW' — a free slot is open on ALL listed days). Returns busy blocks " +
      "(with the courses) and free blocks within a day window (default " +
      "08:00-22:00). Classes only — ad-hoc 25Live events are NOT included " +
      "(25Live's public API doesn't expose most rooms). Served from the daily " +
      "snapshot — fast and complete; **leave `subject` off for room questions**: " +
      "a room hosts classes from many departments, and `subject` narrows to one " +
      "(it can undercount what's actually in the room). `subject` is only a " +
      "cold-term fallback when no snapshot exists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        building: {
          type: "string",
          description: "Building name or fragment, e.g. 'Godfrey'.",
        },
        room: { type: "string", description: "Room number, e.g. '205'." },
        term: {
          type: "string",
          description: "Term code (202608) or text ('Fall 2026').",
        },
        days: {
          type: "string",
          description:
            "Day pattern using M T W R F S U, e.g. 'MW', 'TR', 'MWF'. " +
            "Default 'MW'. Free slots are open on every day listed.",
        },
        subject: {
          type: "string",
          description:
            "Optional, and best left OFF for rooms. Cold-term fallback only: " +
            "scopes a live scan to one department, which UNDERCOUNTS a room " +
            "(rooms host multiple departments). Ignored when the snapshot " +
            "is present.",
        },
        dayStart: {
          type: "string",
          description: "Window start as HHMM, default 0800.",
        },
        dayEnd: {
          type: "string",
          description: "Window end as HHMM, default 2200.",
        },
        minMinutes: {
          type: "integer",
          description: "Ignore free gaps shorter than this (default 50).",
        },
        refresh: {
          type: "boolean",
          description:
            "Force a fresh full-term scan instead of using the daily " +
            "snapshot (slower; use when you need up-to-the-minute data).",
        },
      },
      required: ["building", "room", "term"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.room_availability");
    } catch (e) {
      return permissionErr(e);
    }
    const building = args.building as string | undefined;
    const room = args.room as string | undefined;
    const term = args.term as string | undefined;
    if (!building || !room || !term)
      return err("building, room, and term are required");
    const result = await getClemsonRoomAvailability({
      building,
      room,
      term,
      days: args.days as string | undefined,
      subject: args.subject as string | undefined,
      dayStart: args.dayStart as string | undefined,
      dayEnd: args.dayEnd as string | undefined,
      minMinutes:
        typeof args.minMinutes === "number" ? args.minMinutes : undefined,
      refresh: Boolean(args.refresh),
    });
    if (result === null) {
      return err(
        "Could not resolve the term, or the Clemson lookup was unavailable.",
      );
    }
    return okJson(result);
  },
};

registerTools([
  listTerms,
  searchClasses,
  sectionDetails,
  instructorClasses,
  roomAvailability,
]);
