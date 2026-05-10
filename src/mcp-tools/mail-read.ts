// Mail read tools — backed by the Codex CLI Outlook connector.
//
// Tool names mirror CUagent's @softeria/ms-365-mcp-server surface so a
// NanoClaw v2 agent that has previously used CUagent's MS365 provider sees
// familiar shapes here. The backend is different (Codex Outlook connector
// instead of MSAL+Graph) but the input shape is preserved.

import { listOutlookWithCodex, fetchOutlookBodyWithCodex } from "../codex-outlook.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const listMailMessages: McpToolDefinition = {
  tool: {
    name: "list-mail-messages",
    description:
      "List Outlook Inbox messages, newest first. Read-only. Backed by " +
      "Codex CLI's Outlook connector — does not touch the local Graph API " +
      "or MSAL cache. Returns minimal metadata (id, from, subject, " +
      "conversationId, receivedIso). To read the body, use get-mail-message.",
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
    const messages = await listOutlookWithCodex(sinceIso, untilIso);
    if (messages === null) {
      return err("Codex Outlook connector returned no result (provider may be unavailable).");
    }
    return okJson({ messages });
  },
};

const getMailMessage: McpToolDefinition = {
  tool: {
    name: "get-mail-message",
    description:
      "Fetch the body of one Outlook message by id. Read-only. Backed by " +
      "Codex CLI's Outlook connector. Returns the normalized readable body " +
      "text used for classification, with quoted replies and footer " +
      "boilerplate stripped.",
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
    const body = await fetchOutlookBodyWithCodex(id);
    return okJson({ id, body });
  },
};

registerTools([listMailMessages, getMailMessage]);
