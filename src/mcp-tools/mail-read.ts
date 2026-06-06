// Mail read tools — backed by the GCassistant Graph app (Mail.ReadWrite).
//
// Tool names mirror CUagent's @softeria/ms-365-mcp-server surface so a
// NanoClaw v2 agent that has previously used CUagent's MS365 provider sees
// familiar shapes here. Calls go through the shared MCP Graph helper
// (authedFetch on getMs365AccessToken), gated by assertMcpOperation.

import {
  listMailMessages as listMailMessagesGraph,
  getMailMessageBody,
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
      "Fetch the body of one Outlook message by id. Read-only. Backed by " +
      "the GCassistant Graph app. Returns the message subject and body " +
      "content (HTML or text as stored).",
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

registerTools([listMailMessages, getMailMessage]);
