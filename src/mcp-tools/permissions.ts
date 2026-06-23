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

import { isBlockedMailFolder, isUnderAllowedPrefix } from "../mail-paths.js";
import { isOwnedFile } from "./gws-owned.js";
import { getPolicyAction } from "../policy.js";
import type { PolicyAction } from "../policy.js";

export type McpOperationStatus = "active" | "stub-pending-approval";

export interface McpOperationSpec {
  /**
   * The backend that fulfills this operation. "graph" = the GCassistant Azure
   * AD app via the shared MCP Graph helper (getMs365AccessToken).
   * "external-http" = a public, no-auth third-party HTTP API (e.g. Clemson's
   * Banner Browse Classes).
   */
  backend: "graph" | "host-scan" | "host-state" | "external-http" | "gws";
  /** The policy/action-policy.yaml action that gates this operation. */
  policyActionId: string;
  /**
   * "active" = wired to a real backend (exposure still depends on the mapped
   *   policy action being approval=none).
   * "stub-pending-approval" = guarded; throws McpStubPendingError. No
   *   operation is a stub today, but the status is retained for future work
   *   that lands a tool ahead of its consent.
   */
  status: McpOperationStatus;
  /** The Graph permission scope that gates activation, when applicable. */
  pendingScope?: string;
}

export const MCP_ALLOWED_OPERATIONS: Record<string, McpOperationSpec> = {
  // --- Mail reads (GCassistant Graph app — Mail.ReadWrite) ---
  "mail.list_messages": {
    backend: "graph",
    status: "active",
    policyActionId: "mail.list_inbox",
  },
  "mail.get_message": {
    backend: "graph",
    status: "active",
    policyActionId: "mail.fetch_body",
  },
  // Read-only folder/label discovery. Dispatches by account: ms365 -> Graph,
  // g.clemson -> gws (the backend field is nominal for this dual-provider op).
  "mail.list_folders": {
    backend: "graph",
    status: "active",
    policyActionId: "mail.list_folders",
  },

  // --- Calendar reads (GCassistant Graph app — Calendars.ReadWrite) ---
  "calendar.list_events": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.list_events",
  },
  "calendar.get_event": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.get_event",
  },
  "calendar.get_view": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.get_view",
  },

  // --- Task reads/writes (GCassistant Graph app — Tasks.ReadWrite) ---
  "todo.list_lists": {
    backend: "graph",
    status: "active",
    policyActionId: "todo.list_lists",
  },
  "todo.list_tasks": {
    backend: "graph",
    status: "active",
    policyActionId: "todo.list_tasks",
  },
  "todo.get_task": {
    backend: "graph",
    status: "active",
    policyActionId: "todo.get_task",
  },
  "todo.create_task": {
    backend: "graph",
    status: "active",
    policyActionId: "todo.create_task",
  },
  "todo.update_task": {
    backend: "graph",
    status: "active",
    policyActionId: "todo.update_task",
  },
  // delete_task is wired but stays policy-blocked (approval=human_required).
  "todo.delete_task": {
    backend: "graph",
    status: "active",
    policyActionId: "todo.delete_task",
  },

  // --- Mail writes (GCassistant Graph app — Mail.ReadWrite, consented) ---
  "mail.move_message": {
    backend: "graph",
    status: "active",
    policyActionId: "mail.move_message",
  },
  "mail.update_message": {
    backend: "graph",
    status: "active",
    policyActionId: "mail.update_message",
  },
  "mail.create_draft": {
    backend: "graph",
    status: "active",
    policyActionId: "mail.create_draft",
  },

  // --- Calendar writes (GCassistant Graph app — Calendars.ReadWrite) ---
  // create/update are exposed (approval=none). delete + RSVP are wired but
  // stay policy-blocked (approval=human_required) until policy is widened.
  "calendar.create_event": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.create_personal_event",
  },
  "calendar.update_event": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.update_personal_event",
  },
  "calendar.delete_event": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.delete_event",
  },
  "calendar.accept_event": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.respond_to_invite",
  },
  "calendar.decline_event": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.respond_to_invite",
  },
  "calendar.tentatively_accept_event": {
    backend: "graph",
    status: "active",
    policyActionId: "calendar.respond_to_invite",
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

  // --- Google Sheets / Docs (gws — Clemson Google Workspace account) ---
  // Reads + routine value/text writes are exposed (approval: none). Destructive
  // edges below map to human_required policy actions and are therefore wired
  // but NOT exposed.
  "sheets.read": {
    backend: "gws",
    status: "active",
    policyActionId: "sheets.read_values",
  },
  "sheets.info": {
    backend: "gws",
    status: "active",
    policyActionId: "sheets.read_metadata",
  },
  "sheets.create": {
    backend: "gws",
    status: "active",
    policyActionId: "sheets.create",
  },
  "sheets.update": {
    backend: "gws",
    status: "active",
    policyActionId: "sheets.update_values",
  },
  "sheets.append": {
    backend: "gws",
    status: "active",
    policyActionId: "sheets.append_values",
  },
  "docs.read": {
    backend: "gws",
    status: "active",
    policyActionId: "docs.read",
  },
  "docs.create": {
    backend: "gws",
    status: "active",
    policyActionId: "docs.create",
  },
  "docs.append": {
    backend: "gws",
    status: "active",
    policyActionId: "docs.append_text",
  },
  // Destructive edges — declared + gated (human_required), not exposed.
  "sheets.delete": {
    backend: "gws",
    status: "active",
    policyActionId: "sheets.delete_spreadsheet",
  },
  "sheets.share": {
    backend: "gws",
    status: "active",
    policyActionId: "sheets.share",
  },
  "docs.delete": {
    backend: "gws",
    status: "active",
    policyActionId: "docs.delete",
  },
  "docs.share": {
    backend: "gws",
    status: "active",
    policyActionId: "docs.share",
  },
  "docs.overwrite": {
    backend: "gws",
    status: "active",
    policyActionId: "docs.overwrite_body",
  },

  // --- Clemson public class schedule (Banner Browse Classes — no auth) ---
  "clemson.list_terms": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.list_terms",
  },
  "clemson.search_classes": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.search_classes",
  },
  "clemson.section_details": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.section_details",
  },
  "clemson.instructor_classes": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.instructor_classes",
  },
  "clemson.room_availability": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.room_availability",
  },
  "clemson.gc_catalog_years": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_catalog_years",
  },
  "clemson.gc_program_plan": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_program_plan",
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

function validateOwnedFile(input: Record<string, unknown>): string | null {
  const id =
    (typeof input.spreadsheetId === "string" && input.spreadsheetId) ||
    (typeof input.documentId === "string" && input.documentId) ||
    "";
  if (!id) {
    return "own_created_file_only requires a spreadsheetId or documentId";
  }
  if (!isOwnedFile(id)) {
    return (
      `own_created_file_only: file "${id}" was not created by this agent ` +
      `(reads are allowed; to permit edits, grant it with \`npm run gws:grant\`)`
    );
  }
  return null;
}

function validateSubtreeDestination(
  input: Record<string, unknown>,
): string | null {
  const dest = typeof input.destination === "string" ? input.destination : "";
  if (!dest) {
    return "destination_subtree_allow_list requires a destination path";
  }
  const prefixes = (process.env.MCP_ALLOWED_MAIL_DESTINATIONS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (prefixes.length === 0) {
    return "destination_subtree_allow_list requires MCP_ALLOWED_MAIL_DESTINATIONS";
  }
  if (isBlockedMailFolder(dest)) {
    return "destination_subtree_allow_list rejected a system/destructive folder";
  }
  if (!isUnderAllowedPrefix(dest, prefixes)) {
    return `destination "${dest}" is not under an allowed subtree`;
  }
  return null;
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
    case "own_workspace_only":
    case "local_state_only":
    case "no_delete":
    case "no_permanent_delete":
    case "public_data_only":
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
    case "destination_subtree_allow_list":
      return validateSubtreeDestination(input);
    case "own_created_file_only":
      return validateOwnedFile(input);
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

/**
 * Capability scope vocabulary: surface + read/write split. Each token maps to
 * the MCP_ALLOWED_OPERATIONS keys it grants. `mail:send` is deliberately its
 * own scope (the highest-risk op). Only EXPOSED operations are reachable; this
 * map never widens beyond the exposed set (enforced by expandScopes).
 */
export const SCOPE_OPERATIONS: Record<string, string[]> = {
  "mail:read": ["mail.list_messages", "mail.get_message", "mail.list_folders"],
  "mail:write": [
    "mail.move_message",
    "mail.update_message",
    "mail.create_draft",
  ],
  "mail:send": ["mail.send_with_approval"],
  "calendar:read": [
    "calendar.list_events",
    "calendar.get_event",
    "calendar.get_view",
  ],
  "calendar:write": ["calendar.create_event", "calendar.update_event"],
  "tasks:read": ["todo.list_lists", "todo.list_tasks", "todo.get_task"],
  "tasks:write": ["todo.create_task", "todo.update_task"],
  "sheets:read": ["sheets.read", "sheets.info"],
  "sheets:write": ["sheets.create", "sheets.update", "sheets.append"],
  "docs:read": ["docs.read"],
  "docs:write": ["docs.create", "docs.append"],
  clemson: [
    "clemson.list_terms",
    "clemson.search_classes",
    "clemson.section_details",
    "clemson.instructor_classes",
    "clemson.room_availability",
    "clemson.gc_catalog_years",
    "clemson.gc_program_plan",
  ],
  // host.trigger_scan is human_required -> not exposed -> intentionally absent.
  "host:read": ["host.get_scan_status", "host.get_pending_actions"],
};

/** Whether `token` is a recognized scope token. */
export function isValidScopeToken(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(SCOPE_OPERATIONS, token);
}

/** The set of all currently-exposed operation keys (the implicit full scope). */
export function allExposedOperations(): Set<string> {
  return new Set(
    Object.keys(MCP_ALLOWED_OPERATIONS).filter(isMcpOperationExposed),
  );
}

/**
 * Expand scope tokens to the operation keys they grant, intersected with the
 * exposed set. Undefined/empty tokens => full exposed set (default-allow).
 * Unknown tokens contribute nothing (the CLI rejects them at pair time).
 */
export function expandScopes(tokens: string[] | undefined): Set<string> {
  if (!tokens || tokens.length === 0) return allExposedOperations();
  const exposed = allExposedOperations();
  const out = new Set<string>();
  for (const token of tokens) {
    for (const op of SCOPE_OPERATIONS[token] ?? []) {
      if (exposed.has(op)) out.add(op);
    }
  }
  return out;
}
