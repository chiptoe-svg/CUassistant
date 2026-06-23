// Mail read tools — backed by the GCassistant Graph app (Mail.ReadWrite).
//
// Tool names mirror CUagent's @softeria/ms-365-mcp-server surface so a
// NanoClaw v2 agent that has previously used CUagent's MS365 provider sees
// familiar shapes here. Calls go through the shared MCP Graph helper
// (authedFetch on getMs365AccessToken), gated by assertMcpOperation.

import {
  listMailMessages as listMailMessagesGraph,
  getMailMessageBody,
  getMailAttachment,
} from "./graph-helpers.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const listMailMessages: McpToolDefinition = {
  operation: "mail.list_messages",
  tool: {
    name: "list-mail-messages",
    description:
      "List Outlook Inbox messages, newest first. Read-only. Backed by the " +
      "GCassistant Graph app (Mail.ReadWrite). Returns minimal metadata (id, " +
      "from, subject, conversationId, receivedIso, isRead). To read the " +
      "body, use get-mail-message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sinceIso: {
          type: ["string", "null"],
          description:
            "Lower bound on receivedDateTime, ISO 8601. Pass null to omit.",
        },
        untilIso: {
          type: ["string", "null"],
          description:
            "Exclusive upper bound on receivedDateTime, ISO 8601. Pass null " +
            "to omit.",
        },
      },
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("mail.list_messages");
    } catch (e) {
      return permissionErr(e);
    }
    const sinceIso = (args.sinceIso as string | null | undefined) ?? null;
    const untilIso = (args.untilIso as string | null | undefined) ?? null;
    const messages = await listMailMessagesGraph({ sinceIso, untilIso });
    if (messages === null) {
      return err("Graph mail list failed (token or provider unavailable).");
    }
    return okJson({ messages });
  },
};

const getMailMessage: McpToolDefinition = {
  operation: "mail.get_message",
  tool: {
    name: "get-mail-message",
    description:
      "Fetch the body of one Outlook message by id. Read-only. Returns " +
      "subject, body (HTML or text), hasAttachments flag, and an attachments " +
      "array with {id, name, contentType, size} for each attachment. To fetch " +
      "attachment content (base64), use get-mail-attachment with the message " +
      "id and attachment id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The Outlook message id.",
        },
      },
      required: ["id"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("mail.get_message");
    } catch (e) {
      return permissionErr(e);
    }
    const id = args.id as string | undefined;
    if (!id) return err("id is required");
    const message = await getMailMessageBody(id);
    if (message === null) {
      return err(`Graph returned no message for id "${id}".`);
    }
    return okJson(message);
  },
};

const getMailAttachmentTool: McpToolDefinition = {
  operation: "mail.get_attachment",
  tool: {
    name: "get-mail-attachment",
    description:
      "Download one Outlook email attachment by message id and attachment id. " +
      "Returns {id, name, contentType, size, contentBytes} where contentBytes " +
      "is base64-encoded. Get attachment ids from get-mail-message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messageId: {
          type: "string",
          description: "The Outlook message id.",
        },
        attachmentId: {
          type: "string",
          description: "The attachment id (from get-mail-message attachments array).",
        },
      },
      required: ["messageId", "attachmentId"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("mail.get_attachment");
    } catch (e) {
      return permissionErr(e);
    }
    const messageId = args.messageId as string | undefined;
    const attachmentId = args.attachmentId as string | undefined;
    if (!messageId) return err("messageId is required");
    if (!attachmentId) return err("attachmentId is required");
    const attachment = await getMailAttachment(messageId, attachmentId);
    if (attachment === null) {
      return err(`Graph returned no attachment "${attachmentId}" on message "${messageId}".`);
    }
    return okJson(attachment);
  },
};

registerTools([listMailMessages, getMailMessage, getMailAttachmentTool]);
