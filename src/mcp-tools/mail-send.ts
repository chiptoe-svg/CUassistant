import type { ApprovalGate } from "../approval/gate.js";
import type { SendAccount, SendArtifact } from "../approval/types.js";
import { assertMcpOperation } from "./permissions.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";
import { registerTools } from "./server.js";

let gate: ApprovalGate | null = null;
export function __setGate(g: ApprovalGate): void {
  gate = g;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v) return [v];
  return [];
}

function sendTool(
  name: string,
  account: SendAccount,
  vendor: string,
): McpToolDefinition {
  return {
    operation: "mail.send_with_approval",
    tool: {
      name, // "send-outlook-mail" | "send-gmail"
      description:
        `Request that a ${vendor} email be sent. Returns a request_id ` +
        "immediately; the email is NOT sent until the user approves it " +
        "out-of-band. Poll get-send-status for the outcome " +
        "(pending | sent | rejected+feedback | expired | failed).",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
    async handler(args) {
      try {
        assertMcpOperation("mail.send_with_approval");
      } catch (e) {
        return permissionErr(e);
      }
      if (!gate) return err("approval gate not initialized");
      const to = asStringArray(args.to);
      if (to.length === 0)
        return err("at least one recipient (to) is required");
      const artifact: SendArtifact = {
        account,
        to,
        cc: asStringArray(args.cc),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
      };
      try {
        return okJson(await gate.submit(artifact, "agent"));
      } catch (e) {
        return err(String(e));
      }
    },
  };
}

export const sendOutlookMail = sendTool(
  "send-outlook-mail",
  "ms365",
  "Outlook",
);
export const sendGmail = sendTool("send-gmail", "gmail", "Gmail");

export const getSendStatus: McpToolDefinition = {
  operation: "mail.send_with_approval",
  tool: {
    name: "get-send-status",
    description:
      "Check the status of a send request by request_id: pending | sent | " +
      "rejected (with feedback) | expired | failed.",
    inputSchema: {
      type: "object" as const,
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("mail.send_with_approval");
    } catch (e) {
      return permissionErr(e);
    }
    if (!gate) return err("approval gate not initialized");
    const view = gate.getStatus(String(args.request_id));
    if (!view) return err("unknown request_id");
    return okJson(view);
  },
};

registerTools([sendOutlookMail, sendGmail, getSendStatus]);
