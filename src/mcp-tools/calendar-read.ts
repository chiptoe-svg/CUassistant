// Calendar read tools — backed by the GCassistant Graph app
// (Calendars.ReadWrite).
//
// Tool names mirror CUagent's @softeria/ms-365-mcp-server surface. Calls go
// through the shared MCP Graph helper (authedFetch on getMs365AccessToken),
// gated by assertMcpOperation.

import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";
import {
  getCalendarEvent as getCalendarEventGraph,
  getCalendarView as getCalendarViewGraph,
  listCalendarEvents as listCalendarEventsGraph,
} from "./graph-helpers.js";

const listCalendarEvents: McpToolDefinition = {
  operation: "calendar.list_events",
  tool: {
    name: "list-calendar-events",
    description:
      "List the user's calendar events ordered by start time. Read-only. " +
      "Backed by the GCassistant Graph app. For a date-range view that " +
      "expands recurrences, use get-calendar-view.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fromIso: {
          type: ["string", "null"],
          description:
            "Lower bound on start time, ISO 8601. Pass null to omit.",
        },
        toIso: {
          type: ["string", "null"],
          description:
            "Upper bound on start time, ISO 8601. Pass null to omit.",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("calendar.list_events");
    } catch (e) {
      return permissionErr(e);
    }
    const fromIso = (args.fromIso as string | null | undefined) ?? null;
    const toIso = (args.toIso as string | null | undefined) ?? null;
    const events = await listCalendarEventsGraph({ fromIso, toIso });
    if (events === null) {
      return err("Graph calendar list failed (token or provider unavailable).");
    }
    return okJson({ events });
  },
};

const getCalendarEvent: McpToolDefinition = {
  operation: "calendar.get_event",
  tool: {
    name: "get-calendar-event",
    description:
      "Fetch a single calendar event by id. Read-only. Backed by the " +
      "GCassistant Graph app.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The calendar event id." },
      },
      required: ["id"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("calendar.get_event");
    } catch (e) {
      return permissionErr(e);
    }
    const id = args.id as string | undefined;
    if (!id) return err("id is required");
    const event = await getCalendarEventGraph(id);
    if (event === null) {
      return err(`Graph returned no event for id "${id}".`);
    }
    return okJson({ event });
  },
};

const getCalendarView: McpToolDefinition = {
  operation: "calendar.get_view",
  tool: {
    name: "get-calendar-view",
    description:
      "Return events in a calendar window with recurrences expanded into " +
      "their occurrences. Read-only. Backed by the GCassistant Graph app. " +
      "Use this for 'what's on my calendar today/this week' " +
      "queries; use list-calendar-events for the raw event objects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        startIso: {
          type: "string",
          description: "Start of window, ISO 8601.",
        },
        endIso: {
          type: "string",
          description: "End of window, ISO 8601.",
        },
      },
      required: ["startIso", "endIso"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("calendar.get_view");
    } catch (e) {
      return permissionErr(e);
    }
    const startIso = args.startIso as string | undefined;
    const endIso = args.endIso as string | undefined;
    if (!startIso || !endIso) return err("startIso and endIso are required");
    const events = await getCalendarViewGraph({ startIso, endIso });
    if (events === null) {
      return err("Graph calendar view failed (token or provider unavailable).");
    }
    return okJson({ events });
  },
};

registerTools([listCalendarEvents, getCalendarEvent, getCalendarView]);
