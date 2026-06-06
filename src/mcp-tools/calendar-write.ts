// Calendar write tools — backed by the GCassistant Graph app
// (Calendars.ReadWrite).
//
// create/update events are exposed: they map to policy actions
// calendar.create_personal_event / calendar.update_personal_event
// (approval=none) and are constrained to the user's own primary calendar with
// no attendees/invites.
//
// delete and RSVP (accept/decline/tentativelyAccept) are wired to a real
// backend but remain policy-gated: they map to calendar.delete_event /
// calendar.respond_to_invite, which are approval=human_required in
// action-policy.yaml. assertMcpOperation refuses them and the server does not
// register them (isMcpOperationExposed=false) until policy is widened.

import { startMcpAudit, finishMcpAudit } from "./audit.js";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  rsvpCalendarEvent,
  updateCalendarEvent,
} from "./graph-helpers.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const createCalendarEventTool: McpToolDefinition = {
  operation: "calendar.create_event",
  tool: {
    name: "create-calendar-event",
    description:
      "Create an event on the user's primary calendar. Personal events only " +
      "— attendees/invites and shared/delegated calendars are rejected by " +
      "policy.",
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
          description:
            "Attendee email addresses. Rejected by policy — personal events " +
            "only. Present so the policy gate can refuse invites explicitly.",
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
      assertMcpOperation("calendar.create_event", { input: args });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return permissionErr(e);
    }
    const event = await createCalendarEvent({
      subject,
      startIso,
      endIso,
      location: args.location as string | undefined,
      bodyContent: args.bodyContent as string | undefined,
    });
    if (!event) {
      finishMcpAudit(audit, { result: "error", detail: "graph_create_failed" });
      return err("Graph failed to create the event.");
    }
    finishMcpAudit(audit, { result: "success", object_id: event.id });
    return okJson({ event });
  },
};

const updateCalendarEventTool: McpToolDefinition = {
  operation: "calendar.update_event",
  tool: {
    name: "update-calendar-event",
    description:
      "Patch an event on the user's primary calendar (subject, start, end, " +
      "location, body). Personal events only — shared/delegated calendars " +
      "are rejected by policy.",
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
      assertMcpOperation("calendar.update_event", { input: args });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return permissionErr(e);
    }
    const event = await updateCalendarEvent(id, {
      subject: args.subject as string | undefined,
      startIso: args.startIso as string | undefined,
      endIso: args.endIso as string | undefined,
      location: args.location as string | undefined,
      bodyContent: args.bodyContent as string | undefined,
    });
    if (!event) {
      finishMcpAudit(audit, { result: "error", detail: "graph_update_failed" });
      return err("Graph failed to update the event.");
    }
    finishMcpAudit(audit, { result: "success", object_id: event.id });
    return okJson({ event });
  },
};

const deleteCalendarEventTool: McpToolDefinition = {
  operation: "calendar.delete_event",
  tool: {
    name: "delete-calendar-event",
    description:
      "Delete a calendar event. Policy-gated (approval=human_required); not " +
      "exposed until policy is widened.",
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
      assertMcpOperation("calendar.delete_event", { input: args });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return permissionErr(e);
    }
    const result = await deleteCalendarEvent(id);
    if (!result.ok) {
      finishMcpAudit(audit, {
        result: "error",
        detail: `graph_delete_failed status=${result.status ?? "null"}`,
      });
      return err(
        `Graph failed to delete the event (status ${result.status ?? "null"}).`,
      );
    }
    finishMcpAudit(audit, { result: "success", object_id: id });
    return okJson({ deleted: true, id });
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
    operation,
    tool: {
      name: toolName,
      description:
        `RSVP "${graphAction}" on a calendar event. Policy-gated ` +
        "(approval=human_required); not exposed until policy is widened.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Event id." },
          comment: {
            type: "string",
            description: "Optional response comment.",
          },
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
        assertMcpOperation(operation, { input: args });
      } catch (e) {
        finishMcpAudit(audit, { result: "error", detail: String(e) });
        return permissionErr(e);
      }
      const result = await rsvpCalendarEvent(id, graphAction, {
        comment: args.comment as string | undefined,
        sendResponse: args.sendResponse as boolean | undefined,
      });
      if (!result.ok) {
        finishMcpAudit(audit, {
          result: "error",
          detail: `graph_rsvp_failed status=${result.status ?? "null"}`,
        });
        return err(`Graph failed to RSVP (status ${result.status ?? "null"}).`);
      }
      finishMcpAudit(audit, { result: "success", object_id: id });
      return okJson({ rsvp: graphAction, id });
    },
  };
}

registerTools([
  createCalendarEventTool,
  updateCalendarEventTool,
  deleteCalendarEventTool,
  rsvpTool("accept-calendar-event", "calendar.accept_event", "accept"),
  rsvpTool("decline-calendar-event", "calendar.decline_event", "decline"),
  rsvpTool(
    "tentatively-accept-calendar-event",
    "calendar.tentatively_accept_event",
    "tentativelyAccept",
  ),
]);
