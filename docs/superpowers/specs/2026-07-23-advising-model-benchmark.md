# Advising-Model Benchmark — Design Spec

**Date:** 2026-07-23
**Status:** Spec, pre-implementation. Consolidates a long design dialogue.

## Why this exists

Only **local + RCD campus-hosted models are FERPA-cleared for identifiable
student PII** (no OpenAI route is — see
`memory/clemson-data-openai-or-local-only.md`). The advisor runs on Spark
qwen3.6-35b-a3b today, which has an intermittent **malformed-generation** failure
(vLLM guided-decoding: `<tool_call>` XML in content, zero structured tool_calls).

This benchmark **screens the deployable FERPA-OK models** on realistic multi-step
advising work to answer one question: *is any of them reliable and fast enough to
be the Private-mode model — such that the OpenAI (de-identified) toggle mode is
unnecessary?* It is a **screen to shortlist 1–2 for deeper testing, not a final
verdict** — complex questions are expensive, so per-scenario n is modest and
intervals will be wide. Say that in the report; do not pool.

## Hard-won discipline to inherit (do not relitigate)

From `scripts/fabrication-probe.ts` and `scripts/tool-ceiling-probe.ts`:

- **Ground truth is read live** from `state/clemson/202608.db` at run time via
  SQL, never transcribed into a constant. Clemson rewrites the snapshot nightly.
- **The instrument must be able to say "I could not establish this."** A scenario
  whose anchor can't be computed is UNAVAILABLE — excluded from every denominator,
  named in the report — never scored as a model failure. "Couldn't tell" and "was
  wrong" must never be the same value.
- **Per-scenario Wilson intervals; never a pooled rate.**
- **Distinct failure classes:** `http_error`, `unparseable`, `malformed`
  (finish_reason stop + tool_call XML in content + zero structured calls),
  `no_tool_call`, plus the scenario-specific outcomes below. A clean HTTP 400 is
  model behaviour on this project — classify it, don't crash on it.
- **Reuse** `tool-ceiling-probe.ts`'s agentic loop, `EndpointState`/steadiness
  check, and `wilsonInterval`/`formatInterval`. Refuse an unsteady endpoint.

## Candidate panel (the deployable, FERPA-OK models)

| Label | Endpoint | Notes |
|---|---|---|
| `gptoss-120b` | RCD `CLEMSON_LLM_BASE_URL` | Largest; latency test lands hardest here |
| `qwen-agentworld-35b-a3b` | RCD | Agent-tuned; fast a3b |
| `qwen3.6-35b-a3b-fp8` | RCD | Same family as Spark, different host/quant |
| `spark-qwen3.6-35b-a3b` | `ADVISOR_BASE_URL` (Spark) | **Incumbent** — the bar to beat; the other half of model-vs-serving-stack vs the RCD fp8 |

These four compete. The OpenAI models below are the **yardstick, not candidates**
(can't be deployed for PII).

## Yardstick (synthetic data → OpenAI allowed for eval tooling)

- **Reference** (generates a "good answer" bar, NOT ground truth): `gpt-5.4` via
  `CLEMSON_LLM_OPENAI_BASE_URL`.
- **Judge** (scores candidates): `gpt-5.5-pro`. Blinded (candidate identity
  hidden) + randomized answer order to blunt position/verbosity/self-preference
  bias. **Flag `gptoss` scores as watch-items** — an OpenAI judge may favor
  OpenAI-architecture candidates.
- Both configurable in one place. Questions are **synthetic students over real
  courses**, so no FERPA constraint on the judge.

## Scoring is hybrid — anchor first, judge second

- **Deterministic anchor** (the authority): every schedule fact — credits, seats,
  meeting times, and especially **time conflicts** — is computed live from
  `state/clemson/202608.db`. Conflict = same day with overlapping [start_min,
  end_min). The model cannot win by sounding right.
- **Judge rubric** (1–5) scores only what the anchor can't: did it find the
  *best* fit, surface the counterfactual, ask when genuinely ambiguous. Reference
  answer is one input to the judge, not a must-match key (the reference model can
  be wrong too).

## Metrics per candidate (per scenario, with Wilson intervals)

factual-correctness (deterministic) · advising-quality (judge 1–5) ·
malformed-generation rate · tool-calling success · **latency p50/p95 (wall-clock
per completion)** · token volume (prompt/completion).

## Scenarios (synthetic students, REAL Fall-2026 courses/CRNs, term 202608)

Curriculum framing (which course is "specialty area" / "tech elective") is
queried from gc_advisor `req-rules` — already authoritative and anchorable — so
it is NOT baked into prompts. Substitution-dependent cases are DEFERRED until
gc_advisor models the substitution list.

### S1 — natural key, fact + a signal to catch
Prompt: interest in **GC 3400, Mon/Wed 10:10** — credits, and can she still get a
seat? Anchor: `sections` CRN 80822 → `credit_hours`=4; `seats_available`=0 (full).
Outcomes: resolves natural key · reads seats (flags full) · no hallucinated seat.

### S2 — ambiguous key → expect a clarifying question
Prompt: "add **GC 4060, Tues/Thurs at 11**." Reality: two sections at TR 11:00 —
001 (CRN 80833) and 002 Honors (CRN 83836). Anchor: `COUNT` of GC4060 sections
meeting T/R at start_min 660 = 2. Correct behaviour = **asks** regular vs Honors,
does not silently pick. Outcomes: `clarified` (good) / `picked_one` / `other`.

### S3 — messy pasted schedule (real advising-profile format) → conflict screen
Input is the ACTUAL advising-profile paste format — tab columns
`Title | Details | CRN | Hours | Status | Instructor`, with screen-reader cruft
glued to the CRN (`80833Press enter key to view…popup`). Real rows: COOP 2020 001
(80268), GC 4060 001 (80833), GC 4500 001 (82200), GC 4061 003 (83845), PCID 3140
402 (88733). **No meeting times in the paste** → the model must resolve each CRN
to its schedule via the tool. Prompt: she wants one more 3-credit brand course —
do **GC 3720, GC 3630, or GC 3730** fit with no conflict?
Anchor (live conflict vs GC4060 TR 11:00–11:50): GC3720 (85064, TR 11:00–12:15)
**conflicts**; GC3630 (91649, TR 11:00–12:15) **conflicts**; GC3730 (85065, T
17:30–20:30) **fits** → answer set {GC3730}.
Robustness sub-check: CRN correctly stripped from the cruft. Instructor names are
faculty/public — NOT student PII (note for the future detector, not scored here).

### S4 — counterfactual (flagship), built from the real S3 schedule
The pasted student is in **GC 4061 section 003 (83845, TR 8:00–10:45)**. Prompt:
she wants to add **GC 4440**. Reality: GC4440 (80843, TR 9:30–10:45) **conflicts**
with her current lab section 003; the alternate lab sections 001 (80836, MW 8:00)
and 002 (80837, MW 11:15) do **not**. Anchor: conflict matrix across GC4061
section choices. Correct answer surfaces the move: *yes, if she switches GC 4061
to an MW lab section.* Outcomes: `found_counterfactual` / `said_no` (missed it) /
`wrong`.

### S5 — open-ended requirement search with hard constraints (flagship real query)
The most representative advising query: find something to take, subject to a
requirement AND hard scheduling constraints. Input is the **same real pasted
schedule as S3/S4**. Prompt: *"Here's her current schedule — find some options for
an additional class that would count toward either her **Specialty Area** or **GC
Technical** requirement, nothing that meets **before 9:00 a.m.**, and nothing on
**Fridays**."*

Fixture: program `"Graphic Communications, BS"`, catalog year `2025-2026`
(grandfathering makes catalog year load-bearing — pin it, expose it as a constant).

Anchor is a **live two-source join**, and its two halves have DIFFERENT strength —
this asymmetry is load-bearing, do not flatten it:
- **Time/day filter (fully sound, the primary check)** ← `state/clemson/202608.db`:
  a section qualifies iff **every** meeting has `start_min ≥ 540` (9:00) AND no
  meeting on day `F`. This is deterministic regardless of eligibility.
- **Requirement eligibility (one-sided)** ← gc_advisor `req-rules`, unioning
  `explicit_courses` across ALL rows of `Specialty Area Requirement` and
  `Graphic Communication Technical Requirement`. Membership **confirms** a course
  is eligible; **absence does NOT prove ineligibility** — some rules are empty
  wildcard rules ("Any ENGR course", "Any CPSC 2000+") that `explicit_courses`
  does not enumerate. Treat the explicit union as a *lower bound* on eligibility.

Outcomes per suggested (course, section):
- `time_day_violation` — meets before 9:00 or on a Friday. **Definitive model
  failure** (a hard, fully-checkable constraint was broken).
- `valid` — clears the time/day filter AND is in the explicit union.
- `eligibility_unverifiable` — clears time/day but is NOT in the explicit union.
  Could be wildcard-eligible; **NOT scored as wrong** — reported as its own count,
  the instrument declining to judge eligibility (couldn't-establish ≠ wrong).
- `false_empty` — model claimed nothing fits, but the explicit-union answer set is
  non-empty (i.e. a definitely-eligible, time/day-clearing option existed).

Judge-quality bonus (not in the anchor): also avoids conflicts with her existing
TR-morning block, offers a few good options rather than one, notes seats.

Instrument note: this scenario needs BOTH data sources reachable. If gc_advisor
`req-rules` cannot be queried, the scenario is UNAVAILABLE — never a model failure.
This is also the scenario that most directly tests driving the
`find-fulfilling-sections` requirement→sections join tool.

## Instrument-honesty tests (assert before believing any number)

- Anchor conflict logic: known overlapping and known non-overlapping section
  pairs → correct verdict (unit test, like the extractor-validation cases).
- Snapshot missing / CRN renumbered → scenario UNAVAILABLE, not a model failure.
- A candidate that emits the malformed generation is classed `malformed`, not
  silently scored 0 on quality (the failure is the decoder, report it as such).

## Suggested build order (subagent-driven, review each)

1. **Scenario module** + deterministic anchor + anchor unit tests. Anchor reads
   the live schedule DB (conflict/credits/seats/time/day) and, for S5, gc_advisor
   `req-rules` for requirement membership (a local `query.py` subprocess — not a
   network call). No model endpoints touched in this task.
2. **Candidate runner** — reuse `tool-ceiling-probe.ts` loop + steadiness; drive
   one model through the advisor's MCP tool surface; capture answer, tool calls,
   malformed flag, latency, tokens.
3. **Judge + reference callers** (blinded, randomized order) with the rubric.
4. **Aggregation + report** — per-scenario Wilson intervals, latency p50/p95,
   the failure-class table, UNAVAILABLE/watch-item callouts. Refuse to print a
   pooled rate.

## Open items owned by the operator, not the model

- Whether OpenAI (de-identified) toggle mode is needed **depends on this result**.
- Judge variant if `gpt-5.5-pro` is not wanted (the gpt-5.6 luna/sol/terra
  variants were left unresolved).
