# Email Triage — CUagent Pattern Handoff

Implements Tasks 1–4 of the plan at
`nanoclaw_personal/docs/superpowers/plans/2026-06-28-email-triage-cuagent-pattern.md`.
Task 5 (Linda's `email-taskfinder` SKILL.md, in the nanoclaw repo) is out of scope here.

**Committed:** `cb5e7ef` — includes security fixes 2 & 3 below.
**MCP service restarted:** `com.cuassistant.mcp-http` reloaded via launchctl.
**Linda's consumer provisioned:** see "Consumer provisioning" section below.

## What was added

Three new MCP tools in a new module `src/mcp-tools/email-triage.ts`, registered
into the credentialed barrel. They split the scan pipeline so an agent (Linda)
does one-at-a-time LLM classification of bucket-3/4 residuals, while CUassistant
runs buckets 1+2 deterministically.

### Tools

| Tool name | Operation | Backend | Purpose |
|-----------|-----------|---------|---------|
| `get_triage_candidates` | `host.get_triage_candidates` | `host-scan` | Acquires the scan lock, runs B1 (action_templates → tasks) and B2 (skip_senders) deterministically, logs those decisions, returns B3/B4 candidates. |
| `log_triage_decision` | `host.log_triage_decision` | `host-state` | Appends one classifier decision to `decisions.jsonl`. One call per candidate. |
| `complete_scan` | `host.complete_scan` | `host-scan` | Writes `pending_residuals` for failed candidates, advances the watermark, releases the scan lock. |

### Scope

New scope token **`host:triage`** in `SCOPE_OPERATIONS` (permissions.ts), expanding to
the three operations above. Consumers must hold this scope to call the tools.

### Policy actions

Three actions added to `policy/action-policy.yaml` (all `approval: none`,
`local_state_only`):
- `host.get_triage_candidates` (surface `host_scan`, risk `low_medium`)
- `host.log_triage_decision` (surface `host_state`, risk `low`)
- `host.complete_scan` (surface `host_scan`, risk `low_medium`)

Total action count is now 56.

## Input-field contracts — the `account` vs `mail_account` distinction (critical)

Each candidate returned by `get_triage_candidates` carries **two** account fields.
They are NOT interchangeable:

- **`account`** — `"outlook" | "gmail"` (CUassistant's internal `EmailMinimal.account`
  vocabulary). Pass this to **`log_triage_decision`** (`account` field).
- **`mail_account`** — `"ms365" | "g.clemson"` (the vocabulary the existing
  `get-mail-message` tool expects). Pass this to **`get-mail-message`** when
  fetching a body.

`mailAccountFor()` bridges them (`gmail → g.clemson`, `outlook → ms365`). Passing
`account` to `get-mail-message` silently falls through to the ms365/Graph path and
fails to fetch Gmail bodies.

### `get_triage_candidates` input
- `dry_run` (boolean, optional) — skip task creation + watermark advance; pass the
  same value to `complete_scan`.

Returns: `scan_run_id`, `task_list_id`, `deterministic_summary`
(`template_tasks`/`template_skips`/`skip_senders`), `candidates[]` (each with
`email_id`, `account`, `mail_account`, `from`, `subject`, `received_iso`,
`bucket_hint`, `audit_marker`), `errors[]`.

### `log_triage_decision` input
Required: `scan_run_id`, `email_id`, `account` (**outlook/gmail**), `from`,
`subject`, `decision` (`task`/`skip`/`label-only`), `audit_marker`, `reasoning`,
`bucket_hint` (`solicited`/`outreach_check`).
Optional: `sort_folder`, `task_title`, `task_id_created`.
Rejects calls whose `scan_run_id` does not match the active scan.

### `complete_scan` input
Required: `scan_run_id`.
Optional: `advance_watermark` (default true), `failed_candidates[]` (each
`{email_id, account}` where `account` is **outlook/gmail**).
Always releases the lock; watermark advance is suppressed when `dry_run` or
`advance_watermark: false`.

## Security fixes applied before commit

### Fix 2 — `model_used` was hardcoded `"linda/openai"` in `decisions.jsonl`

`logTriageDecisionHandler` had `model_used: "linda/openai"` as a literal string,
giving false assurance in the audit log regardless of which authenticated consumer
actually made the call. Fixed by:

- Extending `auditContext` (ALS in `audit.ts`) to carry `provider?: string`
  alongside `consumerId`.
- Threading `principal.provider` into the `auditContext.run()` call in `buildServer`
  (`server.ts`).
- Adding `currentProvider()` export to `audit.ts`; `logTriageDecisionHandler` now
  calls it instead of the hardcoded string. Falls back to `"unknown"` when called
  outside an ALS context (e.g. unit tests).

### Fix 3 — `log_triage_decision` didn't validate `email_id` against scan candidates

The tool only checked that `scan_run_id` matched the active scan — it accepted any
`email_id`, allowing spurious entries in the append-only `decisions.jsonl`. Fixed
by adding a lookup of `email_id + account` against `activeScan.candidates` before
writing (matching the pattern `complete_scan` already used for `failed_candidates`).

Test updated: the fixture `candidates: []` was populated with the test candidate,
and `model_used` assertion changed from `"linda/openai"` to `"unknown"` (no ALS
context in unit tests).

## Consumer provisioning

Linda's MCP consumer was created on 2026-06-28:

```
ID:       linda
Provider: openai_api
Scope:    host:triage, mail:read, tasks:write
Note:     Linda email-triage agent
```

Token was printed once during `npm run mcp:pair`. Inject it into Linda's container
env as `CUASSISTANT_MCP_TOKEN` via the OneCLI vault. The token hash is stored in
`state/mcp-consumers.json`; revoke with
`npm run mcp:consumers -- --revoke linda` if needed.

Linda's visible tool set with this scope:
- `host:triage` → `get_triage_candidates`, `log_triage_decision`, `complete_scan`
- `mail:read` → `list-mail-messages`, `get-mail-message`, `get-mail-attachment`,
  `list-mail-folders`
- `tasks:write` → `create-todo-task`, `update-todo-task` (+ the read-only task tools)

## Deviations from the plan

1. **Test fixture fix (`routeEmails` test).** The plan's fixture used
   `from: "noreply.example.com"` (no `@`) for the skip-sender case. The real
   `senderMatches()` in `cascade.ts` only does domain matching when the `from`
   string contains an `@` (it splits on `lastIndexOf("@")`). With no `@` the
   email fell through to `candidate` and the assertion `skip-sender` failed —
   a bug in the plan's fixture, not the implementation. Changed the fixture to
   `from: "auto@noreply.example.com"`, which is what a real email always looks
   like. Implementation unchanged.

2. **State test reads last line of `decisions.jsonl`.** The plan parsed the whole
   file with a single `JSON.parse(...trim())`. Changed to parse the last line
   (`split("\n").at(-1)`) so the assertion is robust to additional appended
   audit/decision rows. Equivalent assertion, no behavior change.

3. **Verification of tool registration (Task 4 Step 3).** The plan suggested
   `node --import tsx src/index.ts --mcp-stdio`, but that path starts the full
   stdio server (needs credentials). Instead verified registration by importing
   the barrel and calling `toolsForScope(expandScopes(["host:triage"]))`, which
   returned all three tool names. Same goal (confirm the three tools register),
   no source change.

All other code matches the plan verbatim. Every referenced import was confirmed
against the real source before use: `getTaskWriter` (provider-registry.ts),
`computeDueIsoLocal` (ms365.ts), `TaskWriter.{getDefaultListId,findTaskByMarker,createTask}`
(providers.ts), `startMcpAudit`/`finishMcpAudit` (mcp-tools/audit.ts), the cascade
matchers, loaders, state helpers, and types — all present with matching signatures.

## Test + build results

- `npm test` → **135 tests, 135 pass, 0 fail** (includes the new scope tests,
  the pure `routeEmails` test, and the 4 state-handler tests).
- `npm run build` (`tsc -p tsconfig.json`) → **exit 0, zero TypeScript errors.**

## Files changed

- `policy/action-policy.yaml` (modified) — 3 policy actions
- `src/mcp-tools/permissions.ts` (modified) — 3 operation specs + `host:triage` scope
- `src/mcp-tools/email-triage.ts` (new) — `routeEmails` + three tool handlers
- `src/mcp-tools/index.ts` (modified) — `import "./email-triage.js"`
- `test/mcp-email-triage.test.ts` (new) — scope tests + pure routing test
- `test/mcp-email-triage-state.test.ts` (new) — handler/state tests
- `docs/email-triage-handoff.md` (new) — this file

## Remaining steps

1. **Inject Linda's token** into her container env as `CUASSISTANT_MCP_TOKEN` via
   the OneCLI vault (token was printed once during pairing above — store it now if
   not already done).

2. **Register the MCP server for Linda's agent group** in NanoClaw:
   ```bash
   ncl groups config add-mcp-server --id linda \
     --name cuassistant-credentialed \
     --url http://host.docker.internal:8765/ \
     --headers '{"Authorization":"Bearer ${CUASSISTANT_MCP_TOKEN}"}'
   ```

3. **Install Linda's `email-taskfinder` skill** (Task 5, separate nanoclaw repo) —
   not part of this work.
