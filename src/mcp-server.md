# CUassistant MCP server — IT review manifest

This is the human-readable companion to `src/mcp-server.ts`. It enumerates
the MCP operation surface, what backend each operation uses, what permission it
requires, and whether the tool is exposed to the agent. It is the document that
accompanies the Graph CLI permission request to IT.

## Architecture summary

- **Transport.** stdio (`@modelcontextprotocol/sdk` `StdioServerTransport`).
  The server is a local host MCP server, not a containerized service. Stdio is
  the only listener — no HTTP, no socket.
- **Credentials.** Host-only. The Graph CLI refresh token in
  `${CUASSISTANT_REPO}/.env` is read by the host process and never crosses
  any boundary. If a containerized agent runtime launches this MCP server, it
  connects through stdio and requests operations through tools — it never
  receives credentials directly.
- **Allow-list.** `src/mcp-tools/permissions.ts` is the operation registry for
  this server, and `policy/action-policy.yaml` is the policy registry. A tool
  is exposed only when its operation is active and maps to an `approval: none`
  policy action. Tool registration fails closed if the tool has no operation
  mapping. Every tool still calls `assertMcpOperation()` before any backend
  call, and write tools pass their normalized inputs through policy constraint
  validators.
- **Authorized use.** `policy/action-policy.yaml` is the authorized-use list.
  OAuth scopes describe what the delegated token may technically permit; the
  authorized-use list describes what CUassistant is allowed to expose or
  execute.
- **Audit.** Every write tool wraps its backend call in an intent + terminal
  pair written to `state/decisions.jsonl` via the same `appendDecision()` the
  scan flow uses. Reviewers see one source of truth for "what changed and
  why."
- **Stubs.** Tools whose Graph permission is pending IT approval are present
  in code but not registered with the MCP server. If a stub is accidentally
  invoked directly, it returns a structured `stub_pending_approval` error. The
  stub form preserves the tool's input shape so activation is a localized edit
  rather than a rewrite.

## Operation table

| Tool                                | Operation key                       | Policy action                    | Backend                | Permission required         | Exposed            |
| ----------------------------------- | ----------------------------------- | -------------------------------- | ---------------------- | --------------------------- | ------------------ |
| `list-mail-messages`                | `mail.list_messages`                | `mail.list_inbox`                | Codex CLI Outlook conn | Outlook connector consent   | yes                |
| `get-mail-message`                  | `mail.get_message`                  | `mail.fetch_body`                | Codex CLI Outlook conn | Outlook connector consent   | yes                |
| `list-calendar-events`              | `calendar.list_events`              | `calendar.list_events`           | Codex CLI Outlook conn | Outlook connector consent   | yes                |
| `get-calendar-event`                | `calendar.get_event`                | `calendar.get_event`             | Codex CLI Outlook conn | Outlook connector consent   | yes                |
| `get-calendar-view`                 | `calendar.get_view`                 | `calendar.get_view`              | Codex CLI Outlook conn | Outlook connector consent   | yes                |
| `list-todo-task-lists`              | `todo.list_lists`                   | `todo.list_lists`                | Graph CLI              | Tasks.ReadWrite             | yes                |
| `list-todo-tasks`                   | `todo.list_tasks`                   | `todo.list_tasks`                | Graph CLI              | Tasks.ReadWrite             | yes                |
| `get-todo-task`                     | `todo.get_task`                     | `todo.get_task`                  | Graph CLI              | Tasks.ReadWrite             | yes                |
| `create-todo-task`                  | `todo.create_task`                  | `todo.create_task`               | Graph CLI              | Tasks.ReadWrite             | yes                |
| `update-todo-task`                  | `todo.update_task`                  | `todo.update_task`               | Graph CLI              | Tasks.ReadWrite             | yes                |
| `delete-todo-task`                  | `todo.delete_task`                  | `todo.delete_task`               | Graph CLI              | Tasks.ReadWrite             | no: policy-blocked |
| `move-mail-message`                 | `mail.move_message`                 | `mail.move_message`              | Graph CLI (stub)       | Mail.ReadWrite              | no: stub           |
| `update-mail-message`               | `mail.update_message`               | `mail.update_message`            | Graph CLI (stub)       | Mail.ReadWrite              | no: stub           |
| `create-draft-email`                | `mail.create_draft`                 | `mail.create_draft`              | Graph CLI (stub)       | Mail.ReadWrite              | no: stub           |
| `create-calendar-event`             | `calendar.create_event`             | `calendar.create_personal_event` | Graph CLI (stub)       | Calendars.ReadWrite         | no: stub           |
| `update-calendar-event`             | `calendar.update_event`             | `calendar.update_personal_event` | Graph CLI (stub)       | Calendars.ReadWrite         | no: stub           |
| `delete-calendar-event`             | `calendar.delete_event`             | `calendar.delete_event`          | Graph CLI (stub)       | Calendars.ReadWrite         | no: policy-blocked |
| `accept-calendar-event`             | `calendar.accept_event`             | `calendar.respond_to_invite`     | Graph CLI (stub)       | Calendars.ReadWrite         | no: policy-blocked |
| `decline-calendar-event`            | `calendar.decline_event`            | `calendar.respond_to_invite`     | Graph CLI (stub)       | Calendars.ReadWrite         | no: policy-blocked |
| `tentatively-accept-calendar-event` | `calendar.tentatively_accept_event` | `calendar.respond_to_invite`     | Graph CLI (stub)       | Calendars.ReadWrite         | no: policy-blocked |
| `trigger_scan`                      | `host.trigger_scan`                 | `host.trigger_scan`              | host (runs scan.ts)    | scan flow's existing scopes | no: policy-blocked |
| `get_scan_status`                   | `host.get_scan_status`              | `host.get_scan_status`           | host (state file read) | none                        | yes                |
| `get_pending_actions`               | `host.get_pending_actions`          | `host.get_pending_actions`       | host (state file read) | none                        | yes                |
| `request_send_mail`                 | `mail.send_with_approval`           | `mail.send_with_approval`        | host gate + gws/Graph  | gmail.send / Mail.Send      | yes: runtime human approval |
| `get_send_status`                   | `mail.send_with_approval`           | `mail.send_with_approval`        | host gate              | —                           | yes |

## Tool details

### Mail reads — Codex CLI Outlook connector

Already approved at Clemson via the Outlook Email connector. No additional
Graph permission requested for these calls.

These reads are Codex-mediated: the host MCP server spawns a local Codex CLI
subprocess with an isolated temporary working directory, ignored user
config/rules, schema-constrained output, and Codex CLI sandbox settings. The
subprocess uses the Outlook connector and returns structured JSON to the host
MCP server. It is not Docker/container isolation, and it is not a direct local
Microsoft Graph read.

- `list-mail-messages` — list Outlook Inbox messages, newest first. Optional
  `sinceIso` and `untilIso` filters. Returns minimal metadata only; bodies
  are fetched separately via `get-mail-message`.
- `get-mail-message` — fetch one message body. Body is normalized (quoted
  replies and footer boilerplate stripped) using CUassistant's existing
  normalization path.

### Calendar reads — Codex CLI Outlook connector

Same connector consent as mail reads. New host-side wrapper added at
`src/mcp-tools/codex-calendar.ts` that mirrors the existing
`src/codex-outlook.ts` shape (does not modify existing files).

- `list-calendar-events` — list events ordered by start time.
- `get-calendar-event` — fetch one event by id.
- `get-calendar-view` — events in a window with recurrences expanded into
  occurrences (Graph `calendarView` semantics).

### Task reads/writes — Graph CLI client

The Graph CLI first-party client is consented for `Tasks.ReadWrite` at
Clemson today. The refresh token lives in `.env` as `GRAPH_CLI_REFRESH_TOKEN`
and is already exercised by the scan flow's task creation path.

- `list-todo-task-lists` — discover task lists. Used to find the default
  `Tasks` list.
- `list-todo-tasks`, `get-todo-task` — read tasks.
- `create-todo-task` — create a task. Optional `auditMarker` builds the body
  via CUassistant's existing `formatTaskBody()` so MCP-created tasks share
  the same dedupe convention as scan-created tasks.
- `update-todo-task` — patch title, status, importance, due date, body.
- `delete-todo-task` — present in code but not exposed by default because
  `todo.delete_task` is policy-blocked.

### Mail writes — STUB pending Mail.ReadWrite consent on Graph CLI

These tools are wired but disabled at the policy boundary. Each returns a
`stub_pending_approval` JSON error today.

- `move-mail-message` — move a message into a target folder (e.g., Archive).
  HTTP form: `POST /me/messages/{id}/move`.
- `update-mail-message` — patch a message (mark read, flag, importance,
  categories). HTTP form: `PATCH /me/messages/{id}`.
- `create-draft-email` — create a draft in the Drafts folder. HTTP form:
  `POST /me/messages`. **No send tool exists** — the drafts surface ends here
  by design.

### Calendar writes — STUB pending Calendars.ReadWrite consent on Graph CLI

- `create-calendar-event`, `update-calendar-event`, `delete-calendar-event`.
- RSVP: `accept-calendar-event`, `decline-calendar-event`,
  `tentatively-accept-calendar-event`.

### Host orchestration

CUassistant-specific tools (not in CUagent's MCP surface) for NanoClaw
agents to drive the scan loop on demand.

- `trigger_scan` — invoke `runScan()` directly in the host process.
  Acquires the scan lock and refuses if another run is in progress. Honors
  the optional `dry_run` flag for a no-side-effects preview. (If scan logic
  ever moves into a NanoClaw v2 container, `trigger_scan` should instead
  enqueue a request to a SQLite queue per NanoClaw v2's
  `inbound.db` / `outbound.db` IPC model.)
- `get_scan_status` — read the most recent rows from
  `state/decisions.jsonl`.
- `get_pending_actions` — return decisions that asked for a task but didn't
  produce one (items awaiting follow-up).

## Activation procedure for the stubs

When IT grants `Mail.ReadWrite` (or `Calendars.ReadWrite`) on the Graph CLI
client, activation is a localized edit:

1. Confirm the new scope is in the Graph CLI's consented set in Entra/Azure.
2. Update the `scope` set in the corresponding token-refresh helper
   (`src/graph-cli-tasks.ts` for the existing flow; a parallel mail/calendar
   helper alongside it for the new scopes).
3. Confirm the action's policy constraints are enforced by validators in
   `src/mcp-tools/permissions.ts`. Activation should not rely only on
   changing `approval` or `status`.
4. Flip the `status` from `"stub-pending-approval"` to `"active"` in
   `src/mcp-tools/permissions.ts` for each operation key in the activated
   group.
5. Replace the stub body in the matching tool file
   (`src/mcp-tools/mail-write.ts` or `src/mcp-tools/calendar-write.ts`) with
   the active backend call. Each handler already has the active call sketched
   in a comment; the activation amounts to uncommenting it and removing the
   `assertMcpOperation` branch that throws today.
6. Re-run `npm test` and `npm run typecheck`. The IT manifest table above
   should be updated to mark the activated tools as `active`.

## Dependency note

`npm audit --omit=dev` currently reports moderate findings in the MCP SDK's
Express dependency chain. This server uses stdio only, not an HTTP listener, so
the practical exposure is narrower than a network service. The finding is
tracked openly and should be remediated when the upstream SDK ships a fixed
dependency path.

## What this server does not do

- No send-mail or reply-send tool. Drafts only.
- No mailbox rules CRUD (Mail.ReadWrite would technically allow it; the
  policy boundary refuses).
- No shared mailbox or shared calendar access.
- No Teams chat, OneDrive, SharePoint, Drive, or Planner tools.
- No daemon mode. Stdio only — the agent runtime owns process lifetime.
- No SSO. Caller identity is inherited from the spawning process. Adding
  per-caller authentication is a separate review step.
- No rate limiting. Adding per-tool throttles is a separate review step.
