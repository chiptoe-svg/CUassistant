# Advisor Chat — Design

**Date:** 2026-07-21
**Status:** Approved (design); ready for implementation plan.

## Goal

A browser chat window where a Clemson GC advisor asks scheduling and catalog
questions in natural language — *"I have a student with GC 4060 and GC 3400 at
these times, find a specialty area class and a GC tech elective that fit"* — and
gets an answer grounded in the MCP tools this repo already serves.

The value is **composition, not lookup**. A form answers "how big is Powers 112."
Only an agent answers a question that needs `get-gc-requirement-rules`, then
`find-eligible-sections`, then `check-schedule-conflicts` against times the
advisor supplied in prose.

Secondary goal, equally deliberate: this is a **pilot for a future
student-facing system**. It exercises the local-inference path, the agent loop,
the MCP wiring, and the accessibility pattern — with zero student records in the
data model. If a local model cannot do this work, that is the cheapest possible
place to find out.

## Background — what already exists

- `src/token-portal.ts` (263 lines) — the precedent for a web surface here:
  `node:http`, hand-rolled routes, inline HTML, no framework. Also runs Google
  OAuth2 and verifies `hd=g.clemson.edu`, which becomes Phase 2's auth.
- `src/codex-agent.ts` (284 lines) — a hardened Codex runner for email triage:
  ephemeral temp cwd destroyed in `finally`, `--sandbox read-only`,
  `--ignore-user-config`, `--output-schema`, SIGTERM timeout, scrubbed child env
  via `buildChildEnv()`, and an `isEgressAuthorized()` gate. Deliberately
  one-shot: *"No MCP server, no tool round-trips."*
- MCP servers: `8765` credentialed, `8766` public (Clemson schedule),
  `8767` catalog (GC curriculum). All loopback-only.
- `@openai/codex-sdk` 0.145.0 — provides the agent loop `codex-agent.ts` lacks.
  It **spawns the CLI** (`spawn`, `child_process`, `codexPathOverride`), so
  `sandboxMode` and `workingDirectory` map to the same flags, and process
  isolation carries over. Exposes `baseUrl`, `apiKey`, `model`, `outputSchema`,
  and arbitrary `--config` overrides; emits `mcp_tool_call` events.
- Ports in use: 8765, 8766, 8767, 8769, 8011, 10255. **8770 is free.**

## Decisions

Each of these was chosen against a named alternative; the rationale matters more
than the choice.

**Runs on this Mac, alongside the MCP servers.** A single advising question is
four or more tool calls but only one inference connection. Putting the network
hop on the chatty side would be backwards, and the `mcp-public-bridge` outage of
2026-07-21 is direct evidence of what non-loopback MCP paths cost. Inference
crosses the network instead, which is exactly what `baseUrl` is for. This also
settles containerisation: a host process reaches `127.0.0.1:8766` with no bridge,
no vmnet, no forwarding.

**Model configurable, defaulting to local.** `baseUrl` is a first-class SDK
option, so supporting both costs nearly nothing. Defaulting to the Spark's vLLM
forces the pilot question immediately rather than letting it be deferred
indefinitely; OpenAI is the fallback when it disappoints. Both are permitted for
Clemson data under existing policy.

**Sessions in memory, with advisor-initiated export.** Nothing persists
server-side. "It never persisted" is a stronger guarantee than "we delete it,"
and the export satisfies the receive-files requirement without the institution
holding anything. Cost: a service restart loses an in-flight conversation and the
advisor retypes. Acceptable because advisor sessions are short and synchronous —
unlike the approval gate in `2026-07-20-telegram-approval-durability-design.md`,
where in-memory state was the defect precisely because approvals were long-lived
and asynchronous.

**Assume student data arrives.** Advisors were not asked to paste student
records, and the UI does not invite it, but every real advising question is about
a specific student and people will type what they are thinking. This is a design
posture, not a feature: no content logging, aggressive session disposal, and a
Clear control treated as a data-hygiene mechanism rather than a convenience.

**Shared password now, per-advisor identity in Phase 2.** Chosen for speed behind
a firewall. The risk is not the password — it is that identity never enters the
data model and has to be threaded through sessions, audit, and export later. So
the seam is built now and left unpopulated (§6).

## Architecture

One service, four modules, each with a single responsibility.

| File | Responsibility |
|---|---|
| `src/advisor-server.ts` | HTTP routes, auth check, static page delivery |
| `src/advisor-session.ts` | In-memory session store: create, touch, clear, TTL sweep |
| `src/advisor-agent.ts` | Codex SDK wrapper: thread lifecycle, MCP config, egress gate |
| `src/advisor-artifacts.ts` | Host-side rendering of schema-validated agent output |
| `src/advisor-ui.ts` | The HTML/CSS/JS payload, kept out of the server module |

Following `token-portal.ts`: `node:http`, no framework. One new runtime
dependency (`@openai/codex-sdk`) in a repo that currently has three.

### Request flow

```
POST /chat
  → authenticate(req) -> { advisorId } | null      (shared password today)
  → resolve session by opaque cookie, or create
  → advisor-agent: run turn on the session's thread
        MCP tools: 8766 + 8767 only
        sandbox: read-only, cwd = session temp dir
        model: baseUrl from env (local vLLM default)
  → buffer the answer; stream only status events
  → release the complete answer + "response ready"
```

## Agent loop and the tool boundary

The SDK runs the loop; the CLI it spawns provides isolation:

- `sandboxMode: "read-only"` — the agent never writes. §5 explains how artifacts
  are produced without loosening this.
- `workingDirectory` — the session's temp directory, holding uploaded files.
  Created on session start, `rm -rf` on clear or expiry.
- `baseUrl` / `model` — from env; local vLLM by default, OpenAI as fallback.
- `webSearchMode: "disabled"` — **answers come from the MCP tools or not at
  all.** Web search is the quiet way "retrieve, don't generate" fails: Clemson
  course and requirement pages exist publicly, are frequently outdated, and are
  not versioned by catalog year. An answer sourced from a stale web page is
  indistinguishable in tone from one sourced from `8767`, and the advisor has no
  way to tell them apart. The snapshot in `state/clemson/` is the authority.
- `approvalPolicy: "never"` — an unattended web service has no one to prompt.
- `isEgressAuthorized()` gates every call and fails closed, per existing
  convention.

**MCP servers are injected explicitly, never inherited — via an isolated
`CODEX_HOME`.** The SDK does not expose the CLI's `--ignore-user-config`, so
suppressing user config is not available as a flag. The mechanism is the SDK's
`env` option: point `CODEX_HOME` at a directory containing a minimal
`config.toml` that declares `8766` and `8767` and nothing else. (`env` also
replaces the child environment wholesale — the SDK "will not inherit variables
from `process.env`" when it is provided.)

**`CODEX_HOME` is per session, not service-global, because it is a write
surface.** Codex persists thread transcripts under `CODEX_HOME/sessions`, and a
single `codex mcp list` was enough to create `memories/` and `tmp/` there.
Session state the design promises to hold only in memory would therefore be
written to disk behind our back — with student information potentially in it.
So each session gets its own `CODEX_HOME`, created alongside its working
directory and removed by the same `rm -rf` on clear or expiry. This is what
makes "nothing persists server-side" true rather than aspirational.

This is not theoretical. Verified on this machine, 2026-07-21:

```
default CODEX_HOME    -> codegraph, node_repl
CODEX_HOME=isolated   -> cu_public only
```

`node_repl` is a code-execution tool. **Without an isolated `CODEX_HOME` the
advisor agent silently inherits it**, along with whatever else a developer
happens to have configured. Nothing in the SDK surface warns about this, and the
tool list would look correct in casual inspection because the extra servers are
never named anywhere in this repo.

**`8765` is never wired in.** It carries `send-outlook-mail`, `send-gmail`, and
calendar writes. An advisor chat has no business holding them. Together with the
`CODEX_HOME` isolation this makes the tool surface a closed set that is stated in
one place, rather than the union of this design and an unrelated config file.
This is the boundary hardest to walk back, so it is explicit rather than default.

## Sessions

An in-memory `Map` keyed by an opaque `httpOnly; Secure; SameSite=Strict`
cookie. Each entry holds the thread handle, message history, temp directory
path, `advisorId`, and a last-touched timestamp.

- **Clear** — drop the entry, remove the temp directory, mint a fresh cookie.
  This is the control an advisor uses when moving to another student, and it is
  the primary data-disposal mechanism.
- **Idle TTL** — 2 hours default, swept periodically.
- **Isolation is per-cookie, never per-password.** Because the shared password
  makes two advisors indistinguishable at the auth layer, session lookup keys off
  the cookie alone. A password-scoped or global session would let one advisor see
  another's conversation. This constraint disappears in Phase 2 but the code
  should not start depending on that.

## Files and artifacts

**Inbound.** Upload writes the file into the session's working directory. The
agent reads it from its own sandbox cwd. No host-side parsing — the file is
simply present.

**Outbound — the host renders, the agent does not.** "No write actions" governs
*systems of record* (registering, mailing, calendar writes), not artifacts. A
proposed-schedule document changes nothing outside the session and is in scope.

But `sandboxMode: read-only` blocks agent-side file creation, and that constraint
is worth keeping. So artifacts follow the pattern `codex-agent.ts` already
established with `--output-schema`: **the agent returns structured JSON; the host
renders it.** For a proposed schedule that means CRNs, meeting times, rooms,
credits, and conflict status — validated against the schema, and re-checkable
against `check-schedule-conflicts` before anything is rendered.

**Prose is the default; schema is the exception.** `outputSchema` lives on
`TurnOptions`, not `ThreadOptions`, so it is chosen per turn on the same thread
with the same history. Ordinary conversation runs with no schema at all and the
agent answers in prose, because this is a chat tool and most turns are
discussion — clarifying what the student needs, explaining why a section does not
fit, thinking out loud about tradeoffs. Constraining every response to JSON would
buy nothing and cost the thing the interface is for.

An artifact is a second, explicit turn: the advisor asks for the schedule as a
document, and *that* turn carries the schema. Two consequences worth having —
documents are never produced by surprise, and the artifact turn can be validated
and re-verified against the tools before rendering, which a turn of prose cannot
be.

Three benefits beyond preserving the sandbox: formatting is deterministic
because a template produces it; output is validatable in a way a
model-authored document is not; and the model decides *what* is in the schedule
while never deciding how the page looks.

**Rendering is HTML with a print stylesheet**, served at `/export/schedule`;
the advisor prints to PDF. Zero new dependencies, and it produces a real
accessible document rather than an image of one — which matters given §7. A
server-side PDF renderer is a later dependency decision; the schema is designed
so swapping it in touches only the rendering step.

Transcript export at `/export` streams Markdown. Everything dies with the
session.

## Authentication

Today: a shared password behind the firewall, exchanged for a session cookie.

The seam that matters is one function:

```
authenticate(req) -> { advisorId } | null
```

One call site. Under shared-password mode it returns `{ advisorId: "shared" }`.
Sessions carry `advisorId` as a first-class field from the start even though
every value is initially identical.

**Phase 2** replaces the body of that function and nothing else. `advisorId`
begins carrying real values; sessions, audit, and export already have somewhere
to put it. Most of the work exists: `src/token-portal.ts` already runs Google
OAuth2 and verifies `hd=g.clemson.edu`, so Phase 2 is pointing the advisor login
at that flow, not building auth.

## Accessibility

Title II applies — a staff tool at a public university. The pattern is buffer
and gate:

- **Status channel** streams short progress ("checking the schedule…") into its
  own small live region, so a 20–40s wait does not read as a broken page.
- **Answer channel** is buffered and released complete, announced as "response
  ready" via the status region. The answer itself carries real headings and
  landmarks so the advisor navigates into it at their own pace rather than
  having it read at them.

Streaming prose token-by-token is rejected: it mutates the DOM dozens of times a
second, which produces either stutter or repeated re-reading in a screen reader.
Buffering is also required anyway to validate structured output before release,
so the accessibility win and the correctness win are the same mechanism.

Checklist: live regions mounted empty and stable before content flows; focus
stays on the input and is never yanked to arriving responses; accessible names,
keyboard operability, and visible focus rings on send, stop, clear, and export;
4.5:1 contrast including any muted "thinking" text; reflow at 400% zoom; network
and error states that announce rather than fail silently.

## Audit and logging

**Metadata only. Never prompt or response content.** Session id, `advisorId`,
timestamp, which tools were called, latency, token counts.

The instinct when debugging an agent is to log the whole exchange. Given that
student information may land in prompts, that would turn a debugging convenience
into a retention question and a disclosure surface. The audit becomes genuinely
useful when `advisorId` carries real values in Phase 2.

## Testing

- **Session store** — two cookies never resolve to each other's session; clear
  removes the entry, the working directory, and the session's `CODEX_HOME`
  (including any transcript Codex wrote under `sessions/`); TTL sweep expires
  idle sessions and leaves active ones.
- **Tool boundary** — the generated `CODEX_HOME/config.toml` declares exactly
  `8766` and `8767`. Tests assert `8765` is absent, and that no server from the
  developer's own `~/.codex/config.toml` (notably `node_repl`) can appear. This
  is the failure nobody would notice by inspection: the inherited servers are
  named nowhere in this repo, so a reviewer reading only this code sees a
  correct tool list.
- **Egress gate** — an unauthorized provider is refused, failing closed.
- **Turn modes** — a conversational turn carries no `outputSchema` and returns
  prose; an artifact turn carries one and returns JSON. Both run on the same
  thread, so history is shared.
- **Artifacts** — schema-invalid agent output is rejected rather than rendered;
  a valid schedule renders deterministically.
- **Auth seam** — `authenticate()` returning null denies; sessions carry
  `advisorId` end to end.

## Deployment

New launchd job `com.cuassistant.advisor` on **8770**, bound to loopback. Per
`CLAUDE.md`, this adds no MCP tools and changes no policy, so the three MCP
daemons do not need restarting — but the advisor service itself must be
restarted to pick up changes, and it holds all sessions in memory, so a restart
ends every in-flight conversation.

## Out of scope

- **Any student-data path.** No DegreeWorks parsing, no audit ingestion, no
  minimization pipeline. The posture is "assume it arrives in chat," not "build
  for it." A student-facing system needs the full architecture in
  `advisingagentdesignnotes.md` and is a separate project.
- **Write actions on systems of record.** No registration, no mail, no calendar.
- **Per-advisor auth** — Phase 2, seam built now.
- **Server-side PDF rendering** — print stylesheet until someone needs a file
  rather than a printout.
- **Peak-load concurrency work.** Advisors are roughly ten people. The
  stateless-shared-model architecture that a student system needs at registration
  is explicitly not validated by this pilot, and should not be assumed from it.
