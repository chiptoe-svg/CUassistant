# CUassistant MCP servers — IT review manifest

This is the human-readable companion to the MCP entry points
(`src/mcp-server.ts`, `src/mcp-public.ts`). It enumerates the MCP operation
surface across **two servers**, what backend each operation uses, what
permission it requires, and whether the tool is exposed to the agent.

## Two servers, split by security class

CUassistant exposes its capabilities through two MCP servers, separated by
whether they hold credentials — not by vendor domain.

### `cuassistant-credentialed` (host process)

- **What.** All credentialed accounts and host orchestration: MS365
  mail/calendar/tasks today, Clemson Gmail (`gws`) and future credentialed
  vendors next, plus the host scan orchestration and the send-approval gate.
  This is a **vendor-neutral credentialed registry** — new credentialed
  vendors register here (vendor-namespaced, e.g. `send-outlook-mail` /
  `send-gmail`); they do not get their own server.
- **Transports.** Dual.
  - **stdio** — `npm run mcp` (`tsx src/mcp-server.ts`). For local/dev/tests.
  - **Streamable HTTP** — `npm run mcp:http` (`MCP_TRANSPORT=http`). Binds
    `${MCP_HTTP_HOST:-127.0.0.1}:${MCP_HTTP_PORT:-8765}`. This is the path a
    containerized NanoClaw agent uses, reaching the host via
    `host.docker.internal`. A launchd service
    (`launchd/com.cuassistant.mcp-http.plist`) runs it as a host daemon.
- **Inbound auth (per-agent token registry).** Each authorized agent has its
  **own** bearer token, minted with `npm run mcp:pair -- --id <agent>`; only the
  SHA-256 hash is stored (`state/mcp-consumers.json`). A request is admitted only
  if its `Authorization: Bearer …` hashes to a registered consumer, and the
  matched consumer id is the audit identity. The HTTP transport **fails closed**
  — it refuses to start with no authorized consumers (no silent loopback-open);
  there is no shared global secret, so an un-provisioned workload on the same
  host gets nothing. Grant by provisioning, revoke with
  `npm run mcp:consumers -- --revoke <agent>`; the registry reloads per request,
  so grant/revoke take effect without a restart. A single `MCP_AUTH_TOKEN`, if
  set, is also accepted (as consumer `env-token`) for simple setups. The stdio
  transport needs no token (no port). See `docs/security/secret-rotation.md`.
  (mTLS is available as an optional per-agent upgrade but is not the baseline —
  bearer tokens carry no cert-expiry outage risk.)
- **Backends.** Microsoft Graph via the GCassistant Azure AD app, reached
  through `src/mcp-tools/graph-helpers.ts` (`authedFetch` on
  `getMs365AccessToken`). Consented delegated scopes: `Mail.ReadWrite`,
  `Tasks.ReadWrite`, `Calendars.ReadWrite`, and `Mail.Send` (for Outlook
  sending through the gate). The send gate's Gmail path uses the local `gws`
  CLI.
- **Credentials.** Host-only. `MS365_REFRESH_TOKEN` is read from a pluggable
  secret resolver — `.env` for standalone use, OneCLI vault injection under
  NanoClaw — by the host process and never crosses any boundary. A
  containerized agent connects over HTTP and requests operations through
  tools; it never receives credentials directly. Do not mount the host's
  `.env` or token directories into any container.

### `cuassistant-public` (no credentials)

- **What.** The Clemson class-schedule tools backed by Clemson's public
  Banner Browse Classes API. No credentials, public data only.
- **Transports.** Dual.
  - **Streamable HTTP** — `npm run mcp:public:http` (`MCP_TRANSPORT=http`).
    Binds `${MCP_PUBLIC_HTTP_HOST:-127.0.0.1}:${MCP_PUBLIC_HTTP_PORT:-8766}`.
    This is the path a containerized NanoClaw agent uses, reaching the host via
    `host.docker.internal:8766`. No bearer required (public data; loopback-open).
    A launchd service (`launchd/com.cuassistant.mcp-public-http.plist`) runs it
    as a host daemon.
  - **stdio** — `npm run mcp:public` (`tsx src/mcp-public.ts`). Retained for
    local/dev use only. stdio-in-container cannot work because NanoClaw's
    container has no host path, no CUassistant repo, and no node/tsx.
- **Inbound auth.** None — public data, no bearer. The server is
  **loopback-open** (`127.0.0.1` only; not network-exposed).
- **Ops note.** Both HTTP servers are loopback-only. Their ports are tracked in
  `~/.dev-ports.yaml` (cuassistant: `mcp_credentialed` 8765, `mcp_public` 8766).
  To bring up both: `npm run mcp:http` (credentialed, 8765) and
  `npm run mcp:public:http` (public, 8766) — or load their respective launchd
  plists.

## Allow-list and authorized use

- `src/mcp-tools/permissions.ts` is the operation registry; both servers
  assert against it. `policy/action-policy.yaml` is the policy registry. A
  tool is exposed only when its operation is active **and** maps to an
  `approval: none` policy action; registration fails closed otherwise. Every
  tool calls `assertMcpOperation()` before any backend call, and write tools
  pass normalized inputs through policy constraint validators.
- OAuth scopes describe what the delegated token may technically permit; the
  authorized-use list (`action-policy.yaml`) describes what CUassistant is
  allowed to expose. Destructive or affects-others actions (mail/event delete,
  RSVP, task delete, trigger-scan) are `approval: human_required` and are
  therefore **wired but not exposed**.
- **Audit.** Every write/send tool wraps its backend call in an intent +
  terminal pair written to `state/decisions.jsonl` via `appendDecision()` —
  one source of truth for what changed and why.

## Operation table — `cuassistant-credentialed`

| Tool                    | Operation key              | Policy action                    | Backend           | Scope               | Exposed                  |
| ----------------------- | -------------------------- | -------------------------------- | ----------------- | ------------------- | ------------------------ |
| `list-mail-messages`    | `mail.list_messages`       | `mail.list_inbox`                | GCassistant Graph | Mail.ReadWrite      | yes                      |
| `get-mail-message`      | `mail.get_message`         | `mail.fetch_body`                | GCassistant Graph | Mail.ReadWrite      | yes                      |
| `list-mail-folders`     | `mail.list_folders`        | `mail.list_folders`              | Graph / gws       | Mail.ReadWrite/gws  | yes                      |
| `move-mail-message`     | `mail.move_message`        | `mail.move_message`              | Graph / gws       | Mail.ReadWrite/gws  | yes (needs dest subtree) |
| `update-mail-message`   | `mail.update_message`      | `mail.update_message`            | GCassistant Graph | Mail.ReadWrite      | yes                      |
| `create-draft-email`    | `mail.create_draft`        | `mail.create_draft`              | GCassistant Graph | Mail.ReadWrite      | yes                      |
| `list-calendar-events`  | `calendar.list_events`     | `calendar.list_events`           | GCassistant Graph | Calendars.ReadWrite | yes                      |
| `get-calendar-event`    | `calendar.get_event`       | `calendar.get_event`             | GCassistant Graph | Calendars.ReadWrite | yes                      |
| `get-calendar-view`     | `calendar.get_view`        | `calendar.get_view`              | GCassistant Graph | Calendars.ReadWrite | yes                      |
| `create-calendar-event` | `calendar.create_event`    | `calendar.create_personal_event` | GCassistant Graph | Calendars.ReadWrite | yes                      |
| `update-calendar-event` | `calendar.update_event`    | `calendar.update_personal_event` | GCassistant Graph | Calendars.ReadWrite | yes                      |
| `list-todo-task-lists`  | `todo.list_lists`          | `todo.list_lists`                | GCassistant Graph | Tasks.ReadWrite     | yes                      |
| `list-todo-tasks`       | `todo.list_tasks`          | `todo.list_tasks`                | GCassistant Graph | Tasks.ReadWrite     | yes                      |
| `get-todo-task`         | `todo.get_task`            | `todo.get_task`                  | GCassistant Graph | Tasks.ReadWrite     | yes                      |
| `create-todo-task`      | `todo.create_task`         | `todo.create_task`               | GCassistant Graph | Tasks.ReadWrite     | yes                      |
| `update-todo-task`      | `todo.update_task`         | `todo.update_task`               | GCassistant Graph | Tasks.ReadWrite     | yes                      |
| `get_scan_status`       | `host.get_scan_status`     | `host.get_scan_status`           | host (state read) | none                | yes                      |
| `get_pending_actions`   | `host.get_pending_actions` | `host.get_pending_actions`       | host (state read) | none                | yes                      |
| `send-outlook-mail`     | `mail.send_with_approval`  | `mail.send_with_approval`        | host gate + Graph | Mail.Send           | yes: via approval gate   |
| `send-gmail`            | `mail.send_with_approval`  | `mail.send_with_approval`        | host gate + `gws` | gmail.send          | yes: via approval gate   |
| `get-send-status`       | `mail.send_with_approval`  | `mail.send_with_approval`        | host gate         | —                   | yes                      |

### Wired but NOT exposed (policy `human_required`)

These tools are fully wired to a backend but stay unregistered because their
mapped policy action is `approval: human_required`. They are gated, not absent.

| Tool                                | Policy action                | Why                   |
| ----------------------------------- | ---------------------------- | --------------------- |
| `delete-todo-task`                  | `todo.delete_task`           | destructive           |
| `delete-calendar-event`             | `calendar.delete_event`      | destructive           |
| `accept-calendar-event`             | `calendar.respond_to_invite` | affects others (RSVP) |
| `decline-calendar-event`            | `calendar.respond_to_invite` | affects others (RSVP) |
| `tentatively-accept-calendar-event` | `calendar.respond_to_invite` | affects others (RSVP) |
| `trigger_scan`                      | `host.trigger_scan`          | host side effect      |

## Operation table — `cuassistant-public`

| Tool                              | Operation key                | Policy action                | Backend | Exposed |
| --------------------------------- | ---------------------------- | ---------------------------- | ------- | ------- |
| `list-clemson-terms`              | `clemson.list_terms`         | `clemson.list_terms`         | Banner  | yes     |
| `search-clemson-classes`          | `clemson.search_classes`     | `clemson.search_classes`     | Banner  | yes     |
| `get-clemson-section-details`     | `clemson.section_details`    | `clemson.section_details`    | Banner  | yes     |
| `find-clemson-instructor-classes` | `clemson.instructor_classes` | `clemson.instructor_classes` | Banner  | yes     |
| `get-clemson-room-availability`   | `clemson.room_availability`  | `clemson.room_availability`  | Banner  | yes     |

## Tool details

### Mail reads — GCassistant Graph (Mail.ReadWrite)

- `list-mail-messages` — list Outlook Inbox messages, newest first. Optional
  `sinceIso` / `untilIso` filters. Metadata only; bodies fetched separately.
- `get-mail-message` — fetch one message's subject and body by id.

### Mail writes — GCassistant Graph (Mail.ReadWrite)

Active; policy constraints enforced on every call.

- `list-mail-folders` — read-only destination discovery. `account: "ms365"`
  (Outlook folders via Graph) or `"g.clemson"` (Gmail user labels via gws).
  Returns `{path, id, allowed}`; `allowed` reflects the subtree allow-list.
- `move-mail-message` — `{account, id, destination}` where `destination` is a
  folder/label **path** (e.g. `sorted/Newsletters`). `ms365` →
  `POST /me/messages/{id}/move`; `g.clemson` → gws `messages modify` (add label +
  remove `INBOX`). The path must be under `MCP_ALLOWED_MAIL_DESTINATIONS`
  (segment-aware prefixes; fails closed without it) and resolve to a real
  folder/label; junk/deleted/recoverable are rejected.
- `update-mail-message` — `PATCH /me/messages/{id}`, metadata only (mark read,
  flag, importance, categories). Body rewrites and send/delete rejected.
- `create-draft-email` — `POST /me/messages`. Draft only; sending goes through
  the separate approval gate.

### Calendar reads / writes — GCassistant Graph (Calendars.ReadWrite)

- `list-calendar-events`, `get-calendar-event` — read events.
- `get-calendar-view` — events in a window with recurrences expanded.
- `create-calendar-event`, `update-calendar-event` — active; personal events on
  the user's primary calendar only. Attendees/invites and shared/delegated
  calendars are rejected by policy.
- `delete-calendar-event` and the three RSVP tools — wired but not exposed
  (`approval: human_required`).

### Task reads / writes — GCassistant Graph (Tasks.ReadWrite)

- `list-todo-task-lists`, `list-todo-tasks`, `get-todo-task` — reads.
- `create-todo-task` — optional `auditMarker` builds the body via
  `formatTaskBody()` so MCP-created tasks share the scan dedupe convention.
- `update-todo-task` — patch title, status, importance, due date, body.
- `delete-todo-task` — wired but not exposed (`approval: human_required`).

### Host orchestration

- `get_scan_status` — read recent rows from `state/decisions.jsonl`.
- `get_pending_actions` — decisions that asked for a task but produced none.
- `trigger_scan` — wired but not exposed (`host.trigger_scan` is
  `approval: human_required`). Runs `runScan()` in the host process behind the
  scan lock, honoring an optional `dry_run` flag.

### Send mail — Telegram approval gate (host gate + Graph / `gws`)

- `send-outlook-mail` (Graph `sendMail`, `Mail.Send`) and `send-gmail` (`gws`,
  `gmail.send`) submit a **frozen** artifact to the host-side `ApprovalGate`
  and return a `request_id`. Nothing is sent until the user approves
  out-of-band via Telegram. Both are off any auto-allowlist.
- `get-send-status` polls the outcome (pending | sent | rejected+feedback |
  expired | failed).
- The gate only initializes when `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_APPROVER_USER_ID` are set; until then the send tools return
  "approval gate not initialized."

### Clemson public class schedule — `cuassistant-public` (Banner, no auth)

- `list-clemson-terms`, `search-clemson-classes`,
  `get-clemson-section-details`, `find-clemson-instructor-classes`,
  `get-clemson-room-availability` — read Clemson's public Banner Browse
  Classes data. No credentials.

## Widening a policy-blocked operation

`delete-todo-task`, `delete-calendar-event`, the three RSVP tools, and
`trigger_scan` are fully wired but unregistered because their policy action is
`approval: human_required`. To expose one:

1. Change the action's `approval` to `none` in `policy/action-policy.yaml`
   (only if genuinely safe unattended), or route it through a human-approval
   gate equivalent to the send gate.
2. Confirm the action's policy constraints are enforced by validators in
   `src/mcp-tools/permissions.ts`.
3. Re-run `npm test` and `npm run typecheck`, and update the table above.

## What these servers do not do

- No send-mail outside the Telegram approval gate. Drafts only on the
  mail-write surface.
- No mailbox rules CRUD; no shared mailbox or shared calendar access.
- No Teams chat, OneDrive, SharePoint, Drive, or Planner tools.
- No SSO. Caller identity on stdio is inherited from the spawning process; on
  HTTP it is the per-agent registry token (the matched consumer id). Federated
  identity beyond the token registry is a separate review step.
- No rate limiting beyond the send gate's throttles. Per-tool throttles are a
  separate review step.
