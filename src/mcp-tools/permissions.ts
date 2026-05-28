// MCP-specific operation allow-list.
//
// Mirrors the gate pattern in src/permissions.ts (handler -> allowed ops)
// but is scoped to the MCP server. The scan flow's gate uses an active-handler
// context that is module-scoped to the scan process; the MCP server runs as a
// separate stdio process, so a parallel allow-list here is the correct shape.
//
// Tools in src/mcp-tools/ assert against this list before any backend call.
// An operation that has no entry here cannot be invoked. Adding a tool that
// reaches Graph or any other side-effect surface requires both:
//   1. an entry in MCP_ALLOWED_OPERATIONS for the right backend tier, and
//   2. a policyActionId mapped to policy/action-policy.yaml with
//      approval=none, and
//   3. the corresponding tool file in src/mcp-tools/ that calls
//      assertMcpOperation(...) before the backend call.

import { getPolicyAction } from "../policy.js";

export type McpOperationStatus = "active" | "stub-pending-approval";

export interface McpOperationSpec {
  /** The backend that fulfills this operation. */
  backend: "codex-outlook" | "graph-cli" | "host-scan" | "host-state";
  /** The policy/action-policy.yaml action that gates this operation. */
  policyActionId: string;
  /**
   * "active" = wired to a real backend.
   * "stub-pending-approval" = guarded; throws PermissionDeniedError until
   *   the named permission lands in the Graph CLI consent.
   */
  status: McpOperationStatus;
  /** The Graph permission scope that gates activation, when applicable. */
  pendingScope?: string;
}

export const MCP_ALLOWED_OPERATIONS: Record<string, McpOperationSpec> = {
  // --- Mail reads (Codex CLI Outlook connector — already approved) ---
  "mail.list_messages": {
    backend: "codex-outlook",
    status: "active",
    policyActionId: "mail.list_inbox",
  },
  "mail.get_message": {
    backend: "codex-outlook",
    status: "active",
    policyActionId: "mail.fetch_body",
  },

  // --- Calendar reads (Codex CLI Outlook connector — already approved) ---
  "calendar.list_events": {
    backend: "codex-outlook",
    status: "active",
    policyActionId: "calendar.list_events",
  },
  "calendar.get_event": {
    backend: "codex-outlook",
    status: "active",
    policyActionId: "calendar.get_event",
  },
  "calendar.get_view": {
    backend: "codex-outlook",
    status: "active",
    policyActionId: "calendar.get_view",
  },

  // --- Task reads/writes (Graph CLI — already approved, already working) ---
  "todo.list_lists": {
    backend: "graph-cli",
    status: "active",
    policyActionId: "todo.list_lists",
  },
  "todo.list_tasks": {
    backend: "graph-cli",
    status: "active",
    policyActionId: "todo.list_tasks",
  },
  "todo.get_task": {
    backend: "graph-cli",
    status: "active",
    policyActionId: "todo.get_task",
  },
  "todo.create_task": {
    backend: "graph-cli",
    status: "active",
    policyActionId: "todo.create_task",
  },
  "todo.update_task": {
    backend: "graph-cli",
    status: "active",
    policyActionId: "todo.update_task",
  },
  "todo.delete_task": {
    backend: "graph-cli",
    status: "active",
    policyActionId: "todo.delete_task",
  },

  // --- Mail writes (Graph CLI — STUB until Mail.ReadWrite consent lands) ---
  "mail.move_message": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "mail.move_message",
    pendingScope: "Mail.ReadWrite",
  },
  "mail.update_message": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "mail.update_message",
    pendingScope: "Mail.ReadWrite",
  },
  "mail.create_draft": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "mail.create_draft",
    pendingScope: "Mail.ReadWrite",
  },

  // --- Calendar writes (Graph CLI — STUB until Calendars.ReadWrite lands) ---
  "calendar.create_event": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "calendar.create_personal_event",
    pendingScope: "Calendars.ReadWrite",
  },
  "calendar.update_event": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "calendar.update_personal_event",
    pendingScope: "Calendars.ReadWrite",
  },
  "calendar.delete_event": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "calendar.delete_event",
    pendingScope: "Calendars.ReadWrite",
  },
  "calendar.accept_event": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "calendar.respond_to_invite",
    pendingScope: "Calendars.ReadWrite",
  },
  "calendar.decline_event": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "calendar.respond_to_invite",
    pendingScope: "Calendars.ReadWrite",
  },
  "calendar.tentatively_accept_event": {
    backend: "graph-cli",
    status: "stub-pending-approval",
    policyActionId: "calendar.respond_to_invite",
    pendingScope: "Calendars.ReadWrite",
  },

  // --- Host orchestration (CUassistant-only, no Graph call) ---
  "host.trigger_scan": {
    backend: "host-scan",
    status: "active",
    policyActionId: "host.trigger_scan",
  },
  "host.get_scan_status": {
    backend: "host-state",
    status: "active",
    policyActionId: "host.get_scan_status",
  },
  "host.get_pending_actions": {
    backend: "host-state",
    status: "active",
    policyActionId: "host.get_pending_actions",
  },
};

export class McpPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpPermissionDeniedError";
  }
}

export class McpStubPendingError extends Error {
  readonly operation: string;
  readonly pendingScope: string;
  constructor(operation: string, pendingScope: string) {
    super(
      `Operation "${operation}" is a stub pending IT approval of ` +
        `Graph permission "${pendingScope}". The operation is wired but the ` +
        `consent has not been granted; the call is refused at the policy ` +
        `boundary. To activate, grant the permission to the Graph CLI ` +
        `client and remove the stub guard in the corresponding tool file.`,
    );
    this.name = "McpStubPendingError";
    this.operation = operation;
    this.pendingScope = pendingScope;
  }
}

/**
 * Assert that an MCP operation is in the allow-list. Stubs throw a structured
 * error identifying the missing permission.
 *
 * Every tool calls this before any backend exec/fetch.
 */
export function assertMcpOperation(operation: string): McpOperationSpec {
  const spec = MCP_ALLOWED_OPERATIONS[operation];
  if (!spec) {
    throw new McpPermissionDeniedError(
      `MCP operation "${operation}" is not in the allow-list. ` +
        `Edit src/mcp-tools/permissions.ts to add it.`,
    );
  }
  const policyAction = getPolicyAction(spec.policyActionId);
  if (!policyAction) {
    throw new McpPermissionDeniedError(
      `MCP operation "${operation}" maps to missing policy action ` +
        `"${spec.policyActionId}". Add it to policy/action-policy.yaml.`,
    );
  }
  if (policyAction.approval !== "none") {
    throw new McpPermissionDeniedError(
      `MCP operation "${operation}" is blocked by policy action ` +
        `"${spec.policyActionId}" (approval=${policyAction.approval}).`,
    );
  }
  if (spec.status === "stub-pending-approval") {
    throw new McpStubPendingError(operation, spec.pendingScope ?? "(unknown)");
  }
  return spec;
}

export function isMcpOperationExposed(operation: string): boolean {
  const spec = MCP_ALLOWED_OPERATIONS[operation];
  if (!spec || spec.status !== "active") return false;
  const policyAction = getPolicyAction(spec.policyActionId);
  return policyAction?.approval === "none";
}

/** Enumerate the allow-list for the IT-reviewable manifest. */
export function describeMcpOperations(): Array<{
  operation: string;
  backend: McpOperationSpec["backend"];
  status: McpOperationStatus;
  policyActionId: string;
  exposed: boolean;
  pendingScope: string | null;
}> {
  return Object.entries(MCP_ALLOWED_OPERATIONS).map(([operation, spec]) => ({
    operation,
    backend: spec.backend,
    status: spec.status,
    policyActionId: spec.policyActionId,
    exposed: isMcpOperationExposed(operation),
    pendingScope: spec.pendingScope ?? null,
  }));
}
