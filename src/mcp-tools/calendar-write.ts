// Calendar write tools — STUBs pending IT approval.
//
// Calendars.ReadWrite is needed on the Graph CLI client to activate these.
// To activate: confirm Calendars.ReadWrite is consented for the Graph CLI
// app, update the scope set in the token-refresh helper, flip the relevant
// status flags in src/mcp-tools/permissions.ts, and replace the stub with
// the active backend call (sketched in each handler comment).

import { startMcpAudit, finishMcpAudit } from "./audit.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, permissionErr, type McpToolDefinition } from "./types.js";

const createCalendarEvent: McpToolDefinition = {
  tool: {
    name: "create-calendar-event",
    description:
      "Create a calendar event on the user's primary calendar. STUB " +
      "pending IT approval of Calendars.ReadWrite on the Graph CLI client.",
    inputSchema: {
      type: "object" as const,
      properties: {
        subject: { type: "string" },
        startIso: { type: "string", description: "ISO 8601 start." },
        endIso: { type: "string", description: "ISO 8601 end." },
        location: { type: "string" },
        bodyContent: { type: "string" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Attendee email addresses.",
        },
      },
      required: ["subject", "startIso", "endIso"],
    },
  },
  async handler(args) {
    const subject = args.subject as string | undefined;
    const startIso = args.startIso as string | undefined;
    const endIso = args.endIso as string | undefined;
    if (!subject || !startIso || !endIso)
      return err("subject, startIso, endIso are required");
    const audit = startMcpAudit({
      operation: "calendar.create_event",
      toolName: "create-calendar-event",
      argsSummary: {
        subject_length: subject.length,
        startIso,
        endIso,
        attendee_count: Array.isArray(args.attendees)
          ? (args.attendees as unknown[]).length
          : 0,
      },
    });
    try {
      // Active call (commented until Calendars.ReadWrite consent lands):
      //   mg form: mg me events create --body @event.json
      //   HTTP form:
      //     await authedFetch("/me/events", {
      //       method: "POST",
      //       body: JSON.stringify({
      //         subject,
      //         start: { dateTime: startIso, timeZone: TIMEZONE },
      //         end: { dateTime: endIso, timeZone: TIMEZONE },
      //         location: location ? { displayName: location } : undefined,
      //         body: bodyContent ? { contentType: "text", content: bodyContent } : undefined,
      //         attendees: attendees?.map(a => ({ emailAddress: { address: a }, type: "required" })),
      //       }),
      //     });
      assertMcpOperation("calendar.create_event");
      finishMcpAudit(audit, { result: "error", detail: "unreachable" });
      return err("unreachable");
    } catch (e) {
      finishMcpAudit(audit, {
        result: "stub-blocked",
        detail: "calendar.create_event pending Calendars.ReadWrite consent",
      });
      return permissionErr(e);
    }
  },
};

const updateCalendarEvent: McpToolDefinition = {
  tool: {
    name: "update-calendar-event",
    description:
      "Patch a calendar event (subject, start, end, location, body). STUB " +
      "pending IT approval of Calendars.ReadWrite on the Graph CLI client.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string" },
        subject: { type: "string" },
        startIso: { type: "string" },
        endIso: { type: "string" },
        location: { type: "string" },
        bodyContent: { type: "string" },
      },
      required: ["id"],
    },
  },
  async handler(args) {
    const id = args.id as string | undefined;
    if (!id) return err("id is required");
    const audit = startMcpAudit({
      operation: "calendar.update_event",
      toolName: "update-calendar-event",
      argsSummary: {
        id_present: true,
        fields_changed: [
          args.subject !== undefined && "subject",
          args.startIso !== undefined && "start",
          args.endIso !== undefined && "end",
          args.location !== undefined && "location",
          args.bodyContent !== undefined && "body",
        ].filter(Boolean),
      },
    });
    try {
      // Active call:
      //   mg form: mg me events update --event-id <id> --body @patch.json
      //   HTTP form: await authedFetch(`/me/events/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      assertMcpOperation("calendar.update_event");
      finishMcpAudit(audit, { result: "error", detail: "unreachable" });
      return err("unreachable");
    } catch (e) {
      finishMcpAudit(audit, {
        result: "stub-blocked",
        detail: "calendar.update_event pending Calendars.ReadWrite consent",
      });
      return permissionErr(e);
    }
  },
};

const deleteCalendarEvent: McpToolDefinition = {
  tool: {
    name: "delete-calendar-event",
    description:
      "Delete a calendar event. STUB pending IT approval of " +
      "Calendars.ReadWrite on the Graph CLI client.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  async handler(args) {
    const id = args.id as string | undefined;
    if (!id) return err("id is required");
    const audit = startMcpAudit({
      operation: "calendar.delete_event",
      toolName: "delete-calendar-event",
      argsSummary: { id_present: true },
    });
    try {
      // Active call:
      //   mg form: mg me events delete --event-id <id>
      //   HTTP form: await authedFetch(`/me/events/${id}`, { method: "DELETE" });
      assertMcpOperation("calendar.delete_event");
      finishMcpAudit(audit, { result: "error", detail: "unreachable" });
      return err("unreachable");
    } catch (e) {
      finishMcpAudit(audit, {
        result: "stub-blocked",
        detail: "calendar.delete_event pending Calendars.ReadWrite consent",
      });
      return permissionErr(e);
    }
  },
};

function rsvpTool(
  toolName: string,
  operation:
    | "calendar.accept_event"
    | "calendar.decline_event"
    | "calendar.tentatively_accept_event",
  graphAction: "accept" | "decline" | "tentativelyAccept",
): McpToolDefinition {
  return {
    tool: {
      name: toolName,
      description:
        `RSVP "${graphAction}" on a calendar event. STUB pending IT ` +
        "approval of Calendars.ReadWrite on the Graph CLI client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Event id." },
          comment: { type: "string", description: "Optional response comment." },
          sendResponse: {
            type: "boolean",
            description: "Whether to email the organizer the response.",
          },
        },
        required: ["id"],
      },
    },
    async handler(args) {
      const id = args.id as string | undefined;
      if (!id) return err("id is required");
      const audit = startMcpAudit({
        operation,
        toolName,
        argsSummary: {
          id_present: true,
          has_comment: typeof args.comment === "string",
          send_response: args.sendResponse !== false,
        },
      });
      try {
        // Active call:
        //   mg form: mg me events ${graphAction} --event-id <id> --body @rsvp.json
        //   HTTP form:
        //     await authedFetch(`/me/events/${id}/${graphAction}`, {
        //       method: "POST",
        //       body: JSON.stringify({ comment, sendResponse }),
        //     });
        assertMcpOperation(operation);
        finishMcpAudit(audit, { result: "error", detail: "unreachable" });
        return err("unreachable");
      } catch (e) {
        finishMcpAudit(audit, {
          result: "stub-blocked",
          detail: `${operation} pending Calendars.ReadWrite consent`,
        });
        return permissionErr(e);
      }
    },
  };
}

registerTools([
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  rsvpTool("accept-calendar-event", "calendar.accept_event", "accept"),
  rsvpTool("decline-calendar-event", "calendar.decline_event", "decline"),
  rsvpTool(
    "tentatively-accept-calendar-event",
    "calendar.tentatively_accept_event",
    "tentativelyAccept",
  ),
]);
