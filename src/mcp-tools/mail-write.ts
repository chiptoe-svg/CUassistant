// Mail write tools — backed by the GCassistant Graph app (Mail.ReadWrite).
//
// These were stubs while the consent was outstanding; they are now wired to
// the shared MCP Graph helper (authedFetch on getMs365AccessToken). The policy
// boundary still applies on every call:
//   - move:   own_mailbox_only + destination_subtree_allow_list — destination
//             path must be under MCP_ALLOWED_MAIL_DESTINATIONS (segment-aware)
//             and not a system/destructive folder. account ms365 -> Graph
//             folder; g.clemson -> Gmail label (via gws). Paths resolve to the
//             provider's real folder/label, so a bogus path is refused.
//   - update: metadata_only / no_body_rewrite / no_send / no_delete — body
//             fields are rejected; this is mark-read/flag/importance/category
//             only.
//   - draft:  draft_only / no_send — creates a Drafts item; there is no send
//             tool here (send goes through the approval gate, separately).
// assertMcpOperation(operation, { input: args }) enforces those constraints
// before any Graph call runs.

import { startMcpAudit, finishMcpAudit } from "./audit.js";
import { resolveGmailLabelByPath, moveGmailMessage } from "./gmail-folders.js";
import {
  createDraftEmail,
  moveMailMessage,
  resolveMs365FolderByPath,
  updateMailMessage,
} from "./graph-helpers.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const moveMailMessageTool: McpToolDefinition = {
  operation: "mail.move_message",
  tool: {
    name: "move-mail-message",
    description:
      "Move a message into a folder/label under an allowed subtree (e.g. " +
      "sorted/Newsletters). account is 'ms365' (an Outlook folder) or " +
      "'g.clemson' (a Gmail label — the message is labeled and archived from " +
      "the inbox). The destination must be under MCP_ALLOWED_MAIL_DESTINATIONS; " +
      "system folders (trash/junk/deleted/recoverable) are rejected. Use " +
      "list-mail-folders to discover valid destinations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", enum: ["ms365", "g.clemson"] },
        id: { type: "string", description: "Message id." },
        destination: {
          type: "string",
          description: "Folder/label path, e.g. sorted/Newsletters.",
        },
      },
      required: ["account", "id", "destination"],
    },
  },
  async handler(args) {
    const account = args.account as string | undefined;
    const id = args.id as string | undefined;
    const destination = args.destination as string | undefined;
    if (account !== "ms365" && account !== "g.clemson") {
      return err("account must be 'ms365' or 'g.clemson'");
    }
    if (!id || !destination) return err("id and destination are required");
    const audit = startMcpAudit({
      operation: "mail.move_message",
      toolName: "move-mail-message",
      argsSummary: { account, id_present: true, destination },
    });
    try {
      assertMcpOperation("mail.move_message", { input: { destination } });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return permissionErr(e);
    }
    if (account === "ms365") {
      const folderId = await resolveMs365FolderByPath(destination);
      if (!folderId) {
        finishMcpAudit(audit, {
          result: "error",
          detail: "destination_not_found",
        });
        return err(`No MS365 folder matches "${destination}".`);
      }
      const message = await moveMailMessage(id, folderId);
      if (!message) {
        finishMcpAudit(audit, { result: "error", detail: "graph_move_failed" });
        return err("Graph failed to move the message.");
      }
      finishMcpAudit(audit, { result: "success", object_id: message.id });
      return okJson({ message });
    }
    // g.clemson (Gmail): resolve the label and apply it (archive from inbox).
    const labelId = resolveGmailLabelByPath(destination);
    if (!labelId) {
      finishMcpAudit(audit, {
        result: "error",
        detail: "destination_not_found",
      });
      return err(`No Gmail label matches "${destination}".`);
    }
    if (!moveGmailMessage(id, labelId)) {
      finishMcpAudit(audit, { result: "error", detail: "gws_move_failed" });
      return err("gws failed to move (label) the message.");
    }
    finishMcpAudit(audit, { result: "success", object_id: id });
    return okJson({ moved: true, account, destination });
  },
};

const updateMailMessageTool: McpToolDefinition = {
  operation: "mail.update_message",
  tool: {
    name: "update-mail-message",
    description:
      "Patch an Outlook message's metadata (mark read, set flag, adjust " +
      "importance, add categories). Metadata only — body changes and " +
      "send/delete are rejected by policy.",
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
      assertMcpOperation("mail.update_message", { input: args });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return permissionErr(e);
    }
    const message = await updateMailMessage(id, {
      isRead: args.isRead as boolean | undefined,
      importance: args.importance as "low" | "normal" | "high" | undefined,
      flag: args.flag as Record<string, unknown> | undefined,
      categories: args.categories as string[] | undefined,
    });
    if (!message) {
      finishMcpAudit(audit, { result: "error", detail: "graph_update_failed" });
      return err("Graph failed to update the message.");
    }
    finishMcpAudit(audit, { result: "success", object_id: message.id });
    return okJson({ message });
  },
};

const createDraftEmailTool: McpToolDefinition = {
  operation: "mail.create_draft",
  tool: {
    name: "create-draft-email",
    description:
      "Create a new draft email in the user's Drafts folder. Draft only — " +
      "this does not send. Sending goes through the separate approval gate.",
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
      assertMcpOperation("mail.create_draft", { input: args });
    } catch (e) {
      finishMcpAudit(audit, { result: "error", detail: String(e) });
      return permissionErr(e);
    }
    const draft = await createDraftEmail({
      subject,
      bodyContent: args.bodyContent as string | undefined,
      bodyContentType: args.bodyContentType as "text" | "html" | undefined,
      toRecipients: args.toRecipients as string[] | undefined,
      ccRecipients: args.ccRecipients as string[] | undefined,
      bccRecipients: args.bccRecipients as string[] | undefined,
    });
    if (!draft) {
      finishMcpAudit(audit, { result: "error", detail: "graph_draft_failed" });
      return err("Graph failed to create the draft.");
    }
    finishMcpAudit(audit, { result: "success", object_id: draft.id });
    return okJson({ draft });
  },
};

registerTools([
  moveMailMessageTool,
  updateMailMessageTool,
  createDraftEmailTool,
]);
