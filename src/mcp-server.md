# CUassistant MCP server — IT review manifest

This is the human-readable companion to `src/mcp-server.ts`. It enumerates
the MCP operation surface, what backend each operation uses, what permission it
requires, and whether the tool is exposed to the agent.

## Architecture summary

- **Transport.** stdio (`@modelcontextprotocol/sdk` `StdioServerTransport`).
  The server is a local host MCP server, not a containerized service. Stdio is
  the only listener — no HTTP, no socket.
- **Backend.** A single Microsoft Graph backend: the GCassistant Azure AD app,
  reached through the shared helper `src/mcp-tools/graph-helpers.ts`
  (`authedFetch` on `getMs365AccessToken`). Consented delegated scopes:
  `Mail.ReadWrite`, `Tasks.ReadWrite`, `Calendars.ReadWrite`. Gmail send (via
  the local `gws` CLI) is the only non-Graph backend and only for the approval
  gate.
- **Credentials.** Host-only. The GCassistant refresh token in
  `${CUASSISTANT_REPO}/.env` (`MS365_REFRESH_TOKEN`) is read by the host
  process and never crosses any boundary. If a containerized agent runtime
  launches this MCP server, it connects through stdio and requests operations
  through tools — it never receives credentials directly.
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
  execute. Destructive or affects-others actions (mail/event delete, RSVP, task
  delete, trigger-scan) are `approval: human_required` and are therefore wired
  but not registered.
- **Audit.** Every write tool wraps its backend call in an intent + terminal
  pair written to `state/decisions.jsonl` via the same `appendDecision()` the
  scan flow uses. Reviewers see one source of truth for "what changed and
  why."

## Operation table

| Tool                                | Operation key                       | Policy action                    | Backend           | Permission required        | Exposed                     |
| ----------------------------------- | ----------------------------------- | -------------------------------- | ----------------- | -------------------------- | --------------------------- |
| `list-mail-messages`                | `mail.list_messages`                | `mail.list_inbox`                | GCassistant Graph | Mail.ReadWrite             | yes                         |
| `get-mail-message`                  | `mail.get_message`                  | `mail.fetch_body`                | GCassistant Graph | Mail.ReadWrite             | yes                         |
| `list-calendar-events`              | `calendar.list_events`              | `calendar.list_events`           | GCassistant Graph | Calendars.ReadWrite        | yes                         |
| `get-calendar-event`                | `calendar.get_event`                | `calendar.get_event`             | GCassistant Graph | Calendars.ReadWrite        | yes                         |
| `get-calendar-view`                 | `calendar.get_view`                 | `calendar.get_view`              | GCassistant Graph | Calendars.ReadWrite        | yes                         |
| `list-todo-task-lists`              | `todo.list_lists`                   | `todo.list_lists`                | GCassistant Graph | Tasks.ReadWrite            | yes                         |
| `list-todo-tasks`                   | `todo.list_tasks`                   | `todo.list_tasks`                | GCassistant Graph | Tasks.ReadWrite            | yes                         |
| `get-todo-task`                     | `todo.get_task`                     | `todo.get_task`                  | GCassistant Graph | Tasks.ReadWrite            | yes                         |
| `create-todo-task`                  | `todo.create_task`                  | `todo.create_task`               | GCassistant Graph | Tasks.ReadWrite            | yes                         |
| `update-todo-task`                  | `todo.update_task`                  | `todo.update_task`               | GCassistant Graph | Tasks.ReadWrite            | yes                         |
| `delete-todo-task`                  | `todo.delete_task`                  | `todo.delete_task`               | GCassistant Graph | Tasks.ReadWrite            | no: policy-blocked          |
| `move-mail-message`                 | `mail.move_message`                 | `mail.move_message`              | GCassistant Graph | Mail.ReadWrite             | yes (needs dest allow-list) |
| `update-mail-message`               | `mail.update_message`               | `mail.update_message`            | GCassistant Graph | Mail.ReadWrite             | yes                         |
| `create-draft-email`                | `mail.create_draft`                 | `mail.create_draft`              | GCassistant Graph | Mail.ReadWrite             | yes                         |
| `create-calendar-event`             | `calendar.create_event`             | `calendar.create_personal_event` | GCassistant Graph | Calendars.ReadWrite        | yes                         |
| `update-calendar-event`             | `calendar.update_event`             | `calendar.update_personal_event` | GCassistant Graph | Calendars.ReadWrite        | yes                         |
| `delete-calendar-event`             | `calendar.delete_event`             | `calendar.delete_event`          | GCassistant Graph | Calendars.ReadWrite        | no: policy-blocked          |
| `accept-calendar-event`             | `calendar.accept_event`             | `calendar.respond_to_invite`     | GCassistant Graph | Calendars.ReadWrite        | no: policy-blocked          |
| `decline-calendar-event`            | `calendar.decline_event`            | `calendar.respond_to_invite`     | GCassistant Graph | Calendars.ReadWrite        | no: policy-blocked          |
| `tentatively-accept-calendar-event` | `calendar.tentatively_accept_event` | `calendar.respond_to_invite`     | GCassistant Graph | Calendars.ReadWrite        | no: policy-blocked          |
| `trigger_scan`                      | `host.trigger_scan`                 | `host.trigger_scan`              | host (scan.ts)    | scan flow's scopes         | no: policy-blocked          |
| `get_scan_status`                   | `host.get_scan_status`              | `host.get_scan_status`           | host (state read) | none                       | yes                         |
| `get_pending_actions`               | `host.get_pending_actions`          | `host.get_pending_actions`       | host (state read) | none                       | yes                         |
| `request_send_mail`                 | `mail.send_with_approval`           | `mail.send_with_approval`        | host gate + gws   | gmail.send                 | yes: gate config required   |
| `get_send_status`                   | `mail.send_with_approval`           | `mail.send_with_approval`        | host gate         | —                          | yes                         |

## Tool details

### Mail reads — GCassistant Graph (Mail.ReadWrite)

- `list-mail-messages` — list Outlook Inbox messages, newest first. Optional
  `sinceIso` and `untilIso` filters. Returns minimal metadata only; bodies
  are fetched separately via `get-mail-message`.
- `get-mail-message` — fetch one message's subject and body by id.

### Calendar reads — GCassistant Graph (Calendars.ReadWrite)

- `list-calendar-events` — list events ordered by start time.
- `get-calendar-event` — fetch one event by id.
- `get-calendar-view` — events in a window with recurrences expanded into
  occurrences (Graph `calendarView` semantics).

### Task reads/writes — GCassistant Graph (Tasks.ReadWrite)

- `list-todo-task-lists` — discover task lists. Used to find the default
  `Tasks` list.
- `list-todo-tasks`, `get-todo-task` — read tasks.
- `create-todo-task` — create a task. Optional `auditMarker` builds the body
  via CUassistant's existing `formatTaskBody()` so MCP-created tasks share
  the same dedupe convention as scan-created tasks.
- `update-todo-task` — patch title, status, importance, due date, body.
- `delete-todo-task` — wired but not exposed; `todo.delete_task` is
  `approval: human_required`.

### Mail writes — GCassistant Graph (Mail.ReadWrite)

Active. Policy constraints are enforced on every call:

- `move-mail-message` — move a message into a target folder. `POST
  /me/messages/{id}/move`. Requires the `MCP_ALLOWED_MAIL_DESTINATIONS`
  env allow-list (fails closed without it); junk/deleted/recoverable folders
  are rejected.
- `update-mail-message` — patch metadata only (mark read, flag, importance,
  categories). `PATCH /me/messages/{id}`. Body rewrites and send/delete are
  rejected by policy.
- `create-draft-email` — create a draft in the Drafts folder. `POST
  /me/messages`. Draft only; **no send tool exists here** — sending goes
  through the separate approval gate.

### Calendar writes — GCassistant Graph (Calendars.ReadWrite)

- `create-calendar-event`, `update-calendar-event` — active. Personal events
  on the user's primary calendar only; attendees/invites and shared/delegated
  calendars are rejected by policy.
- `delete-calendar-event` and RSVP (`accept-`, `decline-`,
  `tentatively-accept-calendar-event`) — wired but not exposed; they map to
  `approval: human_required` policy actions.

### Host orchestration

CUassistant-specific tools (not in CUagent's MCP surface) for NanoClaw
agents to drive the scan loop on demand.

- `trigger_scan` — invoke `runScan()` directly in the host process. Wired but
  not exposed (`host.trigger_scan` is `approval: human_required`). Acquires the
  scan lock and refuses if another run is in progress. Honors the optional
  `dry_run` flag. (If scan logic ever moves into a NanoClaw v2 container,
  `trigger_scan` should instead enqueue a request to a SQLite queue per
  NanoClaw v2's `inbound.db` / `outbound.db` IPC model.)
- `get_scan_status` — read the most recent rows from `state/decisions.jsonl`.
- `get_pending_actions` — return decisions that asked for a task but didn't
  produce one (items awaiting follow-up).

### Send mail — approval gate (host gate + gws)

`request_send_mail` submits a frozen artifact to the host-side `ApprovalGate`
and returns a `request_id`; nothing is sent until the user approves
out-of-band. `get_send_status` polls the outcome. The gate only initializes
when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_APPROVER_USER_ID` are set; until then
`request_send_mail` returns "approval gate not initialized." The wired sender
backend is Gmail via the `gws` CLI (`gmail.send`); the MS365 Graph `sendMail`
(`Mail.Send`) backend is not yet wired into `makeSender`, so `account: "ms365"`
is refused even though the consent now exists.

## Widening a policy-blocked operation

`delete-todo-task`, `delete-calendar-event`, the three RSVP tools, and
`trigger_scan` are fully wired to a backend but stay unregistered because their
mapped policy action is `approval: human_required`. To expose one:

1. Change the action's `approval` to `none` in `policy/action-policy.yaml`
   (only if the action is genuinely safe to run unattended), or route it
   through a human-approval gate equivalent to the send gate.
2. Confirm the action's policy constraints are enforced by validators in
   `src/mcp-tools/permissions.ts`.
3. Re-run `npm test` and `npm run typecheck`, and update the table above.

## Dependency note

`npm audit --omit=dev` currently reports moderate findings in the MCP SDK's
Express dependency chain. This server uses stdio only, not an HTTP listener, so
the practical exposure is narrower than a network service. The finding is
tracked openly and should be remediated when the upstream SDK ships a fixed
dependency path.

## What this server does not do

- No send-mail tool outside the approval gate. Drafts only on the mail-write
  surface.
- No mailbox rules CRUD (Mail.ReadWrite would technically allow it; the
  policy boundary refuses).
- No shared mailbox or shared calendar access.
- No Teams chat, OneDrive, SharePoint, Drive, or Planner tools.
- No daemon mode. Stdio only — the agent runtime owns process lifetime.
- No SSO. Caller identity is inherited from the spawning process. Adding
  per-caller authentication is a separate review step.
- No rate limiting. Adding per-tool throttles is a separate review step.
