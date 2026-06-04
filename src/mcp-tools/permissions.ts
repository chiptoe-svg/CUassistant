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
import type { PolicyAction } from "../policy.js";

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
  "mail.send_with_approval": {
    backend: "host-state",
    status: "active",
    policyActionId: "mail.send_with_approval",
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

export interface McpOperationContext {
  input?: Record<string, unknown>;
}

function hasKey(input: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => input[key] !== undefined && input[key] !== null);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function rejectSharedCalendarInput(
  input: Record<string, unknown>,
): string | null {
  return hasKey(input, [
    "calendarId",
    "calendar_id",
    "mailbox",
    "mailboxId",
    "userId",
    "userPrincipalName",
  ])
    ? "primary calendar actions must not include delegated/shared calendar selectors"
    : null;
}

function validateDestinationAllowList(destination: string): string | null {
  const allowed = (process.env.MCP_ALLOWED_MAIL_DESTINATIONS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!destination)
    return "destination_folder_allow_list requires destinationId";
  if (allowed.length === 0) {
    return "destination_folder_allow_list requires MCP_ALLOWED_MAIL_DESTINATIONS";
  }
  return allowed.includes(destination)
    ? null
    : "destination_folder_allow_list rejected destinationId";
}

function validateConstraint(
  constraint: string,
  input: Record<string, unknown>,
): string | null {
  const destination = normalizeToken(input.destinationId);
  switch (constraint) {
    case "own_mailbox_only":
    case "own_task_list_only":
    case "local_state_only":
    case "no_delete":
    case "no_permanent_delete":
      return null;
    case "own_primary_calendar_only":
    case "no_shared_or_delegated_calendar":
      return rejectSharedCalendarInput(input);
    case "metadata_only":
    case "no_body_rewrite":
      return hasKey(input, ["body", "bodyContent", "bodyContentType"])
        ? `${constraint} forbids message body changes`
        : null;
    case "no_send":
      return input.send === true || input.sendNow === true
        ? "no_send forbids sending or send-and-save behavior"
        : null;
    case "draft_only":
      return input.send === true || input.sendNow === true
        ? "draft_only permits draft creation only"
        : null;
    case "destination_folder_allow_list":
      return validateDestinationAllowList(destination);
    case "no_delete_folder":
      return destination.includes("deleted") || destination.includes("trash")
        ? "no_delete_folder rejected destinationId"
        : null;
    case "no_junk_folder":
      return destination.includes("junk") || destination.includes("spam")
        ? "no_junk_folder rejected destinationId"
        : null;
    case "no_recoverable_items":
      return destination.includes("recoverable")
        ? "no_recoverable_items rejected destinationId"
        : null;
    case "no_attendees":
    case "no_invites":
      return asStringArray(input.attendees).length > 0
        ? `${constraint} forbids attendee invitations`
        : null;
    case "disabled_by_default":
      return "disabled_by_default blocks this operation";
    case "dry_run_only_unless_explicitly_enabled":
      return input.dryRun === true
        ? null
        : "dry_run_only_unless_explicitly_enabled requires dryRun=true";
    default:
      return `no validator for policy constraint "${constraint}"`;
  }
}

function assertPolicyConstraints(
  operation: string,
  action: PolicyAction,
  context: McpOperationContext,
): void {
  const input = context.input ?? {};
  for (const constraint of action.constraints ?? []) {
    const failure = validateConstraint(constraint, input);
    if (failure) {
      throw new McpPermissionDeniedError(
        `MCP operation "${operation}" violates policy constraint ` +
          `"${constraint}": ${failure}.`,
      );
    }
  }
}

/**
 * Assert that an MCP operation is in the allow-list. Stubs throw a structured
 * error identifying the missing permission.
 *
 * Every tool calls this before any backend exec/fetch.
 */
export function assertMcpOperation(
  operation: string,
  context: McpOperationContext = {},
): McpOperationSpec {
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
  assertPolicyConstraints(operation, policyAction, context);
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
