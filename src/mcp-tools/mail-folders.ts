// list-mail-folders — read-only destination discovery across both providers.
//   ms365     -> Outlook folders (Graph)
//   g.clemson -> Gmail user labels (gws)
// Each entry is {path, id, allowed}; allowed=true means the path is a valid
// move destination (under MCP_ALLOWED_MAIL_DESTINATIONS and not a system folder).

import { isBlockedMailFolder, isUnderAllowedPrefix } from "../mail-paths.js";
import { listGmailLabels } from "./gmail-folders.js";
import { listMs365MailFolders } from "./graph-helpers.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

function allowedPrefixes(): string[] {
  return (process.env.MCP_ALLOWED_MAIL_DESTINATIONS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const listMailFoldersTool: McpToolDefinition = {
  operation: "mail.list_folders",
  tool: {
    name: "list-mail-folders",
    description:
      "List mail destinations for an account so you can choose a move target. " +
      "account is 'ms365' (Outlook folders) or 'g.clemson' (Gmail labels). " +
      "Each entry is {path, id, allowed}; only allowed=true paths are valid " +
      "move destinations (under the configured subtree, non-system).",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", enum: ["ms365", "g.clemson"] },
      },
      required: ["account"],
    },
  },
  async handler(args) {
    const account = args.account;
    if (account !== "ms365" && account !== "g.clemson") {
      return err("account must be 'ms365' or 'g.clemson'");
    }
    try {
      assertMcpOperation("mail.list_folders");
    } catch (e) {
      return permissionErr(e);
    }
    const raw =
      account === "ms365" ? await listMs365MailFolders() : listGmailLabels();
    if (raw === null) {
      return err(
        account === "ms365"
          ? "Graph failed to list mail folders."
          : "gws failed to list Gmail labels — gws is unset or its Google auth " +
              "has expired (re-authenticate gws).",
      );
    }
    const prefixes = allowedPrefixes();
    const folders = raw.map((f) => ({
      path: f.path,
      id: f.id,
      allowed:
        !isBlockedMailFolder(f.path) && isUnderAllowedPrefix(f.path, prefixes),
    }));
    return okJson({ account, folders });
  },
};

registerTools([listMailFoldersTool]);
