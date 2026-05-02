# CUassistant

CUassistant currently has one capability: **email triage**. It scans your inbox
a few times a day, identifies actionable mail, and creates Microsoft 365 To Do
tasks.

The Codex agent is the default classifier and the benchmark for tuning. It
receives bounded email candidates and returns JSON; the host does the actual
mailbox reads, task creation, audit logging, and progress tracking.
Deterministic rules and the optional lean residual classifier are token use and cost controls,
and `MODE=compare` lets you measure shortcuts against the full-agent result.

## How it works

A scheduled host script owns external connections and all side effects. On each
run it loads the registered handlers and runs them in order. Today the only
registered handler is email triage; other capabilities would slot in at this
first handler boundary: one handler, one skill folder, one declared permission
set, and one host-applied side-effect channel.

The safety shape is:

1. **Host selects handlers.** The host loads registered capabilities from
   `src/handlers/` and sets the active handler context before any provider call.
2. **Triage reads mail metadata.** The triage handler lists inbox messages
   through the configured provider integrations.
3. **Mode chooses the triage path.** `MODE=agent` sends every listed message to Codex.
   `MODE=hybrid` runs host-side deterministic sorting first and classifies only
   unresolved residuals. `MODE=compare` runs Codex as the benchmark and records
   what the deterministic sorting path would have done, without creating tasks
   or advancing progress.
4. **Host resolves obvious cases in hybrid mode.** Local rules can skip known
   noise or create a task from a stable sender/subject template. This is just
   YAML/string matching: no model call, no agent.
5. **Classifier handles judgment cases.** For messages selected by the active
   mode, the host fetches and normalizes the body, strips quoted replies and
   footer boilerplate, and asks the selected classifier whether the message
   creates a real obligation. Codex is the default classifier and runs as a
   constrained classifier process: isolated working directory, read-only sandbox,
   ignored local rules/config, JSON schema, and timeout. The optional lean OpenAI
   path is also classifier only: no tools, no MCP server, JSON output.
6. **Host applies side effects.** The classifier never receives Microsoft Graph
   tools or credentials. It returns a decision; the host validates it, writes the
   audit row, checks for an existing task marker, and creates the MS365 To Do
   task only when needed.

The scan is **read + create-task only** — it never moves, archives, or deletes
mail. Filing happens separately when you complete the task in To Do.

## Modes

Pick one in `.env`:

- `MODE=agent` (default) — Codex classifies every listed email. This is the
  source-of-truth behavior.
- `MODE=hybrid` — the host applies deterministic shortcuts first; the selected
  residual classifier handles everything not resolved.
- `MODE=compare` — no task/progress side effects. Codex classifies every listed
  email and `decisions.jsonl` records how the deterministic shortcuts would
  have compared.

The deterministic prefilter is local YAML/string matching only. It does not
call OpenAI, Codex, or any other model.

For `MODE=hybrid`, choose the residual classifier separately:

- `RESIDUAL_CLASSIFIER=codex` (default) — unresolved mail goes through Codex.
- `RESIDUAL_CLASSIFIER=openai` — unresolved mail goes through a lean direct
  OpenAI API call, one email at a time, with no tools and JSON-only output. This
  is the low-token path that avoids Codex agent-context overhead for residuals.

Whenever Codex is used, it is still only a classifier: the host passes email
candidates in, requires schema-shaped JSON back, and applies all side effects
itself. The invocation uses an isolated temporary working directory, read-only
sandbox mode, ignored local rules/config, an output schema, and a timeout.

## Setup

```bash
git clone <this-repo>
cd CUassistant
npm install
cp .env.example .env                # fill in MS365 + classifier credentials
cp config/accounts.example.yaml         config/accounts.yaml
cp config/classification.example.yaml   config/classification.yaml
cp config/taxonomy.example.yaml         config/taxonomy.yaml
cp config/institutions.example.yaml     config/institutions.yaml
cp config/known_contacts.example.yaml   config/known_contacts.yaml
```

### MS365 auth (one-time)

You need an Azure AD app registration with delegated scopes under the existing
GCassistant consent envelope:
`Mail.ReadWrite`, `Tasks.ReadWrite`, `Calendars.ReadWrite`, `Chat.Read`, and
`offline_access`.

That envelope is broader than the current triage code path. Today the runtime
refreshes only for `Mail.ReadWrite + Tasks.ReadWrite`, and the host operation
guard in `src/permissions.ts` permits only:

- list Inbox messages
- fetch a message body
- list To Do lists
- find a To Do task by CUassistant's audit marker
- create a To Do task

There is no host operation for sending mail, permanently deleting mail, moving
mail, creating drafts, writing calendar events, or reading Teams chats in the
shipping triage handler.

Run the device-code login helper to populate `MS365_REFRESH_TOKEN` in `.env`:

```bash
npm run ms365-login
```

It prints a verification URL and a one-time code, polls for sign-in, and writes
the refresh token back into `.env`. The script requests
`https://graph.microsoft.com/.default offline_access` so the resulting refresh
token covers whatever scope envelope the Azure app is already consented to;
runtime calls in `src/ms365.ts` then request only the Mail + To Do scopes the
triage handler currently uses.

### Schedule it

```bash
# Run once, dry-run (no tasks created):
npm run scan:dry

# Real run:
npm run scan
```

Then wire to cron / launchd / systemd:

```cron
# 7:30 AM, noon, and 4:00 PM, weekdays
30 7  * * 1-5  cd /path/to/CUassistant && /usr/local/bin/npm run scan
0  12 * * 1-5  cd /path/to/CUassistant && /usr/local/bin/npm run scan
0  16 * * 1-5  cd /path/to/CUassistant && /usr/local/bin/npm run scan
```

On macOS, `launchd/com.cuassistant.scan.plist` is a ready-to-edit template.
Replace `REPO_PATH`, `NPM_PATH`, and `HOME_PATH` with absolute paths, copy it
to `~/Library/LaunchAgents/`, and `launchctl load` it. See the comment at the
top of the plist for the full sequence.

## Output and notifications

Per scan you get four things:

- **Real MS365 To Do tasks.** When not in dry-run mode, actionable mail
  becomes tasks in your default `Tasks` list — visible in Outlook web, the
  To Do app, and iOS Reminders, with native reminder notifications.
- **`state/decisions.jsonl`.** Append-only audit log: one row per email
  scanned, including which bucket decided it, the reasoning, model used,
  body hash, and any task id created. This is the source of truth for "why
  did this email become a task" or "why didn't it." Real task creation writes a
  durable `task-intent` row before the Graph call and a terminal `task` row
  after creation or marker-based recovery.
- **`state/progress.yaml`.** Last-scanned timestamps so the next run only
  picks up new mail.
- **`state/usage.jsonl`.** Append-only per-LLM-call usage: model, mode,
  input/cached/output tokens, latency, API-equivalent USD cost.
- **Per-run summary.** A short text block (scanned / created / by-bucket
  counts, LLM cost line, task titles) is dispatched through the notifier
  registry. Two notifiers are wired today:
  - `stdout` — captured by cron / launchd's `StandardOutPath`.
  - `file` — appends to `~/Library/Logs/cuassistant.log` (override path
    with `NOTIFY_LOG_FILE`).

## Cost reporting

Every LLM call is logged to `state/usage.jsonl` with model, token counts,
and API-equivalent USD cost (rate cards live in `src/pricing.ts`). The
"API-equivalent" framing means costs are computed from observed tokens at
posted rates regardless of how billing actually happened.

```bash
npm run cost-report                              # all-time, grouped by day
npm run cost-report -- --by mode                 # group by agent/hybrid/compare
npm run cost-report -- --by model
npm run cost-report -- --since 2026-04-01
npm run cost-report -- --simulate-mode agent     # "what if every email had been full agent?"
```

`--simulate-mode <mode>` extrapolates per-email token rates observed in that
mode onto your total scanned-email count, then tells you the projected cost.
Useful for comparing full-agent classification cost against the deterministic
shortcut modes.

## Preclassifier Tuning

`PRECLASSIFY.md` is the human policy for preclassification cost control. It
covers both deterministic shortcuts and the optional lean residual classifier.
It says when it is acceptable to turn repeated agent judgments into
`classification.yaml` rules, and when `RESIDUAL_CLASSIFIER=openai` is the right
tradeoff for `MODE=hybrid`.

This exists for cost control, not to demote the agent. The earlier 50-email
triage test that dropped from about 5M tokens to about 50K tokens used the full
cost-control prototype: deterministic shortcuts for obvious repeated patterns
plus a lean classifier path for the messages that still needed model judgment.
CUassistant keeps that lean classifier as an explicit `MODE=hybrid` option via
`RESIDUAL_CLASSIFIER=openai`; Codex remains the default.

After running `MODE=compare`, ask for reviewable rule suggestions:

```bash
npm run preclassify:suggest
npm run preclassify:suggest -- --days 14 --min-evidence 5
```

The suggestion command reads `PRECLASSIFY.md`, current
`config/classification.yaml`, and recent `pass: "compare"` rows in
`state/decisions.jsonl`. It prints YAML snippets for possible `skip_senders`
and `action_templates` additions, plus warnings for rules that disagreed with
the agent. It does not edit config files.

## How it's organized

Each capability is a self-registering **handler** in `src/handlers/`. Today
there's only one:

- `triage` — runtime consent scopes: `Mail.ReadWrite`, `Tasks.ReadWrite`. Walks the
  cascade, creates tasks, writes `decisions.jsonl`.

The scan implementation is split by review concern: `src/scan.ts` orchestrates,
`src/scan-mail.ts` reads mail and progress, `src/preclassifier.ts` owns
deterministic rules, `src/residual-classifiers.ts` chooses the classifier
backend, and `src/scan-effects.ts` applies audit/task side effects.

Additional capabilities fit beside `triage`, not inside it. A future capability
would add `src/handlers/<name>.ts`, `skills/<name>/SKILL.md`, its declared
permission scope, and its own host-applied effect path.

Each handler declares the Microsoft Graph consent scopes it touches in
`src/handlers/`. The stricter executable operation list lives in
`src/permissions.ts`; every Graph call asserts the active handler is allowed
that host operation before firing. The full list of actions the tool can
perform is one `Object.values()` away.

For the IT-facing review notes on consent, data flow, and non-capabilities, see
[`docs/IT_REVIEW_NOTES.md`](docs/IT_REVIEW_NOTES.md).

That note also covers local LLMs as a future privacy control. They are
not part of the current runtime or consent request.

## Persona and skills

Persona lives in `AGENT.md` at the repo root — the runtime-agnostic identity
and tone, applied to every prompt. Edit it to change how the assistant
sounds.

Skills live in `skills/<name>/SKILL.md`, one folder per capability. Each
SKILL.md has YAML frontmatter (`name`, `description`) and a markdown body.
This is the standard format used by Claude Code, Codex CLI, NanoClaw, and
other agent runtimes — a skill folder lifts cleanly between them.

```
AGENT.md
skills/
  triage/
    SKILL.md          -- the only skill today
```

At runtime, `src/prompts.ts` reads `AGENT.md` + the active handler's
`SKILL.md` and composes them into the system prompt, with runtime-computed
data (taxonomy bullets, candidate lists, etc.) appended after. The local triage
skill borrows the useful urgency/reply-needed heuristics from the bundled
Codex Outlook inbox-triage skill, but keeps CUassistant's stricter batch JSON
contract.

## Adding a capability

1. Create `src/handlers/<name>.ts` that calls `registerHandler(...)`.
2. Add the import in `src/handlers/index.ts`.
3. Declare the new scopes in `src/permissions.ts`.
4. Write `skills/<name>/SKILL.md` with the task-specific instructions.

No orchestration changes. Optional: add `skills/<name>/references/` for
supporting reference docs the skill can cite.

Output goes through a parallel **notifier** registry in `src/notifiers/`.
Today the registered notifiers are stdout and a local log file.

## License

TBD.
