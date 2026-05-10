// Calendar read tools — backed by the Codex CLI Outlook connector.
//
// Tool names mirror CUagent's @softeria/ms-365-mcp-server surface. The backend
// is the Codex Outlook connector wrapper in src/mcp-tools/codex-calendar.ts.

import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";
import {
  getCalendarEventWithCodex,
  getCalendarViewWithCodex,
  listCalendarEventsWithCodex,
} from "./codex-calendar.js";

const listCalendarEvents: McpToolDefinition = {
  tool: {
    name: "list-calendar-events",
    description:
      "List the user's calendar events ordered by start time. Read-only. " +
      "Backed by Codex CLI's Outlook connector. For a date-range view that " +
      "expands recurrences, use get-calendar-view.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fromIso: {
          type: ["string", "null"],
          description: "Lower bound on start time, ISO 8601. Pass null to omit.",
        },
        toIso: {
          type: ["string", "null"],
          description: "Upper bound on start time, ISO 8601. Pass null to omit.",
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
    const events = await listCalendarEventsWithCodex({ fromIso, toIso });
    if (events === null) {
      return err("Codex Outlook connector returned no result for calendar list.");
    }
    return okJson({ events });
  },
};

const getCalendarEvent: McpToolDefinition = {
  tool: {
    name: "get-calendar-event",
    description:
      "Fetch a single calendar event by id. Read-only. Backed by Codex " +
      "CLI's Outlook connector.",
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
    const event = await getCalendarEventWithCodex(id);
    if (event === null) {
      return err(`Codex Outlook connector returned no event for id "${id}".`);
    }
    return okJson({ event });
  },
};

const getCalendarView: McpToolDefinition = {
  tool: {
    name: "get-calendar-view",
    description:
      "Return events in a calendar window with recurrences expanded into " +
      "their occurrences. Read-only. Backed by Codex CLI's Outlook " +
      "connector. Use this for 'what's on my calendar today/this week' " +
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
    const events = await getCalendarViewWithCodex({ startIso, endIso });
    if (events === null) {
      return err("Codex Outlook connector returned no result for calendar view.");
    }
    return okJson({ events });
  },
};

registerTools([listCalendarEvents, getCalendarEvent, getCalendarView]);
