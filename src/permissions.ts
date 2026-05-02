// What this tool is allowed to call.
//
// Microsoft consent scopes and host-callable actions are deliberately separate.
// The existing Azure app can be consented for a broader envelope such as
// Mail.ReadWrite, Tasks.ReadWrite, Calendars.ReadWrite, and Chat.Read. This file
// answers the narrower question: which Graph operations can this host process
// actually execute for each handler?
//
// The point is legibility, not a cryptographic sandbox. The list of every
// Microsoft Graph side-effect surface in the current codebase is one
// Object.values() away. Easy to enumerate, easy to review, code-changes only.

const ALLOWED_GRAPH_OPERATIONS: Record<string, ReadonlyArray<string>> = {
  // Triage today: list inbox, fetch bodies, enumerate To Do lists, create To Do
  // tasks, and find already-created tasks by CUassistant's dedupe marker.
  triage: [
    "mail.listInbox",
    "mail.fetchBody",
    "todo.listLists",
    "todo.findTaskByMarker",
    "todo.createTask",
  ],
};

// Handler context — set by the orchestrator before each handler runs and
// cleared after. Module-scoped so Graph-call sites don't have to thread it
// through every function signature.
let activeHandler: string | null = null;

export function setActiveHandler(name: string | null): void {
  activeHandler = name;
}

export function getActiveHandler(): string | null {
  return activeHandler;
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export function assertGraphOperation(operation: string): void {
  if (!activeHandler) {
    throw new PermissionDeniedError(
      `Graph call attempted with no active handler (operation=${operation})`,
    );
  }
  const allowed = ALLOWED_GRAPH_OPERATIONS[activeHandler];
  if (!allowed || !allowed.includes(operation)) {
    throw new PermissionDeniedError(
      `Handler "${activeHandler}" is not allowed Graph operation "${operation}". ` +
        `Allowed: [${allowed?.join(", ") ?? "none"}]. ` +
        `Edit src/permissions.ts to grant.`,
    );
  }
}

// One-line description of what this tool can do, for review-time enumeration.
export function describeAllowed(): string {
  const lines: string[] = [
    "Allowed Microsoft Graph host operations by handler:",
  ];
  for (const [handler, operations] of Object.entries(
    ALLOWED_GRAPH_OPERATIONS,
  )) {
    lines.push(`  ${handler}: ${operations.join(", ")}`);
  }
  return lines.join("\n");
}
