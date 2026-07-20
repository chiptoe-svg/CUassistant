# Telegram Approval Durability + Poll-Loop Resilience — Design

**Date:** 2026-07-20
**Status:** Approved (design); ready for implementation plan.

## Goal

Fix two independent defects in the send-approval gate, both surfaced by a
restart-churn episode in `~/Library/Logs/cuassistant.mcp.err.log`:

1. **Pending approvals are lost on restart.** `ApprovalGate` holds pending sends
   in an in-memory `Map`, so any process restart silently voids every in-flight
   approval request. Telegram's inline buttons remain tappable but point at a
   `request_id` that no longer exists.
2. **A Telegram network outage restarts the entire credentialed MCP server.**
   The poll loop calls `process.exit(1)` after N consecutive errors, expecting
   launchd to clear a wedged fetch layer. During a real outage the restart
   cannot help, so it loops.

Scope is deliberately narrow: persist the gate, and gate the watchdog's restart
on a reachability probe so it fires only when a restart can actually help. No
process split, no new runtime dependency, no queue.

## Background / current state

- `src/approval/gate.ts:36` — `private readonly pending = new Map<string, PendingSend>()`.
  Sole store of approval state. `submitTimes` (rate limiter) is likewise
  in-memory.
- `src/approval/gate.ts` — `ApprovalGate` takes an injected
  `Ports { sender, channel, clock, idGen, audit }`. Clean seam for a new port.
- `src/notifiers/telegram-approval.ts:108-190` — `pollLoop()`. Long-polls
  `getUpdates`, counts consecutive errors, flat 3s backoff, `process.exit(1)` at
  `MAX_CONSECUTIVE_POLL_ERRORS = 10` (added in `d29ba10`).
- The poll loop runs **in-process** with the credentialed MCP server on 8765
  (`src/mcp-server.ts:104`, `startTelegramApproval`) — the only startup side
  effect. So its `process.exit` takes all 47 credentialed tools down with it.
- `better-sqlite3@^12` is already a dependency; `src/clemson-schedule-db.ts` is
  the existing per-domain SQLite module pattern. DB files live under `state/`.

### Evidence from the log

~1,480 error episodes since 2026-06-11, by peak consecutive-error count:

| Peak | Episodes | Outcome |
|------|----------|---------|
| 1 | 1,286 | self-healed |
| 2 | 145 | self-healed |
| 3 | 33 | self-healed |
| 4 | 11 | self-healed |
| 5 | 5 | self-healed |
| 6–9 | 0 | — |
| 10 | 13 | the one outage cluster (lines 540–768) |

The distribution is bimodal with an empty 6–9 band. Transient errors always
recovered well below the threshold; the only thing that ever reached 10 was a
single sustained outage, restarting 13 times at ~40s intervals (10 errors ×
3s backoff + launchd's default 10s throttle) — roughly 9 minutes of churn.

**The watchdog has never once fired on the wedge it was written for.** Every
observed error was `TypeError: fetch failed` — throwing, not hanging. The
"stuck fetch that never self-heals" remains a hypothesis with no instances in
the log.

## Design

### 1. `ApprovalStore` port + SQLite persistence

Add `store: ApprovalStore` to `Ports`. SQLite at `state/approvals.db`, following
`src/clemson-schedule-db.ts`.

`better-sqlite3` is **synchronous**, and that is load-bearing: `getStatus()` and
`reject()` are sync methods today. An async store would change those signatures
and ripple into every caller. A sync store is a drop-in.

The in-memory `Map` remains the working set — **write-through** on
submit/approve/reject/expire, **hydrate** from DB on construction. Reads never
hit SQLite, so hot paths are unchanged.

Schema (`pending_sends`):

| Column | Notes |
|---|---|
| `request_id` | PK |
| `artifact` | JSON — the frozen `SendArtifact` |
| `content_hash` | from `hashArtifact` |
| `proposer` | |
| `status` | `pending` / `sent` / `rejected` / `expired` / `failed` |
| `created_at`, `expires_at` | epoch ms |
| `sent_message_id`, `error`, `feedback` | nullable, per terminal status |

Plus a `submit_times(ts)` table so the hourly rate limit survives restart. A
rate limit that resets on restart is not a rate limit.

**Why persistence is sufficient here:** `submit()` returns immediately with
`{request_id, status: "pending"}` — it does *not* await the decision. The send
is performed later inside `approve()`, and the full `artifact` is stored on the
record. There is no suspended promise to resume across a restart. (Had
`submit()` blocked on the tap, persistence alone would not have been enough.)

**Expiry-while-down:** hydration runs the existing `sweepExpired()`, so records
past `expires_at` load as `expired`. A stale Telegram button tapped after a
restart now resolves correctly — it either performs the send or reports
"⏰ Expired" via the existing `approvalOutcomeLabel`, instead of silently doing
nothing.

### 2. Poll loop — gate the restart, don't remove it

The exit was never the defect. Exiting *during an outage* was — the case where
restarting cannot possibly help. A reachability probe separates the two, so the
watchdog is kept for exactly the failure it was written for:

- **Outage** — probe fails. The network is down, restart is useless. Keep
  backing off; do not exit.
- **Wedge** — probe succeeds while `getUpdates` keeps failing. The network is
  fine and *we* are broken. Exit; launchd restarts and clears stale state.

**The probe must not traverse the wedged layer.** A `fetch`-based probe would
fail whenever the undici pool is wedged, we would misread that as "network
down," and the watchdog would never fire — silently dead in precisely the case
it exists for. So the probe is a raw TCP connect to `api.telegram.org:443` via
`node:net` with a short timeout: a different code path from `fetch`, and
therefore a genuinely independent signal. A DNS-only probe is rejected —
resolver caching can make it succeed during a real outage.

**Firing condition — all three must hold:**

1. N consecutive poll errors (`MAX_CONSECUTIVE_POLL_ERRORS`, unchanged at 10)
2. probe reports the network healthy
3. no watchdog exit in the last hour

**(3) is the safety net, and it does not depend on (2) being correct.** If the
probe logic is wrong in some way not anticipated here, the worst case is one
restart per hour rather than the observed 13 in 9 minutes. The last-exit
timestamp lives in `state/approvals.db`, so the rate limit survives the very
restart it governs.

Independently of the gating:

- Replace the flat 3s retry with **exponential backoff: 3s, doubling, capped at
  60s**, reset to 3s on any successful poll. A 9-minute outage then costs ~11
  log lines instead of ~180.
- Add `AbortSignal.timeout()` to the `getUpdates` fetch, so a genuinely hung
  connection is dropped and retried on a fresh one.

**Why the watchdog is safe to keep now.** Half of what made a restart
destructive was that it silently voided every pending approval. §1 removes that,
so a restart is cheap — leaving only "is this restart useful," which the probe
answers.

**Rejected alternative — undici dispatcher reset.** Initially proposed, then
withdrawn: `undici` is not resolvable in this project (not a direct dep; Node 22
keeps its copy internal). Adding it to call `setGlobalDispatcher` is a new
runtime dependency, and whether a *userland* undici's global dispatcher affects
Node's *built-in* `fetch` is version-dependent and unverified. The probe-gated
exit recovers the same wedge through a mechanism already known to work.

### 3. Make a dead receiver loud

Once the loop stops exiting on every outage, it stays alive and quiet through
one — so a persistently-dead receiver becomes invisible. Track
`lastSuccessfulPoll`; once it is **more than 5 minutes stale**, emit a distinct
`[telegram-approval] RECEIVER DOWN for Nm — approvals cannot be actioned` line,
repeated at most every 5 minutes rather than per-error.

Note the gate already fails loudly on the *submit* path: if Telegram is
unreachable, `channel.post()` throws and `submit()` returns `status: "failed"`
to the caller. The silent gap is only the receive path — submit succeeded, then
the receiver died before the tap. That is what this covers.

### Kept, with new inputs

`MAX_CONSECUTIVE_POLL_ERRORS` (10) and `shouldRestartAfterPollErrors` survive.
The predicate gains two parameters — probe result and time since last exit —
and stays a pure function, so it remains directly testable.
`test/telegram-poll-watchdog.test.ts` is extended rather than rewritten.

## Testing

- **Store** — unit tests against a temp DB: persist → reload → state intact;
  expired-while-down loads as `expired`; rate-limiter timestamps survive.
- **Gate** — existing tests keep working via an in-memory fake `ApprovalStore`;
  add one covering hydrate-then-approve.
- **Poll loop** — backoff schedule, health-escalation threshold, and the
  extended `shouldRestartAfterPollErrors` are pure functions, tested directly.
  Cover the truth table explicitly: errors+healthy+cooled-down → exit;
  errors+unreachable → no exit (the churn case); errors+healthy+recent-exit →
  no exit (the rate limit).
- **Probe** — `node:net` connect is injected as a port so tests can force
  reachable / unreachable / timeout without real sockets.

## Deployment

Per `CLAUDE.md`: this changes the credentialed server on 8765. It is not shipped
until `com.cuassistant.mcp-http` is restarted and `tools/list` verifies. The
`mcp-public-bridge` forwarder does not need restarting.

`state/approvals.db` is created on first start. `.gitignore:8` already ignores
`state/`, so it is covered — no gitignore change needed.

## Out of scope

- **Splitting the poll loop into its own launchd job.** Note the watchdog is
  kept, so a confirmed wedge *does* still restart 8765 — the residual blast
  radius is not zero. It is bounded instead: the exit fires only when the
  network is verifiably healthy, at most once an hour, and §1 makes the restart
  non-destructive to pending approvals. That is a rare, cheap, deliberate
  restart rather than the observed 13-in-9-minutes.

  A split would drive it to zero, but needs mail credentials in a
  Telegram-facing process (since `approve()` sends), or a claim/worker queue to
  avoid that — meaningful machinery, and a wider credential surface, for a
  bounded remaining risk. If it is ever wanted, this store is the substrate it
  needs; nothing here is thrown away.
- Adding `undici`.
- Changing approval semantics, TTL, or the message format.
