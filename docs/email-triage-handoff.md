# Email Triage — CUagent Pattern Handoff

Implements Tasks 1–4 of the plan at
`nanoclaw_personal/docs/superpowers/plans/2026-06-28-email-triage-cuagent-pattern.md`.
Task 5 (Linda's `email-taskfinder` SKILL.md, in the nanoclaw repo) is out of scope here.

**Nothing has been committed.** All changes are in the working tree for human review.

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

## Remaining manual steps (for the human)

1. **Import wiring** — already done (`src/mcp-tools/index.ts` imports
   `./email-triage.js`). No further wiring needed.

2. **Restart the CUassistant service** so the running MCP server picks up the new
   tools. Was intentionally NOT done here. Build first, then restart however the
   service is managed (launchd / pm2 / node), e.g.:
   ```bash
   cd /Users/admin/projects/CUassistant && npm run build && \
     launchctl kickstart -k "gui/$(id -u)/<cuassistant-launchd-label>"
   ```

3. **Grant Linda's MCP consumer the `host:triage` scope.** The three tools are
   only visible to a consumer whose scope set includes `host:triage`. Either pair
   a fresh token with the scope, or attest an existing consumer to add it:
   ```bash
   # New token (printed ONCE — copy into Linda's container env):
   npm run mcp:pair -- --id <linda-agent-id> --provider <provider> \
     --scope host:triage[,host:read,mail:read,tasks:write,...]

   # Or add the scope to an existing consumer in place (token unchanged):
   npm run mcp:consumers -- --attest <linda-agent-id> --provider <provider> \
     --scope host:triage[,...existing scopes...]
   ```
   Note: `--scope` REPLACES the consumer's scope set, so include all scopes Linda
   needs (she also needs `mail:read` for `get-mail-message` and `tasks:write` for
   `create-todo-task`). `--provider` must be an authorized backend in
   `policy/action-policy.yaml` (`data_egress.agent_backends`). `npm run mcp:consumers -- --list`
   shows current consumers and scopes.

4. **Install Linda's `email-taskfinder` skill** (Task 5, separate nanoclaw repo) —
   not part of this work.

## Nothing was committed

All changes are unstaged/staged in the working tree only. Review and commit yourself.
