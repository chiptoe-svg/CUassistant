// Audit sink for the approval gate. Maps each PendingSend transition to a row
// in state/decisions.jsonl via appendDecision, the same trail the scan and the
// other MCP write tools use. Recipients/subject/content_hash are logged (audit
// of an irreversible external send needs the destination); the body is NOT.
import { appendDecision } from "../state.js";
import type { AuditSink, PendingSend, SecurityEvent } from "./types.js";

export function makeGateAuditSink(): AuditSink {
  return {
    recordSecurity(event: SecurityEvent): void {
      // An approval/reject tap from someone other than the authorized approver.
      // Logged so probes against the bot leave a trail (the gate itself ignores
      // the tap and never sends).
      appendDecision({
        pass: "mcp-tool",
        decision: event.kind,
        mcp_tool: `gate-${event.action}`,
        mcp_operation: "mail.send_with_approval",
        mcp_correlation_id: event.request_id,
        mcp_args_summary: { unauthorized_user_id: event.user_id },
      });
    },
    record(req: PendingSend): void {
      const argsSummary = {
        account: req.artifact.account,
        to: req.artifact.to,
        cc: req.artifact.cc ?? [],
        subject: req.artifact.subject,
        content_hash: req.content_hash,
        proposer: req.proposer,
      };
      // Reflect the actual send tool the agent invoked (the gate is account-
      // aware); the legacy single `request_send_mail` tool was split per vendor.
      const mcpTool =
        req.artifact.account === "ms365" ? "send-outlook-mail" : "send-gmail";
      if (req.status === "pending") {
        appendDecision({
          pass: "mcp-tool-intent",
          decision: "send-requested",
          mcp_tool: mcpTool,
          mcp_operation: "mail.send_with_approval",
          mcp_correlation_id: req.request_id,
          mcp_args_summary: argsSummary,
        });
        return;
      }
      appendDecision({
        pass: "mcp-tool",
        decision: `send-${req.status}`,
        mcp_tool: mcpTool,
        mcp_operation: "mail.send_with_approval",
        mcp_correlation_id: req.request_id,
        mcp_args_summary: argsSummary,
        mcp_object_id: req.sent_message_id ?? null,
        mcp_detail: req.feedback ?? req.error ?? null,
      });
    },
  };
}
