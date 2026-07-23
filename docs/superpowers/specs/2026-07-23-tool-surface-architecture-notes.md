# Tool-Surface Architecture — Design Notes

**Date:** 2026-07-23
**Status:** Design notes, pre-implementation. Captures decisions from a long
design dialogue so they survive into a fresh session. Nothing here is built.

## Why this exists

The advisor agent currently receives **one 24-tool array** merging three MCP
servers (8766 schedule, 8767 catalog, curriculum wiki). We measured that tool
count drives an intermittent model failure, and we explored several ways to
manage it. This records where that exploration landed, what was measured vs
assumed, and what to build — so the next session doesn't re-derive it.

The single overriding lesson of the session that produced this: **measure
against a captured payload at n≥20 on a verified-steady endpoint; do not reason
from a reconstructed model.** Six confident diagnoses were made during this work
and all six were wrong, each killed the moment a real payload was replayed or a
real n was run. Every recommendation below that is not marked "measured" is a
hypothesis, and the probes in `scripts/` exist to settle them.

## What was measured (trust these)

- **Tool-count degradation is a gentle slope on our endpoint, not a cliff.**
  300-trial run (`scripts/tool-ceiling-probe.ts`), qwen3.6-35b-a3b on Spark:
  ~100% tool-calling at 8 tools declining to ~70–85% at 35, all confidence
  intervals overlapping except the extremes. **No cliff to 35.** The 46-tool
  cliff ("45 fine, 46 → 0/5") was a *different* quant (a colleague's NVFP4
  build), not ours. At our current 24 tools we sit near ~80%.
- **Naming (bare / single-underscore / double-underscore prefix) has no measured
  effect** at n=20. An earlier "namespace prefix breaks tool calling" finding was
  an artifact of n=3 on an unsteady endpoint.
- **The live failure mode is the malformed generation:** `finish_reason:"stop"`
  with `<tool_call>` XML in `content` and zero structured `tool_calls`. This is a
  decoder / guided-decoding breakdown, NOT a reasoning failure. It is intermittent
  and, per the endpoint owners, a known server-side degradation — but it also
  correlates with tool-array size on our data.
- **Fabrication is 0/120** (per-question 0/20, upper bound ~16% each — *not*
  pooled to 0–3%) on fully-specified single-fact questions, including hard cases
  a plausible default gets wrong. Grounding works. This says nothing about
  multi-step turns with conflicting tool results.
- **gpt-5.4 via the Clemson gateway vs Spark qwen3.6:** behaviourally
  indistinguishable within intervals (tool-calling 85% vs 100%, intervals
  overlap; fabrication 0/120 each). The only consistent difference is token
  volume (Spark ~1.6× prompt, ~7× completion). Budget now exists for both.

## Pi lifecycle constraint (the fact that shapes everything)

Read from the installed `@earendil-works/pi-agent-core` 0.75.4 source, not
inferred:

- **The `tools` array is fixed at harness construction.** The model cannot gain
  or shed a tool mid-turn.
- **Pi skills (`resources.skills`) carry instructions, not tools.** The `Skill`
  type is `{ name, description, content, filePath }` — no tools field. Reading a
  skill injects guidance text; it does not change the tool array.
- **Pi surfaces skills as name+description+location in the system prompt** and
  tells the model to *read the full file when the task matches*. The model reads
  it via a **filesystem read tool** — which the advisor deliberately does not
  have (fetch/web-search/coding tools were all stripped). So the advisor's agent
  would see skill descriptions and have no way to open them.

**Consequence:** any scheme where "the model picks a skill/domain and that shrinks
its tool array" cannot be model-driven mid-turn. Selection must happen
**host-side, before harness construction.** Pi decides skills mid-turn; the tool
array is set before the turn. The two happen at different points in the
lifecycle and cannot be joined by a prompt.

## Decision 1 — Route, don't nest, don't rely on Pi-native skills

Three approaches were considered for shrinking what the model sees per turn.

- **Pi-native skills** — REJECTED as a tool-count lever. They compose instructions
  (the model can read several), which helps the ≤45K *context* budget, but they
  do not gate the tool array (above). Good for prompt size, irrelevant to the
  malformed-generation curve.
- **Nesting** (one `schedule` tool with a `mode` flag replacing ~7 narrow tools)
  — REJECTED as the primary lever. It *relocates* the decision (which mode + which
  conditional args) rather than removing it. Two hazards: a conditional JSON
  schema (`oneOf`/`if-then`) can make guided decoding *harder*, not easier; a flat
  superset of args loses per-mode validation and admits invalid combinations.
  External best-practice advice independently argues against it ("prefer many
  narrow tools over few broad ones"). If ever revisited, it is a *measurable*
  question — build one nested `schedule` vs the 7 flat tools and run the ceiling
  probe head to head — not an architectural assumption.
- **Host-side selector / router** — CHOSEN. A thin dispatcher picks the domain(s)
  from the request and hands the harness only that domain's tool subset, before
  the harness is built. This is the only approach that (a) actually shrinks the
  tool array, (b) fits Pi's lifecycle (selection is pre-turn), and (c) matches the
  external best-practice architecture (discovery → selection → schema →
  execution). Endorsed by our measurements, the Pi constraint, and the external
  advice simultaneously.

**Critical design constraint on the selector — skill/domain boundaries must match
the shape of real advising requests, not the three MCP servers.** The advisor's
defining question — *"student has GC 4060 and GC 3400 at these times, find a
specialty-area class and a GC tech elective that fit"* — spans scheduling AND
curriculum. A per-server split would leave that question missing half its tools.
So the selector must either compose domains (load scheduling + catalog together,
union of tools, ~15, still under any observed cliff) or offer a request-shaped
"advising" bundle. Compose-multiple is the likely right default; it degrades
gracefully and matches how advisors actually ask. **This depends on the real
advisor question mix, which is the owner's knowledge, not the model's.**

## Decision 2 — The Multi-step Task Helper is a behavioural skill, split from gating

A proposed "Multi-step Task Helper" skill (plan → execute one step → checkpoint →
validate → finalize, with failure handling and tool-gating rules). Verdict: add
the behavioural half as a skill; move the gating half to the host.

- **Behavioural discipline → skill.md:** plan first, one tool call per step,
  one-sentence checkpoint, validate, finalize, retry-once-then-report-partial,
  minimum-viable-args. All genuine model behaviour a prompt can shape, and this
  model follows instructions well (79/80 asking for a missing argument).
- **Tool-gating bullets → the host selector (Decision 1), NOT the skill.** "Expose
  only the next tool group / load schemas after selection" is host behaviour; a
  prompt cannot enforce it because the tool array is fixed at construction. Written
  into the skill, those bullets over-promise and will mislead a maintainer into
  thinking the skill gates tools when it doesn't.
- **What it fixes:** drift (improvising, wrong order, over-fetching). **What it
  does NOT fix:** the malformed-generation decoder failure — no plan discipline
  touches that.
- **Step 4 "Validate" is a drift-catcher, not a correctness gate.** A model that
  fabricates validates its own fabrication as fine. The host-side DB verification
  (`src/advisor-schedule-verify.ts`, the `CheckedSchedule` type gate) stays the
  real correctness control for high-stakes output.
- **UX interaction to decide, not assume:** "short plan + per-step checkpoint"
  produces visible intermediate output, which reintroduces exactly what the
  advisor's buffer-and-gate accessibility design chose to avoid (stream nothing,
  release one complete answer). Plan+checkpoints may build advisor trust or be
  noise. Real decision, tied to §6 of `2026-07-21-advisor-chat-design.md`.
- **Scope it to multi-step tasks**, not universal — it is overhead on a one-step
  lookup. Deciding "is this multi-step" is itself a selection concern.
- **Whether the model reliably *follows* a 3–5 step plan is measurable**, and the
  failure mode is subtle: it will *say* it's following the plan while improvising.
  That is exactly the kind of thing the probe discipline catches rather than
  takes on faith.

## Cheap wins, independent of any of the above

From the external best-practice list, two are low-cost and need no architecture
change:

- **Tool descriptions should say when NOT to use a tool**, not only when to. Ours
  say when-to; few say when-not. Editing MCP tool descriptions changes the live
  8766/8767 servers → requires a daemon restart per `CLAUDE.md`.
- **Require a scoping filter.** `search-clemson-classes` takes `max`/`offset` but
  does not require `subject`/`courseNumber`, so "everything" is still askable.
  Requiring a scope prevents the context-explosion case.

Already banked (do not redo): **compact outputs** — the −47% payload work
(minify, hoist row-constant fields, truncation hints) is exactly best-practice #6,
and we are ahead of the advice there.

## Suggested sequence for a fresh session

1. **Cheap wins** (descriptions + mandatory scoping) — small, safe, restart the
   two public daemons after, verify tool lists.
2. **Prototype the selector layer** — a host-side dispatcher choosing a composed
   tool subset by request intent, built before harness construction. Dispatch as
   a subagent with a tight brief; keep the controller's context for review.
3. **Measure it with `scripts/tool-ceiling-probe.ts`** — does scoping to ~8–15
   tools actually recover the reliability the slope predicts? Do not assume it;
   the whole point of the probe is that intuition about this model is unreliable.
4. **Multi-step helper skill** — behavioural half only, scoped to multi-step
   tasks, after the selector exists (it is the thing that would enforce the
   gating half). Decide the buffer-and-gate UX interaction first.

## Open questions the owner must answer (not the model)

- The real advisor question mix — how often is a request cross-domain? This sets
  whether the selector composes domains by default or offers a single "advising"
  bundle.
- Whether plan+checkpoint intermediate output is wanted in the advisor UI, given
  the deliberate buffer-and-gate design.
- Whether to route wiki-heavy or otherwise hard turns to gpt-5.4 (100%
  tool-calling, now budgeted) rather than Spark — a per-turn model-selection
  question the provider chain could encode.

## Pointers

- Design: `docs/superpowers/specs/2026-07-21-advisor-chat-design.md`
- Probes: `scripts/tool-ceiling-probe.ts`, `scripts/fabrication-probe.ts` (both
  refuse underpowered or endpoint-unsteady runs)
- Verification gate: `src/advisor-schedule-verify.ts` (`CheckedSchedule`)
- Pi harness wiring: `src/advisor-agent.ts`; MCP bridge + tool surface:
  `src/advisor-mcp.ts`
