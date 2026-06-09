---
name: add-cuassistant
description: Install CUassistant's MCP servers into a NanoClaw v2 agent group. Registers the host-side credentialed server (MS365 mail/calendar/tasks + send-via-approval-gate) over HTTP and the public Clemson class-schedule server over stdio, so the agent gains tools mangled as `cuassistant-credentialed__*` and `cuassistant-public__*`. Use when the user asks to install, add, wire, or enable CUassistant in NanoClaw.
---

# /add-cuassistant

Install CUassistant's two MCP servers into a NanoClaw v2 agent group. This is a
v2-style install skill: small trunk, skill-installed extras — the NanoClaw trunk
stays empty of CUassistant code; this skill registers already-running /
spawnable MCP servers with the agent group.

## What this installs

Two servers, split by security class. The credential never enters the container.

- **`cuassistant-credentialed`** — registered as an **HTTP** server pointing at
  the host. Holds the MS365 token (and Gmail via `gws`); runs as a host
  process. Exposes mail/calendar/tasks reads, the `approval: none` mail/calendar
  writes (move, mark-read, draft, create/update event), host scan-status reads,
  and the send tools (`send-outlook-mail` / `send-gmail` / `get-send-status`)
  which go through the Telegram human-approval gate. It is a vendor-neutral
  credentialed registry: future credentialed vendors register here,
  vendor-namespaced — they do not get their own server.
- **`cuassistant-public`** — registered as a **stdio** server. No credentials;
  public Clemson Banner class-schedule data only; safe to run as a subprocess
  inside the container.

NanoClaw name-mangles tools as `<serverName>__<tool>`, e.g.
`cuassistant-credentialed__send-outlook-mail`,
`cuassistant-public__search-clemson-classes`.

Full tool inventory (exposed + the policy-gated-not-exposed set):
`<CUassistant repo>/src/mcp-server.md`.

## Prerequisites — verify before installing

1. **CUassistant is checked out and `npm install` has been run.** The repo path
   must be known. If `$CUASSISTANT_REPO` is not set in the user's shell, ask for
   the absolute path before proceeding — do not guess.
2. **The host credentialed MCP server is running over HTTP.** Either
   `cd $CUASSISTANT_REPO && npm run mcp:http` (binds
   `127.0.0.1:${MCP_HTTP_PORT:-8765}`), or the launchd service
   `launchd/com.cuassistant.mcp-http.plist`. Confirm it is up before wiring the
   container.
3. **`MS365_REFRESH_TOKEN` is present in `$CUASSISTANT_REPO/.env`** (or
   vault-injected on the host). Without it the credentialed Graph tools cannot
   reach Microsoft 365.
4. **Auth (optional / interim).** Either set `MCP_AUTH_TOKEN` on the host server
   and register a vault-referenced bearer in the container (target), or run the
   host server with no `MCP_AUTH_TOKEN` on loopback and omit the header
   (interim). See step 1 below.

There is no Codex CLI / Outlook connector and no Graph-CLI token anymore — do
not look for them.

## Install steps

Carry these out in order, surfacing each one to the user before you fire.

### 1. Register `cuassistant-credentialed` (HTTP) in NanoClaw user/local config

Register it as an HTTP server with a `url` and a vault-referenced bearer header.
**Write this to NanoClaw's user/local (gitignored) config — NEVER the committed
`.mcp.json`.** The credentialed entry must not sit in version control.

```
add_mcp_server({
  name: "cuassistant-credentialed",
  url: "http://host.docker.internal:${MCP_HTTP_PORT:-8765}",
  headers: {
    Authorization: "Bearer ${CUASSISTANT_MCP_TOKEN}"
  }
})
```

The bearer is a **vault reference, not a literal**. OneCLI injects
`CUASSISTANT_MCP_TOKEN` into the container env at spawn; NanoClaw's bridge
expands `${...}` in the header value at connect time, so only the reference is
ever persisted on disk.

**Interim (before vault wiring):** run the host server with no `MCP_AUTH_TOKEN`
on loopback and **omit the `headers` block entirely** — register just the
`url`. The server is loopback-open in that mode.

### 2. Register `cuassistant-public` (stdio)

```
add_mcp_server({
  name: "cuassistant-public",
  command: "npm",
  args: ["--prefix", "<absolute path to CUassistant>", "run", "mcp:public"],
  env: {}
})
```

(Equivalently `command: "tsx", args: ["<repo>/src/mcp-public.ts"]`.) This server
holds no secrets, so running it as an in-container stdio subprocess is fine.

### 3. Inject agent docs

Append the section below to the agent group's `CLAUDE.md` so the model knows the
tool surface. Tools are name-mangled `<serverName>__<tool>`.

```markdown
## CUassistant

You have CUassistant MCP tools across two servers:

Credentialed (`cuassistant-credentialed__*`) — the user's MS365 assistant:

- _Mail (read)_: `list-mail-messages`, `get-mail-message`.
- _Mail (write)_: `move-mail-message`, `update-mail-message`,
  `create-draft-email` (draft only).
- _Calendar (read)_: `list-calendar-events`, `get-calendar-event`,
  `get-calendar-view`.
- _Calendar (write)_: `create-calendar-event`, `update-calendar-event`
  (personal primary calendar only; no attendees/invites).
- _Tasks_: `list-todo-task-lists`, `list-todo-tasks`, `get-todo-task`,
  `create-todo-task`, `update-todo-task`.
- _Orchestration (read)_: `get_scan_status`, `get_pending_actions`.
- _Send (approval-gated)_: `send-outlook-mail`, `send-gmail` submit a frozen
  request and return a `request_id`; nothing sends until the user approves it
  out-of-band via Telegram. Poll `get-send-status` for the outcome.

Public (`cuassistant-public__*`) — Clemson class schedule (public Banner data):

- `list-clemson-terms`, `search-clemson-classes`,
  `get-clemson-section-details`, `find-clemson-instructor-classes`,
  `get-clemson-room-availability`.

**Sends are never silent.** `send-outlook-mail` / `send-gmail` always go through
the Telegram approval gate; the user can reject with feedback.

**Routing**: to add a task / reminder / to-do, route through
`create-todo-task` with the title text only. Set due dates only from explicit
user phrasing — don't synthesize them; ask if uncertain.

Some destructive tools (task/event delete, RSVP, trigger_scan) are gated at the
policy boundary and not exposed.
```

### 4. Allowlist policy

Keep **all write and send tools OFF NanoClaw's allowlist** — they must always
prompt. After the install stabilizes, run `/fewer-permission-prompts` to
allowlist the **read-only** calls only (`list-*`, `get-*`, `search-*`,
`find-*`, `get_scan_status`, `get_pending_actions`). Leave every write/send
prompting.

### 5. Apply

After the two `add_mcp_server` calls and the CLAUDE.md edit are in place,
request a rebuild so the per-group container picks up the new config:

```
request_rebuild({ reason: "wire CUassistant MCP servers" })
```

(In NanoClaw v2 `add_mcp_server` is a pure config edit — only a container
restart is needed. `request_rebuild` is the unified term; the host decides
whether a rebuild or a plain restart applies.)

### 6. Smoke test

After the container restarts, verify each server with a read tool that has no
side effects:

```
cuassistant-public__list-clemson-terms()
cuassistant-credentialed__list-todo-task-lists()
```

The public call needs no host process or credential. The credentialed call
exercises the HTTP reach to the host server, the bearer (if set), and the MS365
token. If the credentialed call returns an auth error, confirm the host server
is running (`npm run mcp:http`) and that the bearer reference resolves (or, in
interim mode, that you registered the `url` with no `headers` and the server is
loopback-open). If it returns an empty list, the MS365 token may be missing or
expired in the host `.env`.

## What this skill does **not** do

- It does not start CUassistant's scheduled scan loop (cron / launchd) and does
  not modify the user's CUassistant `.env`. Those are separate per-host setup.
- It does not provision the vault entry for `CUASSISTANT_MCP_TOKEN`. Until that
  is wired, use interim loopback mode (no bearer).
- It does not expose the policy-gated tools (delete/RSVP/trigger_scan); those
  require widening `policy/action-policy.yaml` per the procedure in
  `<CUassistant repo>/src/mcp-server.md`.
