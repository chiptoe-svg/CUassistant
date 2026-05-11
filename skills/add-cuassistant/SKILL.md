---
name: add-cuassistant
description: Install CUassistant's MS365 MCP server into a NanoClaw v2 agent group. Wires the host-side stdio MCP server (Outlook mail/calendar reads via Codex CLI Outlook connector, MS To Do reads/writes via Graph CLI) so the agent gains tools prefixed `mcp__cuassistant__*`. Use when the user asks to install, add, wire, or enable CUassistant in NanoClaw.
---

# /add-cuassistant

Install the CUassistant MS365 MCP server into a NanoClaw v2 agent group.
This is a v2-style install skill: small trunk, skill-installed extras —
NanoClaw trunk stays empty of CUassistant code; this skill registers an
already-running host-side MCP server with the agent group.

## What this installs

A stdio MCP server (in the user's CUassistant checkout) that exposes
NanoClaw-compatible tools mirroring the @softeria/ms-365-mcp-server tool
surface but routed through CUassistant's Clemson-approved backends:

- **Active**: mail reads (Codex CLI Outlook connector), calendar reads
  (Codex CLI Outlook connector), MS To Do CRUD (Graph CLI client with
  Tasks.ReadWrite), and CUassistant scan orchestration (`trigger_scan`,
  `get_scan_status`, `get_pending_actions`).
- **Stub-pending-IT-approval**: mail writes (Mail.ReadWrite),
  calendar writes (Calendars.ReadWrite). The stubs return a structured
  `stub_pending_approval` error and activate when IT grants the scope —
  no tool-shape changes needed at activation.

Full tool inventory: `<CUassistant repo>/src/mcp-server.md`.

## Prerequisites — verify before installing

1. **CUassistant is checked out and installed.** The repo path must be
   known. Default expectation: `$CUASSISTANT_REPO` is set in the user's
   shell. If not set, ask the user for the absolute path before
   proceeding — do not guess.
2. **`npm install` has been run in CUassistant.** Required for the
   `@modelcontextprotocol/sdk` dependency.
3. **`GRAPH_CLI_REFRESH_TOKEN` is set** in `$CUASSISTANT_REPO/.env`.
   Without it, the To Do tools cannot reach Graph. To populate it:
   `cd $CUASSISTANT_REPO && npm run graph-cli-tasks-login`. If the
   user hasn't done this yet, halt the install and surface that step.
4. **Codex CLI is installed and signed in to ChatGPT Edu** with the
   Outlook Email connector enabled. Mail and calendar reads depend
   on it.

## Install steps

Carry these out in order, surfacing each one to the user before you fire.

### 1. Register the MCP server

Call the NanoClaw self-mod tool:

```
add_mcp_server({
  name: "cuassistant",
  command: "npm",
  args: ["--prefix", "$CUASSISTANT_REPO", "run", "mcp"],
  env: {
    CUASSISTANT_REPO: "<absolute path to the CUassistant checkout>"
  }
})
```

Substitute the actual absolute path for `<absolute path...>`. The MCP
server is host-side — it runs in the user's host shell, not in any
container. No credential mounts are required (and per the CUassistant
review notes, none should be added: the Graph CLI refresh token is
host-only).

### 2. Inject agent docs

Append the section below to the agent group's `CLAUDE.md` so the model
knows the tool surface:

```markdown
## CUassistant

You have MCP tools prefixed with `mcp__cuassistant__` for the user's
email-triage assistant. Use these for Outlook mail and calendar reads,
Microsoft To Do task management, and triggering email scans.

Active tools today:
- *Mail (read)*: `list-mail-messages`, `get-mail-message`.
- *Calendar (read)*: `list-calendar-events`, `get-calendar-event`,
  `get-calendar-view`.
- *Tasks*: `list-todo-task-lists`, `list-todo-tasks`, `get-todo-task`,
  `create-todo-task`, `update-todo-task`, `delete-todo-task`.
- *Orchestration*: `trigger_scan` (run an email triage scan immediately,
  with optional `dry_run`), `get_scan_status` (read recent decisions),
  `get_pending_actions` (decisions that asked for a task but didn't
  produce one).

Stubs pending IT approval (return a structured `stub_pending_approval`
error today):
- *Mail (write)*: `move-mail-message`, `update-mail-message`,
  `create-draft-email` — pending Mail.ReadWrite consent.
- *Calendar (write)*: `create-calendar-event`, `update-calendar-event`,
  `delete-calendar-event`, `accept-calendar-event`,
  `decline-calendar-event`, `tentatively-accept-calendar-event` —
  pending Calendars.ReadWrite consent.

**There is no send-mail tool, by design.** The drafts surface ends at
`create-draft-email`; the user sends from Outlook.

**Routing**: when the user asks to add a task, remind them, or convert
an email action item into a to-do, route through `create-todo-task` with
the title text only. Set due dates from explicit user phrasing — don't
synthesize due dates from heuristics; ask if uncertain.
```

### 3. Apply

After both `add_mcp_server` and the CLAUDE.md edit are in place, request
a rebuild so the per-group container picks up the new MCP server config:

```
request_rebuild({ reason: "wire CUassistant MCP server" })
```

(In NanoClaw v2, `add_mcp_server` is a pure config edit — no image
rebuild is required, only a container restart. `request_rebuild` is the
unified term the agent uses; the host decides whether a rebuild or a
plain restart is needed.)

### 4. Smoke test

After the container restarts, verify the install by calling a read tool
that has no side effects:

```
mcp__cuassistant__list-todo-task-lists()
```

Expect a JSON object with a `lists` array containing at least the
default `Tasks` list. If the call returns
`Graph CLI returned no lists`, the refresh token is missing or expired —
guide the user to re-run `npm run graph-cli-tasks-login`.

## What this skill does **not** do

- It does not start CUassistant's scheduled scan loop (cron / launchd).
  That is a separate per-host setup; this skill only wires the MCP
  server. The scan can also be invoked on demand via
  `mcp__cuassistant__trigger_scan`.
- It does not request Mail.ReadWrite or Calendars.ReadWrite from IT.
  Those are out-of-band approvals; once granted, follow the activation
  procedure in `<CUassistant repo>/src/mcp-server.md`.
- It does not modify the user's CUassistant `.env`. Token-refresh
  helpers are run separately (`npm run graph-cli-tasks-login`).

## v1-fork installs

NanoClaw v1 forks (e.g. CUagent) load provider plugins from a JSON
registry. For those installs, copy
`<CUassistant repo>/container/providers/v1-fork/cuassistant.json` into
`~/.nanoclaw/providers/`. v2 does not use that path; use this skill
instead.
