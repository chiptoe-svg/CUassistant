# Approved-AI Attestation + Capability-Scoped Tokens — Design

**Date:** 2026-06-11
**Status:** Approved (design); ready for implementation plan.

## Goal

Add two governance controls to the credentialed MCP server, each matched to a
pattern already in the codebase:

1. **Approved-AI attestation** — each consuming agent declares the *provider*
   its model backend runs on; pairing fails closed if that provider isn't on an
   approved list in `policy/action-policy.yaml`, and the server re-checks the
   attestation on every request. (Answers: "is there a check that the agent runs
   on an approved AI?")
2. **Capability-scoped per-agent tokens** — each token can be narrowed to a set
   of surface/action scopes, so a leaked or compromised token only reaches the
   tools that agent actually needs. (Shrinks the blast radius of the
   bearer-in-container exposure.)

Both are server-side controls in CUassistant — the side of the trust boundary
that already does enforcement. CUassistant still cannot *prove* what model an
agent runs (that lives across the boundary); the attestation is a recorded,
re-validated, fail-closed operator declaration — the same epistemic strength the
existing `data_egress.classifiers` list already carries.

## Background / current state

- `src/mcp-tools/consumers.ts` — per-agent registry (`state/mcp-consumers.json`,
  sha256 hash only). `Consumer = { id, token_hash, created_at, last_seen_at?,
  note? }`. `authenticateBearer()` returns the matched **id string** or null.
- `src/mcp-tools/server.ts` — `createHttpHandler` calls `authenticate(header)` to
  get a consumer id, uses it **only** for the 401 decision + logging, then
  **drops it**. A fresh `buildServer()` + transport is built per request
  (stateless). `Authenticator = (authHeader) => string | null`.
- `scripts/mcp-consumers.ts` — `mcp:pair` (mint/rotate), `mcp:consumers
  --list/--revoke/--check`. Pairing an existing id **rotates the token**.
- `src/mcp-tools/permissions.ts` — `MCP_ALLOWED_OPERATIONS` (operation →
  backend/policy/status), `assertMcpOperation(op, {input})`, `isMcpOperationExposed`.
- `src/mcp-tools/audit.ts` — `startMcpAudit`/`finishMcpAudit` append to
  `decisions.jsonl`; rows record operation/tool/args but **no consumer id**.
- `policy/action-policy.yaml` — `data_egress.classifiers` (keyed by `provider`,
  with `authorized: true/false`) governs the email classifier's egress.

## Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope granularity | Surface + read/write split, **with `mail:send` as its own scope** |
| 2 | Default scope when none given | **Full** (today's behavior); narrowing is opt-in |
| 3 | Attestation granularity | **By provider** (not model version — models churn, the DPA covers the provider) |
| 4 | Attestation enforcement | **Pair-time + runtime re-check** (flip `authorized:false` → cut off next call) |
| 5 | Out-of-scope tool visibility | **Hidden** — `ListTools` is filtered per consumer |
| 6 | Migration of existing consumers | **In-place `--attest`** path, no token rotation, no container change |
| 7 | Covered providers | `openai_api` **and** `chatgpt_edu` both `authorized: true` (per Clemson contract); `anthropic` `false` |

## Design

### A. Policy: generalize `data_egress`

Add a sibling list `agent_backends`, same shape and `provider` vocabulary as
`classifiers`:

```yaml
data_egress:
  classifiers:                         # unchanged
    - provider: codex_chatgpt_edu …
  agent_backends:                      # NEW
    - provider: chatgpt_edu
      scope: external
      basis: "ChatGPT Edu institutional agreement (Clemson)"
      authorized: true
    - provider: openai_api
      scope: external
      basis: "OpenAI — covered under Clemson contract"
      authorized: true
    - provider: anthropic
      scope: external
      basis: "no Clemson agreement covering Anthropic"
      authorized: false
    - provider: local
      scope: local
      basis: "on-host inference; content does not leave the machine"
      authorized: true
```

New accessor in `src/policy.ts`: `getApprovedAgentBackend(provider): {...} | null`
and `isAgentBackendAuthorized(provider): boolean` (true iff entry exists **and**
`authorized: true`). Mirrors however `classifiers` are currently read.

> **Reconciliation (resolved):** the existing `classifiers` entry previously had
> `openai_api: authorized: false` from an earlier "no DPA confirmed" stance. Per
> decision 7 (OpenAI is contract-covered), this flag has been flipped to
> `authorized: true` (basis: "OpenAI — covered under Clemson institutional
> contract"). Both the classifier and `agent_backends` lists now agree.

### B. Consumer registry: new fields

`Consumer` gains:
- `provider?: string` — attested backend provider (e.g. `chatgpt_edu`).
- `scopes?: string[]` — scope tokens; **absent ⇒ full access**.

(`--list` shows the basis by reading it live from the policy `agent_backends`
entry for the consumer's provider — no stored copy on the consumer, so it can't
go stale.)

`parseConsumers` stays backward-compatible (old entries simply lack these). Hash-
only storage and `0600` perms unchanged.

### C. Scope vocabulary

Scope tokens and their expansion to `MCP_ALLOWED_OPERATIONS` keys, defined in a
new `SCOPE_OPERATIONS` map (single source of truth, colocated with the operation
list in `permissions.ts`):

| Scope token | Operations |
|---|---|
| `mail:read` | `mail.list_messages`, `mail.get_message`, `mail.list_folders` |
| `mail:write` | `mail.move_message`, `mail.update_message`, `mail.create_draft` |
| `mail:send` | `mail.send_with_approval` |
| `calendar:read` | `calendar.list_events`, `calendar.get_event`, `calendar.get_view` |
| `calendar:write` | `calendar.create_event`, `calendar.update_event` |
| `tasks:read` | `todo.list_lists`, `todo.list_tasks`, `todo.get_task` |
| `tasks:write` | `todo.create_task`, `todo.update_task` |
| `sheets:read` | `sheets.read`, `sheets.info` |
| `sheets:write` | `sheets.create`, `sheets.update`, `sheets.append` |
| `docs:read` | `docs.read` |
| `docs:write` | `docs.create`, `docs.append` |
| `clemson` | `clemson.*` (public, read-only) |
| `host:read` | `host.get_scan_status`, `host.get_pending_actions` |

Notes:
- Only **exposed** operations are reachable regardless of scope (policy-gated
  ops like `*.delete`/`*.share` are never registered). Scope narrows *within*
  the exposed set; it can't widen it.
- `mail:send` is deliberately separate: a token may have mail read/write without
  the ability to submit a send (the highest-risk op, still gated by the
  out-of-band Telegram approval downstream).
- A consumer with no `scopes` resolves to the full exposed-operation set.
- Unknown scope tokens are **rejected at pair time** (fail closed on typos).
- `host:read` is included so a token can be scoped to orchestration reads.

### D. Enforcement plumbing

**`Authenticator` returns a `Principal`, not a string:**

```ts
interface Principal {
  id: string;
  scopes: Set<string>;     // expanded operation keys (full set if unscoped)
  provider?: string;       // attested backend provider
}
type Authenticator = (authHeader: string | undefined) => Principal | null;
```

- `resolveCredentialedAuth` on bearer match: load the Consumer, **runtime
  attestation re-check** — `isAgentBackendAuthorized(consumer.provider)`; if the
  provider is absent or not authorized, return `null` (→ 401, logged
  `model_unauthorized`, never logging the token). Otherwise expand
  `consumer.scopes` (or the full set) and return the `Principal`.
  - **Policy timing caveat:** `policy.ts` loads the policy **once at module
    load** (`const ACTION_POLICY = loadPolicyFile()`), as every policy action
    already does. So flipping a provider to `authorized: false` takes effect on
    **server restart**, not mid-process — consistent with how revoke already
    instructs a restart. The per-request re-check still means **no re-pair of the
    agent is needed**: edit policy + restart, and the agent is cut off without
    touching its token or container.
- `env-token`: its provider comes from a new `MCP_AUTH_TOKEN_PROVIDER` env var,
  validated the same way; unset/unauthorized ⇒ env-token is not added (fail
  closed, consistent with registry consumers). Its scope is full (no per-token
  scoping for the single-token escape hatch).
- `openAuthenticator` (public server) returns a `Principal{ id:"public",
  scopes: <all public clemson ops>, provider: undefined }`; attestation does not
  apply to the public, no-credential, public-data server.
- `createHttpHandler` passes the `Principal` into `buildServer(name, principal)`.
- `buildServer(name, principal)`:
  - **ListTools** returns only tools whose `operation ∈ principal.scopes`
    (out-of-scope tools invisible).
  - **CallTool** rejects a tool whose `operation ∉ principal.scopes` with an
    error result (`tool not in this agent's scope`) before invoking the handler
    — defense-in-depth against a client calling a name it already knows.
- **Audit consumer id:** a request-scoped `AsyncLocalStorage<{consumerId}>` is
  set in `buildServer`'s CallTool handler around the `tool.handler(args)` call;
  `startMcpAudit`/`finishMcpAudit` read it and stamp `mcp_consumer_id` into both
  rows. ALS (not a module global) because the server handles concurrent requests
  — a global would race. Tool files are **not** edited.

### E. CLI changes (`scripts/mcp-consumers.ts`)

- `mcp:pair -- --id X --provider P [--scope a,b,c] [--note ...]`
  - `--provider` **required** for new pairs; validated via
    `isAgentBackendAuthorized` (refuse to mint otherwise, listing approved
    providers).
  - `--scope` optional; tokens validated against the vocabulary (refuse on
    unknown token, listing valid tokens). Absent ⇒ full.
  - Existing behavior (token rotation on existing id) unchanged, but now also
    sets provider/scope.
- **NEW** `mcp:consumers -- --attest <id> --provider P [--scope a,b,c]`
  - In-place update of an existing consumer's `provider`/`scopes`. **Does not
    touch `token_hash` or `last_seen_at`.** No new token, no container change.
    This is the migration path.
- `--list` shows `provider` and `scopes` (or `full`), and flags **unattested**
  consumers (no provider) as needing `--attest`.
- `--check` additionally lists unattested consumers as action items.

### F. Migration (one-time, zero agent downtime)

- `nanoclaw-personal`: `npm run mcp:consumers -- --attest nanoclaw-personal
  --provider chatgpt_edu` (its real backend). No token rotation; the running
  container is untouched; the next request re-validates and passes. Optionally
  add `--scope` to narrow.
- `env-token` (if used): set `MCP_AUTH_TOKEN_PROVIDER` in `.env` to an approved
  provider; otherwise env-token stops being accepted (fail closed).
- Until a consumer is attested, runtime re-check rejects it — this is the
  intended fail-closed behavior of decision 4. The `--attest` path makes the fix
  a one-line host edit.

## Error handling

- **Pair time:** unknown/unauthorized provider → exit 1, message lists approved
  providers. Unknown scope token → exit 1, message lists valid tokens.
- **Runtime attestation fail:** authenticator returns null → 401, stderr logs a
  distinct reason (`model_unauthorized`) with the consumer id but never the token.
- **Runtime scope fail:** out-of-scope tool is absent from ListTools; a direct
  CallTool returns an MCP error result (not a crash).
- **Backward-compat parse:** consumers/scopes fields absent → treated as
  unattested / full-scope respectively (then attestation re-check governs).

## Testing

Unit (`node:test` + `node:assert/strict`, run via `npm test` =
`node --import tsx --test test/**/*.test.ts`; test files live in `test/` and
import source with the `.ts` extension, matching `test/mcp-consumers.test.ts`):
- `consumers.ts`: parse entries with/without provider+scopes; scope expansion
  (tokens → op set), default-full, unknown-token rejection.
- attestation: `isAgentBackendAuthorized` against a policy fixture (authorized,
  unauthorized, absent provider).
- `resolveCredentialedAuth`: returns Principal on authorized provider; returns
  null on unattested / unauthorized provider; env-token provider via env var.
- `mcp-consumers` CLI: `--provider` required + validated on pair; `--scope`
  validated; `--attest` updates in place without changing `token_hash`.
- `buildServer`: ListTools filtered by principal scope; out-of-scope CallTool
  returns error.
- audit: `mcp_consumer_id` stamped into intent + terminal rows (ALS).

## Out of scope (explicitly)

- On-wire bearer injection / host-side broker (a NanoClaw-side build; documented
  as a recommendation in the IT review, not built here).
- Short-lived/expiring tokens, OIDC (separate, assessed elsewhere).
- Network egress lock-down in the container (NanoClaw-side; the true enforcement
  layer for "approved AI", complementary to this attestation).
- Changing the existing `classifiers` `openai_api` flag (flagged for separate
  confirmation in §A).

## File-touch summary

- `policy/action-policy.yaml` — add `data_egress.agent_backends`.
- `src/policy.ts` — `getApprovedAgentBackend` / `isAgentBackendAuthorized`.
- `src/mcp-tools/consumers.ts` — `Consumer` fields; scope expansion helper;
  Principal type; attestation in the auth path.
- `src/mcp-tools/permissions.ts` — `SCOPE_OPERATIONS` map + expander.
- `src/mcp-tools/server.ts` — `Authenticator → Principal`; thread principal into
  `buildServer`; ListTools filter; CallTool scope check; ALS for audit id.
- `src/mcp-tools/audit.ts` — read ALS, stamp `mcp_consumer_id`.
- `scripts/mcp-consumers.ts` — `--provider`/`--scope` on pair; new `--attest`;
  enriched `--list`/`--check`.
- `skills/add-cuassistant/SKILL.md` + `src/mcp-server.md` — document
  `--provider`/`--scope`/`--attest` and the scope vocabulary.
