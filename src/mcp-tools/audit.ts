// Audit helpers for MCP write operations.
//
// Mirrors the task-intent / terminal row pattern in src/scan-effects.ts:
// every write tool appends an "intent" row before its backend call and a
// "terminal" row after — even on failure or stub-blocked refusal.
//
// Rows go to state/decisions.jsonl through the same appendDecision() the scan
// uses, so IT review tooling sees a single source of truth.

import { AsyncLocalStorage } from "node:async_hooks";

import { appendDecision } from "../state.js";

/** Request-scoped store for the authenticated consumer id (set in buildServer). */
export const auditContext = new AsyncLocalStorage<{ consumerId: string }>();

/** Attach the current ALS consumer id (or null) to an audit row. */
export function withConsumer(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...row,
    mcp_consumer_id: auditContext.getStore()?.consumerId ?? null,
  };
}

export interface McpAuditContext {
  /** The MCP operation key as listed in MCP_ALLOWED_OPERATIONS. */
  operation: string;
  /** The MCP tool name as exposed to clients. */
  toolName: string;
  /**
   * A redacted argument summary — keys/ids/folders only, never bodies or
   * other sensitive payload. The host scrubs anything not on this list.
   */
  argsSummary: Record<string, unknown>;
  /** UUID-like correlator linking intent and terminal rows for one call. */
  correlationId: string;
}

function newCorrelationId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function startMcpAudit(input: {
  operation: string;
  toolName: string;
  argsSummary: Record<string, unknown>;
}): McpAuditContext {
  const ctx: McpAuditContext = { ...input, correlationId: newCorrelationId() };
  appendDecision(
    withConsumer({
      pass: "mcp-tool-intent",
      decision: "mcp-tool-intent",
      mcp_tool: ctx.toolName,
      mcp_operation: ctx.operation,
      mcp_correlation_id: ctx.correlationId,
      mcp_args_summary: ctx.argsSummary,
    }),
  );
  return ctx;
}

export function finishMcpAudit(
  ctx: McpAuditContext,
  outcome: {
    result: "success" | "error" | "stub-blocked";
    detail?: string | null;
    /** Optional Graph object id created or affected. */
    object_id?: string | null;
  },
): void {
  appendDecision(
    withConsumer({
      pass: "mcp-tool",
      decision: outcome.result,
      mcp_tool: ctx.toolName,
      mcp_operation: ctx.operation,
      mcp_correlation_id: ctx.correlationId,
      mcp_args_summary: ctx.argsSummary,
      mcp_object_id: outcome.object_id ?? null,
      mcp_detail: outcome.detail ?? null,
    }),
  );
}
