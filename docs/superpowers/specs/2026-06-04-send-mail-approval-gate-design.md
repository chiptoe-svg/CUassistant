# Send-Mail Approval Gate — Design

- **Date:** 2026-06-04
- **Status:** Approved (design); pending implementation plan
- **Component:** CUassistant host MCP server (`src/mcp-tools/*`, `src/ms365.ts`, notifiers)

## Motivation

CUassistant deliberately shipped with **no send-mail capability** ("drafts only; the
user sends from Outlook"). We now want CUassistant to be able to send mail on the
user's behalf — but only behind a **human approval gate** that is secure even when
the requesting agent is untrusted (prompt-injected, buggy, or eventually running in
a container).

The security goal is enforced structurally: the agent can *request* a send but has
no send capability of its own. The only path to "mail leaves" runs through a
deterministic host-side gate that freezes the proposed email, shows it to the user
over Telegram, and executes the send **only** on the user's explicit tap.

## Goals

- Agents can request that an email be sent; nothing sends without an explicit human approval.
- The approval is out-of-band (Telegram) and the gate is robust to unbounded human latency.
- "What the user approves is byte-for-byte what gets sent."
- Fail-closed: any error, timeout, restart, or ambiguity results in **no send**.
- Designed so the proposer can later be the autonomous scan loop, not just an interactive agent, with no redesign.

## Non-goals (v1)

- A general agent↔user Telegram communication channel ("agents talk to me"). Deferred to a follow-on project; this spec's Telegram plumbing is built to be reusable by it.
- Autonomous proposer (scan loop auto-proposing replies). Architecture supports it; not wired in v1.
- Calendar invites / non-mail sends.
- Per-caller authentication on the MCP broker (finding #2). Adjacent broker-hardening, tracked separately; not required for this gate's core guarantee.
- Persistence of pending approvals across host restart (in-memory + fail-closed for v1).

## Key decisions

| Decision | Choice |
|---|---|
| Proposer | Interactive agent (B) in v1; autonomous scan (A) later. Gate is **proposer-agnostic**. |
| Approval interaction | Approve / reject; reject loops feedback back to the agent, which revises and submits a fresh frozen proposal (C). Gate never edits. |
| Approval ceremony | Simple tap (A). The security boundary is the agent's lack of Telegram access, not ceremony weight. |
| MCP integration | **Async ticket** (Approach 2): submit returns `{request_id, pending}`; agent polls `get_send_status`. Survives long latency and the HTTP/container transport. |
| Restart behavior | In-memory store, **fail-closed** — restart cancels all pending; agent re-requests. |
| External recipients | Flagged (⚠️) in the approval message for any non-`clemson.edu` address. |
| Telegram bot | Dedicated-vs-shared channel **deferred**; lives entirely behind `notifiers/telegram.ts`. |

## Architecture

A deterministic host-side approval gate sits between the broker and the Graph send.
The agent's entire surface is two tools; it never holds a token, a send capability,
or a Telegram path.

```
Agent ──request_send_mail()──▶  MCP broker  ──▶  Approval Gate (host, deterministic)
  │                                                  │  freeze artifact, store as pending
  │                                                  ├──▶ Telegram notifier ──▶ user (✅/❌)
  ◀── {request_id, pending} ─────────────────────────┘
  │
  └──get_send_status(id)──▶ broker ──▶ gate ──▶ {pending | sent | rejected+feedback | expired | failed}

User tap ──▶ Telegram receiver ──▶ gate: match id + user ─▶ ✅ ms365.sendMail()  /  ❌ discard+capture note
```

### Components

| Module | Responsibility | New/changed |
|---|---|---|
| `src/mcp-tools/mail-send.ts` | MCP tools `request_send_mail` (freeze → return `request_id`) and `get_send_status(id)`. No token, no Telegram. | new |
| `src/approval-gate.ts` | Pending-request store + state machine; matches taps → request; executes send on ✅, discards on ❌/timeout. Deterministic, no model. Depends on injected ports. | new |
| `src/notifiers/telegram.ts` | Posts the approval message; receiver loop (Bot API long-poll/webhook) for the tap/reply. Fits existing notifier registry. | new |
| `src/ms365.ts` | Add `sendMail()` → `POST /me/sendMail` (needs `Mail.Send`). | +1 helper |
| `src/mcp-tools/permissions.ts` | Register operation `mail.send_with_approval`. | +entry |
| `policy/action-policy.yaml` | `mail.send_with_approval: approval: human_required` (the gate is that mechanism; ties off finding #14). | +entry |

### Design-for-isolation

`approval-gate.ts` depends on four **injected ports** so the state machine is testable
in isolation and free of transport assumptions:

- **notifier** — post approval message + deliver taps
- **sender** — `ms365.sendMail`
- **clock** — now / TTL evaluation
- **id generator** — high-entropy `request_id`

## Data model

```
PendingSend {
  request_id        // high-entropy random token; opaque to the agent; used as the Telegram callback token
  to, cc?, subject, body, contentType   // FROZEN artifact — exactly what will send
  content_hash      // hash of the frozen artifact (logged; makes approved==sent auditable)
  proposer          // "agent:<id>" | "scan"  — audit + B→A future
  status            // pending | sent | rejected | expired | failed
  feedback?         // revision note captured on reject
  created_at, expires_at
  sent_message_id?  // Graph message id on success
  error?            // on send failure
}
```

## Lifecycle / state machine

Terminal states are final → all transitions are idempotent.

```
pending ──✅ tap──▶ sent      (ms365.sendMail succeeded)
        ──✅ tap──▶ failed    (Graph errored after approval; surfaced, never silently dropped)
        ──❌ tap──▶ rejected  (+ optional feedback)
        ──timeout─▶ expired   (no reply within TTL → discard)
```

A later or duplicate tap on a terminal request is a no-op.

### Critical mechanisms

- **Tap → request matching (forgery-resistant).** `request_id` is the callback token on
  the Telegram ✅/❌ buttons. A tap is honored only if (1) the token matches a `pending`
  request **and** (2) the sender is the authorized user id. The agent never sees the token
  and has no Telegram access.
- **Integrity ("approved == sent").** The full email is frozen at submit; on ✅ the gate
  sends *that stored artifact*, never re-reading from the agent. The agent holds only the
  opaque `request_id`, so there is no TOCTOU window. `content_hash` is logged.
- **Reject → revise loop (C).** ❌ sets `rejected`; an optional follow-up text is captured as
  `feedback`. `get_send_status` returns `{rejected, feedback}`; the agent composes a revised
  email and calls `request_send_mail` again → new `request_id`, new frozen artifact, new
  approval. The old request stays `rejected`.

## Failure modes (fail-closed)

Governing principle: every error or ambiguity resolves to **no send**. The only path to
"mail leaves" is a live, matched ✅ from the authorized user id.

| Situation | Behavior |
|---|---|
| No reply within TTL (default 1 hr, configurable) | → `expired`, no send |
| Telegram message fails to post | Fail fast → `failed` ("couldn't reach approver"), surfaced to agent; never silently pending |
| ✅ but `ms365.sendMail` errors | → `failed`, error captured, surfaced via `get_send_status`. No auto-retry (avoids double-send) |
| Double-tap / stale tap / replay | No-op; terminal states final |
| Host restart with pending requests | All pending cancelled (in-memory); agent re-requests |
| Tap from an unrecognized user id | Ignored |
| Tap with forged/non-matching token | Ignored |

## Security invariants

1. Agent surface = `request_send_mail` + `get_send_status`. No token, no send capability, no Telegram path.
2. Only the host holds the Telegram bot token.
3. A tap is honored only if its token matches a `pending` request **and** the sender is the authorized user id.
4. Frozen artifact + `content_hash` → approved == sent; no post-approval swap.
5. Fail-closed on timeout, send-error, restart, notification-failure.
6. Deterministic gate — no model in the decision path.
7. Every request, transition, decision, and `sent_message_id` is logged to the existing audit trail.

## Anti-abuse

The dominant risk is the human: notification fatigue → rubber-stamping.

- **Rate-limit** `request_send_mail` per caller (default ~10/hour, tunable; ties to finding #11).
- **Cap outstanding pending** (default ~5); further requests refused until cleared.
- **Approval message always shows full content** — no blind "approve #4 of 12."

## Approval message content

Shows **To / Cc**, **Subject**, and **Body** (truncated to Telegram's ~4096-char limit with
a `(truncated, N chars total)` marker — the full frozen artifact still sends). Recipient shown
prominently. Any recipient outside the configured internal-domain allowlist (default
`clemson.edu`) is flagged with ⚠️.

## Dependencies

- **`Mail.Send`** delegated scope on the GCassistant app — a 6th permission (small IT ask).
  Reverses "no send by design" → "send, but only behind the gate."
- **Telegram bot** — dedicated-vs-shared decision deferred; isolated behind `notifiers/telegram.ts`.
  Its token is a host-side secret under the same handling as other secrets (0600, excluded from
  transfer bundle).
- **Per-caller auth (#2)** — recommended alongside for the HTTP/container transport (controls *who
  can submit*), but not required for the gate's core guarantee. Tracked separately.

## Testing

Enabled by the injected ports. Style matches the existing suite (`node:test` +
`node:assert/strict`).

**Doubles:** fake notifier/receiver (captures messages, asserts external ⚠️ flag, simulates a
tap `{token, user_id}`); fake sender (records calls, succeed/throw); controllable clock.

**State-machine matrix (one test per transition):**

| Test | Asserts |
|---|---|
| Valid ✅ from authorized user | sender called once with frozen artifact → `sent` |
| ✅ but sender throws | → `failed`, no retry |
| ❌ with note | → `rejected`, feedback captured, sender never called |
| TTL elapses | → `expired`, sender never called |
| Double-tap / stale tap | no-op; sender called at most once |
| Tap, wrong/unknown user id | ignored; sender never called |
| Forged/non-matching token | ignored; sender never called |
| New gate instance (restart) | prior pending gone → fail-closed |

**Cross-cutting assertions:**

- Fail-closed: in every non-`sent` path, sender port never invoked.
- Integrity: sent payload deep-equals frozen artifact; `content_hash` matches.
- Anti-abuse: request beyond rate limit / outstanding-cap refused; no pending created.
- External flag: approval message marks non-`clemson.edu` recipients.
- Broker surface: `request_send_mail` returns `{request_id, pending}` and does not call sender;
  `get_send_status` reflects state; operation is policy-gated (`assertMcpOperation`).
