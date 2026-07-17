---
name: add-cuassistant
description: Install CUassistant's MCP servers into a NanoClaw v2 agent group. Registers the host-side credentialed server (MS365 mail/calendar/tasks + send-via-approval-gate) on :8765, the public Clemson class-schedule server on :8766, and the public GC catalog server (degree plans + graduation rules, via gc_advisor) on :8767. Agent gains tools mangled as `cuassistant-credentialed__*`, `cuassistant-public__*`, and `cuassistant-catalog__*`. Use when the user asks to install, add, wire, or enable CUassistant in NanoClaw.
---

# /add-cuassistant

Install CUassistant's three MCP servers into a NanoClaw v2 agent group. This is a
v2-style install skill: small trunk, skill-installed extras — the NanoClaw trunk
stays empty of CUassistant code; this skill registers already-running /
spawnable MCP servers with the agent group.

## What this installs

Three servers, split by security class. Credentials never enter the container.

- **`cuassistant-credentialed`** — registered as an **HTTP** server pointing at
  the host. Holds the MS365 token (and Gmail via `gws`); runs as a host
  process. Exposes mail/calendar/tasks reads, the `approval: none` mail/calendar
  writes (move, mark-read, draft, create/update event), host scan-status reads,
  and the send tools (`send-outlook-mail` / `send-gmail` / `get-send-status`)
  which go through the Telegram human-approval gate. It is a vendor-neutral
  credentialed registry: future credentialed vendors register here,
  vendor-namespaced — they do not get their own server.
- **`cuassistant-public`** — registered as an **HTTP** server pointing at the
  host (`host.docker.internal:8766`). No credentials; public Clemson Banner
  class-schedule data only; no bearer required. Stdio-in-container cannot work
  because NanoClaw's Bun container has no host path, no CUassistant repo, and no
  node/tsx — so this server is served over loopback HTTP just like the
  credentialed one.
- **`cuassistant-catalog`** — registered as an **HTTP** server pointing at the
  host (`host.docker.internal:8767`). No credentials; public GC catalog data
  (degree plans, graduation requirements, program rules) via the `gc_advisor`
  project. Exposes `list-gc-catalog-years` and `get-gc-program-plan`. Must not be
  confused with the `curriculum_developer` faculty tool — this server is
  read-only catalog/rules data, not course-content management.

NanoClaw name-mangles tools as `<serverName>__<tool>`, e.g.
`cuassistant-credentialed__send-outlook-mail`,
`cuassistant-public__search-clemson-classes`.

Full tool inventory (exposed + the policy-gated-not-exposed set):
`<CUassistant repo>/src/mcp-server.md`.

## Prerequisites — verify before installing

1. **CUassistant is checked out and `npm install` has been run.** The repo path
   must be known. If `$CUASSISTANT_REPO` is not set in the user's shell, ask for
   the absolute path before proceeding — do not guess.
2. **All three host MCP servers are running over HTTP.**
   - `npm run mcp:http` (credentialed, binds `127.0.0.1:${MCP_HTTP_PORT:-8765}`)
     — or the launchd service `launchd/com.cuassistant.mcp-http.plist`.
   - `npm run mcp:public:http` (public, binds
     `127.0.0.1:${MCP_PUBLIC_HTTP_PORT:-8766}`) — or the launchd service
     `launchd/com.cuassistant.mcp-public-http.plist`.
   - `npm run mcp:catalog:http` (catalog, binds `127.0.0.1:8767`) — or the
     launchd service `launchd/com.cuassistant.mcp-catalog-http.plist`. Requires
     the `gc_advisor` project to be checked out at
     `/Users/admin/projects/gc_advisor` (or `GC_ADVISOR_*` env overrides set).
     Confirm all three are up before wiring the container.
3. **`MS365_REFRESH_TOKEN` is present in `$CUASSISTANT_REPO/.env`** (or
   vault-injected on the host). Without it the credentialed Graph tools cannot
   reach Microsoft 365.
4. **Auth (per-agent token + provider attestation, required).** The credentialed
   server fails closed — it won't start with no authorized consumers, and it
   rejects any consumer whose attested model **provider** isn't authorized in
   `policy/action-policy.yaml` (`data_egress.agent_backends`). Mint a token for
   THIS agent on the host, declaring its model-backend provider:
   `npm run mcp:pair -- --id <agent-id> --provider <chatgpt_edu|openai_api|local>`
   (prints the token once). Optionally narrow the token with
   `--scope mail:read,calendar:read,clemson` (omit for full access). Inject that
   token into only this agent's container env as `CUASSISTANT_MCP_TOKEN`. Each
   agent gets its own token; revoke with
   `npm run mcp:consumers -- --revoke <agent-id>`. To change a provider/scope
   without re-issuing the token (no container change), use
   `npm run mcp:consumers -- --attest <agent-id> --provider <p> [--scope ...]` —
   it takes effect on the next request (the registry is reloaded per request, no
   restart needed). The public server (8766) requires no token or attestation.

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

The bearer is a **vault reference, not a literal**. Mint this agent's token on
the host with `npm run mcp:pair -- --id <agent-id>`, then have OneCLI inject it
into the container env as `CUASSISTANT_MCP_TOKEN` at spawn; NanoClaw's bridge
expands `${...}` in the header value at connect time, so only the reference is
ever persisted on disk. Each agent has its own token in the host registry
(`state/mcp-consumers.json`, hash only); the matched consumer id is the audit
identity, and you revoke a single agent with
`npm run mcp:consumers -- --revoke <agent-id>`.

There is **no loopback-open mode** for the credentialed server — it fails closed
with no registered consumer. (A single host `MCP_AUTH_TOKEN` is also accepted,
as consumer `env-token`, for simple non-NanoClaw setups.)

### 2. Register `cuassistant-public` (HTTP)

```
add_mcp_server({
  name: "cuassistant-public",
  url: "http://host.docker.internal:8766/"
})
```

No `headers` block — this server is public (no bearer). The host must be running
`npm run mcp:public:http` (or the `com.cuassistant.mcp-public-http.plist` launchd
service) before the container connects. Stdio (`npm run mcp:public`) is retained
for local/dev use only; it cannot work inside the container because the Bun image
has no host path, no CUassistant repo, and no node/tsx.

### 3. Register `cuassistant-catalog` (HTTP)

```
add_mcp_server({
  name: "cuassistant-catalog",
  url: "http://host.docker.internal:8767/"
})
```

No `headers` block — open/loopback, public GC catalog data. The host must be
running `npm run mcp:catalog:http` (or the `com.cuassistant.mcp-catalog-http.plist`
launchd service) before the container connects. This server bridges to the
`gc_advisor` project's `query.py` — if `gc_advisor` is not on the same machine,
set `GC_ADVISOR_PYTHON`, `GC_ADVISOR_QUERY`, and `GC_ADVISOR_DB` in the host
environment before starting the server.

### 4. Inject agent docs  <!-- was step 3 -->

Append the section below to the agent group's `CLAUDE.md` so the model knows the
tool surface. Tools are name-mangled `<serverName>__<tool>`.

```markdown
## CUassistant

You have CUassistant MCP tools across two servers:

Credentialed (`cuassistant-credentialed__*`) — the user's MS365 assistant:

- _Mail (read)_: `list-mail-messages`, `get-mail-message` (`{id, account}` —
  returns subject, body, hasAttachments flag, and `attachments: [{id, name,
  contentType, size}]`; `account` = `ms365` (default) or `g.clemson`),
  `get-mail-attachment` (`{messageId, attachmentId, account}` — returns
  contentBytes in standard base64; for `g.clemson` name/contentType come from
  the `get-mail-message` attachments array, not this call),
  `list-mail-folders` (folder/label destinations; `account` = `ms365` or
  `g.clemson`).
- _Mail (write)_: `move-mail-message` (`{account, id, destination}` where
  `destination` is a folder/label path under the allowed subtree, e.g.
  `sorted/Newsletters`; works for both `ms365` and `g.clemson`),
  `update-mail-message`, `create-draft-email` (draft only).
- _Calendar (read)_: `list-calendar-events`, `get-calendar-event`,
  `get-calendar-view`.
- _Calendar (write)_: `create-calendar-event`, `update-calendar-event`
  (personal primary calendar only; no attendees/invites).
- _Tasks_: `list-todo-task-lists`, `list-todo-tasks`, `get-todo-task`,
  `create-todo-task`, `update-todo-task`.
- _Orchestration (read)_: `get_scan_status`, `get_pending_actions`.
- _Google Sheets (gws)_: `read-sheet-range`, `get-spreadsheet-info`,
  `create-spreadsheet`, `update-sheet-range`, `append-sheet-rows`.
- _Google Docs (gws)_: `read-doc`, `create-doc`, `append-doc-text`.
  **Read-any · append-any · update-own:** you can READ any Sheet/Doc and APPEND
  to any (additive — `append-sheet-rows`, `append-doc-text`). The one write that
  can overwrite existing data — `update-sheet-range` (cell overwrite) — only
  works on sheets THIS agent created (via `create-spreadsheet`); to allow it on
  a pre-existing sheet, the operator grants it with `npm run gws:grant`.
  `update-sheet-range` keeps formulas live with `valueInputOption: USER_ENTERED`;
  `append-sheet-rows` takes a `range` to target a tab. (Delete / share /
  overwrite-whole-body remain policy-gated and not exposed.)
- _Send (approval-gated)_: `send-outlook-mail`, `send-gmail` submit a frozen
  request and return a `request_id`; nothing sends until the user approves it
  out-of-band via Telegram. Poll `get-send-status` for the outcome.

Public (`cuassistant-public__*`) — Clemson class schedule (public Banner data):

- `list-clemson-terms`, `search-clemson-classes`,
  `get-clemson-section-details`, `find-clemson-instructor-classes`,
  `get-clemson-room-availability`, `check-schedule-conflicts`,
  `find-conflict-free-schedule`.
- Results include `snapshotDate` (when the daily snapshot was taken) and
  `scope` (`"snapshot"` or `"live"`). Pass `refresh:true` to force a live
  Banner query when up-to-the-minute seat counts matter; otherwise the
  snapshot is used automatically (faster, no Banner load).
- `check-schedule-conflicts { term, crns[] }` — given a list of CRNs, returns
  which pairs time-conflict and a `conflict_free` list of safe CRNs.
- `find-conflict-free-schedule { term, fixed_crns[], candidate_crns[] }` — finds
  which candidates can be added to a locked schedule without conflicts; per-
  candidate conflict detail included.

Catalog (`cuassistant-catalog__*`) — GC degree plans + graduation rules (public):

All responses include a `_source` field citing the Clemson University Online
Catalog edition so agents can attribute the data correctly.

- `list-gc-catalog-years` — lists available catalog years, e.g. `["2026-2027",
  …]`. Call this first to get a valid year string.
- `get-gc-program-plan` — full semester-by-semester degree plan for a program
  in a given catalog year: required courses, choice sets (one-of), requirement
  slots, per-term and total credits, footnotes. Args: `year` (required), `name`
  (default `"Graphic Communications, BS"`).
- `get-gc-requirement-rules` — lab science, specialty area (minor or 15-credit
  course set), and technical requirement rules for GC BS, with explicit course
  codes, total credits, and footnote text. Args: `year` (required).
- `get-gc-gen-ed` — all six Clemson Gen Ed categories (Communication,
  Mathematics, Natural Sciences with Lab, Arts and Humanities, Social Sciences,
  Global Challenges) with minimum credits, allowed course lists, constraint
  rules, and student learning outcomes. Args: `year` (required).
- `get-gc-course` — title, credits, description, and prerequisites (raw text +
  parsed course codes) for one course. Args: `code` (required, e.g. `"GC 3010"`
  or `"MKTG 3010"`).
- `audit-gc-progress` — deterministic degree audit against a sanitized
  progress record (course codes + terms + credits, no grades, no identity).
  Returns satisfied, partial, and open requirement slots. Args:
  `completed_courses: [{code, term, credits}]`, optional `year`, `program_name`.
- `find-eligible-sections` — advising join: finds Banner sections in a term that
  fulfill a specific GC requirement slot AND pass prereq-eligibility for the
  student. JOINs the per-term Banner snapshot with gc_advisor.db in a single
  SQL query. Args: `term`, `slot_type` (from `get-gc-requirement-rules`),
  `completed_courses: string[]`, optional `program_name`. Returns sections with
  `prereq_eligible`, meeting times, seats, and instructor. **Prereq check is
  AND-logic only** — OR prereqs may produce false negatives; show `prereq_text`
  for student to verify.

**Note:** `cuassistant-catalog` is degree-plan/graduation-rules data from
`gc_advisor`. It is NOT the `curriculum_developer` faculty tool (which manages
course content and learning outcomes — a separate system).

**Capability scopes (optional token narrowing).** A token may be limited to a set
of surface scopes; out-of-scope tools are hidden from the agent entirely. Tokens:
`mail:read · mail:write · mail:send · calendar:read · calendar:write · tasks:read ·
tasks:write · sheets:read · sheets:write · docs:read · docs:write · clemson ·
host:read`. No `--scope` = full access. `mail:send` is separate from `mail:write`,
so a token can read/triage mail without the ability to submit a send.

**Sends are never silent.** `send-outlook-mail` / `send-gmail` always go through
the Telegram approval gate; the user can reject with feedback.

**Routing**: to add a task / reminder / to-do, route through
`create-todo-task` with the title text only. Set due dates only from explicit
user phrasing — don't synthesize them; ask if uncertain.

Some destructive tools (task/event delete, RSVP, trigger_scan) are gated at the
policy boundary and not exposed.
```

### 5. Allowlist policy

Allowlisting only removes NanoClaw's in-band prompt — CUassistant's own policy
constraints (own-mailbox, subtree-only moves, metadata-only updates, draft-only,
primary-calendar-only) and the send-gate still apply. Recommended posture for
this operator (autonomous reversible actions; sends gated out-of-band):

- **Allowlist** all reads (`list-*`, `get-*`, `search-*`, `find-*`,
  `get_scan_status`, `get_pending_actions`, `get-mail-attachment`) **and** the reversible writes
  (`move-mail-message`, `update-mail-message`, `create-draft-email`,
  `create-calendar-event`, `update-calendar-event`, the `*todo*` writes).
- **Sends** (`send-outlook-mail`, `send-gmail`): allowlisting is optional —
  CUassistant's out-of-band Telegram gate is their authoritative human check, so
  allowlisting them yields a **single** approval (the gate) instead of two. If
  you prefer belt-and-suspenders, leave them off the allowlist for a second
  in-band prompt. Either way the gate still fires.
- Destructive ops (task/event delete, RSVP, trigger_scan) are unexposed at the
  policy boundary — nothing to allowlist.

Run `/fewer-permission-prompts` to apply.

### 6. Apply

After the two `add_mcp_server` calls and the CLAUDE.md edit are in place,
request a rebuild so the per-group container picks up the new config:

```
request_rebuild({ reason: "wire CUassistant MCP servers" })
```

(In NanoClaw v2 `add_mcp_server` is a pure config edit — only a container
restart is needed. `request_rebuild` is the unified term; the host decides
whether a rebuild or a plain restart applies.)

### 7. Smoke test

After the container restarts, verify each server with a read tool that has no
side effects:

```
cuassistant-public__list-clemson-terms()
cuassistant-credentialed__list-todo-task-lists()
cuassistant-catalog__list-gc-catalog-years()
```

The public and catalog calls need no credential but do require the respective
host HTTP processes to be running. The credentialed call exercises the HTTP reach
to the host server, this agent's bearer token, and the MS365 token. If the
credentialed call returns an auth error (401), confirm the host server is running
(`npm run mcp:http`), that you minted a token for this agent
(`npm run mcp:consumers -- --list`), and that `CUASSISTANT_MCP_TOKEN` resolves in
the container to that token. If it returns an empty list, the MS365 token may be
missing or expired in the host `.env`. If the catalog call fails, confirm
`npm run mcp:catalog:http` is running and that `gc_advisor` is present at
`/Users/admin/projects/gc_advisor` (or `GC_ADVISOR_*` overrides are set).

## What this skill does **not** do

- It does not start CUassistant's scheduled scan loop (cron / launchd) and does
  not modify the user's CUassistant `.env`. Those are separate per-host setup.
- It does not provision the vault entry for `CUASSISTANT_MCP_TOKEN`. Mint the
  token with `npm run mcp:pair -- --id <agent-id>` and inject it into the
  container env (the credentialed server fails closed without a registered
  consumer — there is no loopback-open fallback).
- It does not expose the policy-gated tools (delete/RSVP/trigger_scan); those
  require widening `policy/action-policy.yaml` per the procedure in
  `<CUassistant repo>/src/mcp-server.md`.
