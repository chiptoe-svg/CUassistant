# Session handoff — 2026-07-23 (advisor model screen + deterministic tools)

State after a long session. What SHIPPED to `main` is live; everything under
"parked" is designed/measured but not finished. See
`memory/advising-model-screen-findings.md` for the durable benchmark results.

## Shipped to main (live)
- **Tool-surface cheap wins** — "when-not-to-use" descriptions + mandatory
  `subject`/`courseNumber` scope on `search-clemson-classes`. Deployed to 8766/8767.
- **Constraint-aware `find-eligible-sections`** (`src/mcp-tools/clemson-advising.ts`,
  live on 8767) — the deterministic S5 join. New params: `no_meeting_before`,
  `exclude_days`, `avoid_conflict_with`, `open_only`, `catalog_year`. Guidance is in
  the tool DESCRIPTION (correct place — do NOT inject it into the advisor prompt;
  that was measured to backfire, commit `c8b853f` reverted it).

## The decision the screen produced (NOT yet actioned)
- **Point the advisor at RCD fp8, not Spark.** Set `ADVISOR_BASE_URL` /
  `ADVISOR_MODEL` to `llm.rcd.clemson.edu/v1` + `qwen3.6-35b-a3b-fp8`. Do this once
  the operator's Spark MTP+prefix-cache fix is confirmed (a clean benchmark S3/S4/S5
  run on Spark → malformed ~0), or as the reliable default now.

## Parked threads (designed/measured, not finished)
1. **Benchmark branch `feat/advising-model-benchmark`** — the full instrument
   (scenarios+anchor, runner, judge, report) + the selector prototype (`cdcd193`) +
   the baseline/frontier results. NOT merged to main. Needs a final whole-branch
   review + merge. Deferred minors: Task 1's 3 (anchorS1 asserts shape not live
   values; classifySuggestionLive untested; duplicated conflict cases); Task 2's
   steadiness-gate-wiring regression test; Tasks 3 & 4 were self-reviewed.
2. **Spark fix confirmation** — operator found MTP + prefix caching corrupt
   multi-tool-call turns; run the Spark S3/S4/S5 confirmation once their testing
   settles. (Report for the RCD team: `scratchpad/…` was drafted; the ask is a
   `--tool-call-parser`/vLLM-version diff vs the working RCD fp8 deployment.)
3. **Host-side selector** (`scripts/advising-benchmark/selector.ts`, on the
   benchmark branch) — built, measure-first, NOT deployed. Groups scheduling/
   curriculum/wiki/meta; measure WITH vs WITHOUT scoping (malformed + latency +
   correctness) before wiring into `createAdvisorMcpBridge`.
4. **gc_advisor `audit.py` fixes** (separate repo) — filter DegreeWorks tally rows
   ("… Credits applied: N Classes applied: M", "In-progress and Preregistered",
   "Insufficient", bare "REQUIREMENT") out of `appliesTo`; route excess courses into
   the existing `excessElectives` field; fix the requirement-label offset in
   `requirementsRemaining`; add an optional `grade` field (LOCAL/Private path only —
   grades are FERPA-sensitive, never in the de-identified ledger). Canonical input
   shape converged on `gc-course-ledger-v1` (clean completed-work ledger; derive
   "what's left" from gc_advisor, not from the DegreeWorks scrape). The
   `find-eligible-sections` guidance was added to gc_advisor's `gc-advisor/SKILL.md`
   (dormant — the advisor no longer injects the skill; guidance is in the tool
   description instead).
5. **PDF "Degree Works Cleaner"** (user-provided HTML, client-side pdf.js) — a
   whitelist-extract de-identifier: raw PDF parsed in-browser, only the sanitized
   ledger egresses → enables the de-identified frontier path for audits. To
   integrate into the advisor page: **vendor pdf.js locally** (it's in the raw-PII
   path — no external CDN), keep the human review-before-send step, wire ledger→agent.
6. **Latency levers** (`docs/superpowers/specs/2026-07-23-tool-surface-architecture-notes.md`)
   — prefix caching (biggest, BUT parked: it interacts badly with MTP on Spark),
   the selector, generation caps (max_tokens + thinking on/off), benchmark
   concurrency. Not built.
7. **More deterministic tools** (measure-before-build): plan-next-semester join
   (audit unmet × eligible × offered × constraints), co-requisite section pairing
   (lab pairs w/ seats + no conflict), conflict-resolution/section-swap search (the
   S4 counterfactual), proposed-schedule validator. Add a scenario, measure the
   failure, then build.
8. **Privacy toggle** (Private local vs OpenAI de-identified) — the fp8 result makes
   the Private path viable/reliable; OpenAI/frontier mode is for de-identified hard
   cases. Toggle + PII de-identification (the PDF cleaner is its input side). Still a
   design/build item; clear session on Private→OpenAI switch only (asymmetry decided).

## The overriding lesson (measured, repeatedly)
Measure at n≥20 before believing or shipping. This session: the "solved" Spark issue
wasn't (under-tested on easy tasks); frontier can't do a combinatorial join by
reasoning; and adding prompt guidance to force tool use REDUCES tool use. The tool
is the lever, not the prompt.
