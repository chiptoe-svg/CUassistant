// Mail write tools — STUBs pending IT approval.
//
// Mail.ReadWrite is needed on the Graph CLI client to activate these.
// CUassistant's existing GCassistant Azure app holds Mail.ReadWrite for the
// scan flow's Inbox listing and body fetch, but mail *writes* (move, mark
// read, draft) are routed through the Graph CLI client to keep the consent
// envelope narrow and reviewable per-client. The Graph CLI client today is
// consented for Tasks.ReadWrite only at Clemson; adding Mail.ReadWrite is
// the IT step that activates these tools.
//
// Each tool below returns a structured stub-pending-approval error today.
// To activate a tool when consent lands:
//   1. Confirm Mail.ReadWrite is in the Graph CLI's consented scopes.
//   2. Update the scope set requested in graph-cli-tasks.ts (or a new
//      mail-write helper that reuses the same refresh token).
//   3. Remove the `status: "stub-pending-approval"` flag in
//      src/mcp-tools/permissions.ts for the matching operation key.
//   4. Replace the stub call below with the active backend invocation.
//      The active call is sketched as a comment inside each handler so the
//      activation is a localized edit rather than a rewrite.
//
// The mg-CLI form of each call is given in a comment for reviewers who
// prefer the shell view; the wired-up form will use authedFetch from
// src/mcp-tools/graph-cli-helpers.ts to stay consistent with the read path.

import { startMcpAudit, finishMcpAudit } from "./audit.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, permissionErr, type McpToolDefinition } from "./types.js";

const moveMailMessage: McpToolDefinition = {
  tool: {
    name: "move-mail-message",
    description:
      "Move an Outlook message into a target folder. STUB pending IT " +
      "approval of Mail.ReadWrite on the Graph CLI client.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Message id." },
        destinationId: {
          type: "string",
          description: "Target mail folder id (or wellKnownName).",
        },
      },
      required: ["id", "destinationId"],
    },
  },
  async handler(args) {
    const id = args.id as string | undefined;
    const destinationId = args.destinationId as string | undefined;
    if (!id || !destinationId)
      return err("id and destinationId are required");
    const audit = startMcpAudit({
      operation: "mail.move_message",
      toolName: "move-mail-message",
      argsSummary: { id_present: true, destinationId },
    });
    try {
      // Active call (commented until Mail.ReadWrite consent lands):
      //   mg client form:
      //     mg me messages move \
      //       --message-id <id> \
      //       --destination-id <destinationId>
      //   HTTP form (matches todo helpers):
      //     await authedFetch(`/me/messages/${id}/move`, {
      //       method: "POST",
      //       body: JSON.stringify({ destinationId }),
      //     });
      assertMcpOperation("mail.move_message");
      finishMcpAudit(audit, {
        result: "error",
        detail: "unreachable: stub gate should have refused",
      });
      return err("unreachable");
    } catch (e) {
      finishMcpAudit(audit, {
        result: "stub-blocked",
        detail: "mail.move_message pending Mail.ReadWrite consent",
      });
      return permissionErr(e);
    }
  },
};

const updateMailMessage: McpToolDefinition = {
  tool: {
    name: "update-mail-message",
    description:
      "Patch an Outlook message (mark read, set flag, adjust importance, " +
      "add categories). STUB pending IT approval of Mail.ReadWrite on the " +
      "Graph CLI client.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Message id." },
        isRead: { type: "boolean" },
        importance: { type: "string", enum: ["low", "normal", "high"] },
        flag: {
          type: "object",
          description: "Outlook flag object (e.g., {flagStatus: 'flagged'}).",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Outlook category names.",
        },
      },
      required: ["id"],
    },
  },
  async handler(args) {
    const id = args.id as string | undefined;
    if (!id) return err("id is required");
    const audit = startMcpAudit({
      operation: "mail.update_message",
      toolName: "update-mail-message",
      argsSummary: {
        id_present: true,
        fields_changed: [
          args.isRead !== undefined && "isRead",
          args.importance !== undefined && "importance",
          args.flag !== undefined && "flag",
          args.categories !== undefined && "categories",
        ].filter(Boolean),
      },
    });
    try {
      // Active call (commented until Mail.ReadWrite consent lands):
      //   mg form: mg me messages update --message-id <id> --body @patch.json
      //   HTTP form:
      //     await authedFetch(`/me/messages/${id}`, {
      //       method: "PATCH",
      //       body: JSON.stringify(patch),
      //     });
      assertMcpOperation("mail.update_message");
      finishMcpAudit(audit, {
        result: "error",
        detail: "unreachable: stub gate should have refused",
      });
      return err("unreachable");
    } catch (e) {
      finishMcpAudit(audit, {
        result: "stub-blocked",
        detail: "mail.update_message pending Mail.ReadWrite consent",
      });
      return permissionErr(e);
    }
  },
};

const createDraftEmail: McpToolDefinition = {
  tool: {
    name: "create-draft-email",
    description:
      "Create a new draft email in the user's Drafts folder. STUB pending " +
      "IT approval of Mail.ReadWrite on the Graph CLI client. Note: the " +
      "active form will create a draft only — there is no send tool in " +
      "this MCP server, by design.",
    inputSchema: {
      type: "object" as const,
      properties: {
        subject: { type: "string" },
        bodyContent: { type: "string" },
        bodyContentType: { type: "string", enum: ["text", "html"] },
        toRecipients: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses for the To line.",
        },
        ccRecipients: { type: "array", items: { type: "string" } },
        bccRecipients: { type: "array", items: { type: "string" } },
      },
      required: ["subject"],
    },
  },
  async handler(args) {
    const subject = args.subject as string | undefined;
    if (!subject) return err("subject is required");
    const audit = startMcpAudit({
      operation: "mail.create_draft",
      toolName: "create-draft-email",
      argsSummary: {
        subject_length: subject.length,
        body_length:
          typeof args.bodyContent === "string"
            ? (args.bodyContent as string).length
            : 0,
        to_count: Array.isArray(args.toRecipients)
          ? (args.toRecipients as unknown[]).length
          : 0,
        cc_count: Array.isArray(args.ccRecipients)
          ? (args.ccRecipients as unknown[]).length
          : 0,
        bcc_count: Array.isArray(args.bccRecipients)
          ? (args.bccRecipients as unknown[]).length
          : 0,
      },
    });
    try {
      // Active call (commented until Mail.ReadWrite consent lands):
      //   mg form: mg me messages create --body @draft.json
      //   HTTP form:
      //     await authedFetch("/me/messages", {
      //       method: "POST",
      //       body: JSON.stringify({
      //         subject,
      //         body: { contentType: bodyContentType, content: bodyContent },
      //         toRecipients: toRecipients.map(addr => ({ emailAddress: { address: addr } })),
      //         ...
      //       }),
      //     });
      assertMcpOperation("mail.create_draft");
      finishMcpAudit(audit, {
        result: "error",
        detail: "unreachable: stub gate should have refused",
      });
      return err("unreachable");
    } catch (e) {
      finishMcpAudit(audit, {
        result: "stub-blocked",
        detail: "mail.create_draft pending Mail.ReadWrite consent",
      });
      return permissionErr(e);
    }
  },
};

registerTools([moveMailMessage, updateMailMessage, createDraftEmail]);
