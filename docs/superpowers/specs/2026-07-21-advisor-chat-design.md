# Advisor Chat — Design

**Date:** 2026-07-21
**Status:** Implemented 2026-07-21.

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
- `@earendil-works/pi-agent-core` + `pi-ai` (public on npm, 0.81.x; nanoclaw runs
  0.75.4) — the agent loop, with abort/cancellation through the pipeline
  including mid-tool-call, and `compact()` for long conversations. These are the
  things a hand-rolled loop gets subtly wrong, and the stop control this design
  requires is exactly that case. `pi-coding-agent` is NOT used: its file/bash
  tools are a liability in a web app.
- `pi-mcp-bridge.ts` (187 lines, already written for nanoclaw) — a pure function
  of `mcpServers config -> { tools, close() }`. It imports only the MCP SDK, Pi
  types, and two small local modules; no containers, no SQLite, no channel
  adapters. `StreamableHTTPClientTransport` for `url` servers, and
  `resolveHeaders(config.headers, env)` already supplies auth headers — so the
  authenticated curriculum wiki is a config entry, not new code.
- `~/projects/gc_alumni/ask_gc/app.py` (180 lines) — a working precedent for this
  exact shape: a constrained agent over tools, `temperature=0`, a tool-round cap,
  and `for prov in ("campus", "openai")` — on-prem first, paid fallback.
- Local inference is proven, not assumed. Tested 2026-07-21, all three providers
  in `gc_alumni/db/classify.py` returned correctly parsed OpenAI-format tool
  calls: `campus` (gptoss-120b), `spark` (qwen3.6-35b-a3b), `local`
  (gemma-4-26B-A4B MLX). The design-doc risk that a local endpoint "silently
  half-works" by emitting tool calls as raw text does not apply here.
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

**Model configurable, defaulting to local, with fallback.** Following `ask_gc`:
try the on-prem provider first and fall back to OpenAI, both permitted for
Clemson data under existing policy. Tool calling is already verified working on
campus, spark, and local MLX, so the open question is answer *quality* on
multi-step advising, not mechanics.

**Pi as the agent runner, not a hand-rolled loop.** A direct loop was considered
and rejected. It handles the happy path in ~90 lines, but this service needs a
working stop control (§7) and needs to survive conversations that outgrow the
context window — cancellation mid-tool-call and compaction are precisely what a
hand-rolled loop gets wrong. Pi supplies both, is TypeScript, and the MCP bridge
it needs is already written and owned.

The Codex SDK was also considered and rejected for this service. It is
MCP-native, but it has no `--ignore-user-config` equivalent, so suppressing the
developer's own `~/.codex/config.toml` requires an isolated `CODEX_HOME` — and
without one the agent silently inherits whatever MCP servers are configured
there. Verified on this machine: that is `codegraph` and `node_repl`, a
code-execution tool. With Pi the tool array is passed explicitly, so no such
surface exists.

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
| `src/advisor-agent.ts` | Pi harness: session lifecycle, provider chain, egress gate |
| `src/advisor-artifacts.ts` | Host-side rendering of schema-validated agent output |
| `src/advisor-mcp.ts` | The ported MCP bridge: `mcpServers -> { tools, close() }` |
| `src/advisor-ui.ts` | The HTML/CSS/JS payload, kept out of the server module |

Following `token-portal.ts`: `node:http`, no framework. Two new runtime
dependencies (`pi-agent-core`, `pi-ai`) in a repo that currently has three; the
MCP SDK the bridge needs is already present, since this repo serves MCP.

### Request flow

```
POST /chat
  → authenticate(req) -> { advisorId } | null      (shared password today)
  → resolve session by opaque cookie, or create
  → advisor-agent: run turn on the session's Pi harness
        tools: bridge.tools only (8766, 8767, curriculum wiki)
        provider: on-prem first, OpenAI fallback
        abort: wired to the UI stop control
  → buffer the answer; stream only status events
  → release the complete answer + "response ready"
```

## Agent loop and the tool boundary

`PiAgentHarness` from `pi-agent-core`, constructed per session:

- **`tools` is exactly `bridge.tools`.** Nothing else. nanoclaw's harness also
  passes `createFetchTool()`, `createWebSearchTool()`, and
  `createCodingTools()`; all three are omitted here. "Answers come from the MCP
  tools or not at all" is therefore structural — the agent has no other
  capability to reach for, rather than a flag telling it not to.

  Web search in particular is excluded deliberately: Clemson course and
  requirement pages are public, frequently outdated, and not versioned by
  catalog year. An answer sourced from a stale page is indistinguishable in tone
  from one sourced from the catalog server, and the advisor cannot tell them
  apart. The snapshot in `state/clemson/` is the authority.

- **`systemPrompt`** is `advisor/AGENTS.md`, composed at startup.
- **`temperature`/round cap** follow `ask_gc`: deterministic answering, and a
  bounded number of tool-call rounds so an unattended service cannot loop.
- **Provider chain** tries the on-prem endpoint first, then OpenAI.
- **Abort** is wired to the UI's stop control — the reason a runner is used at
  all.
- `isEgressAuthorized()` gates every call and fails closed, per existing
  convention.

### MCP servers

Three, all over `StreamableHTTPClientTransport`, declared in one place:

| Server | URL | Auth |
|---|---|---|
| `cu_public` | `127.0.0.1:8766` | none (loopback) |
| `cu_catalog` | `127.0.0.1:8767` | none (loopback) |
| `gc_curriculum_wiki` | `127.0.0.1:3000/api/mcp` | bearer, via `resolveHeaders` |

**`8765` is never wired in.** It carries `send-outlook-mail`, `send-gmail`, and
calendar writes. Because Pi receives an explicit tool array, this is enforced by
construction: a server that is not in the config contributes no tools. There is
no inheritance path to close.

All three are HTTP, so the stdio-concurrency caveat does not apply and one
client per server can be shared across request handlers. Per the harness notes,
the bridge is built **once at service startup**, not per request: connecting and
enumerating on every turn would pay `listTools()` latency each time and churn
connections against the MCP servers.

### Skills

Skills stay out of the system prompt. `list-skills` and `get-skill-docs` are
already served on the public server (8766), so the agent retrieves a skill when
it decides one is relevant.

This matters for the context budget: the three relevant skills
(`clemson-schedule-advising`, `gc-curriculum-lookup`, `gc-advisor`) total ~6,500
tokens. Inlining them would spend roughly a tenth of a 64k window on every turn,
before the conversation starts — the same budget that the 2026-07-21 payload
work was undertaken to reclaim.

## Sessions

An in-memory `Map` keyed by an opaque `httpOnly; Secure; SameSite=Strict`
cookie. Each entry holds the Pi session, message history, temp directory path,
`advisorId`, and a last-touched timestamp.

**Pi writes transcripts to disk, so the session root is per session.** nanoclaw
pairs `PiAgentHarness` with `JsonlSessionRepo({ sessionsRoot: ... })`, which
persists the conversation as JSONL. Left at a shared path, content this design
promises to hold only in memory — possibly including student information —
would land on disk behind our back. So each session's root is a temp directory
created with its working directory and removed by the same `rm -rf`. This is
what makes "nothing persists server-side" true rather than aspirational, and it
is the same hazard the Codex option had via `CODEX_HOME`: a runner that
remembers is a runner that writes somewhere.

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

The agent has no file-writing capability at all — it holds only
`bridge.tools`, and none of those write. So an artifact cannot come from the
agent directly regardless of sandboxing; the host must render it.

**Structured output arrives as a tool call, not a response format.** Rather than
depend on a runner-specific structured-output feature, the host supplies one
extra tool, `propose_schedule`, whose parameters *are* the schedule: term, and a
list of sections with CRN, meeting times, room, credits. When the advisor asks
for a document, the agent calls it; the host validates the arguments against the
schema, rejects malformed output, and renders.

This reuses the tool-calling path already verified working on all three local
providers, so it needs nothing that a given model or runner might not support.
It also keeps the boundary honest: `propose_schedule` is the *only* tool the
host adds beyond the MCP servers, and it still writes nothing — it returns
structured data to the host.

**Prose is the default; structure is the exception.** Ordinary conversation is
just conversation — clarifying what the student needs, explaining why a section
does not fit, weighing tradeoffs. That is what a chat interface is for, and
constraining every response would cost it. A document is produced only when the
agent calls `propose_schedule`, which means documents are never produced by
surprise, and the arguments can be re-verified against `check-schedule-conflicts`
before rendering — something a turn of prose cannot be.

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
  removes the entry, the working directory, and the Pi session root (including
  any JSONL transcript written there); TTL sweep expires idle sessions and
  leaves active ones.
- **Tool boundary** — the MCP config declares exactly the three intended
  servers; a test asserts `8765` is absent, and that the tool array handed to Pi
  contains nothing beyond `bridge.tools` (no fetch, no web search, no coding
  tools). The bridge injects `createTransport`, so this is testable without real
  sockets.
- **Egress gate** — an unauthorized provider is refused, failing closed.
- **Turn modes** — a conversational turn returns prose; a `propose_schedule`
  tool call returns validated structure. A test asserts `propose_schedule` is
  the only host-supplied tool alongside `bridge.tools`.
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
