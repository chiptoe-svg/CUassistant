# DegreeWorks Audit Integration — `gc_advisor` Coordination Spec

**Status:** DRAFT — shared with the `gc_advisor` project for review (2026-08-06); awaiting their answers to the five open questions before it's finalized.

**Purpose:** A cross-project proposal to share with the `gc_advisor` project. It defines the contract and the small set of `gc_advisor`-side deliverables needed to give the CUassistant advisor a working DegreeWorks audit + semester planning, **reusing `gc_advisor`'s existing audit engine** rather than building a second one.

**Supersedes:** `docs/superpowers/specs/2026-08-05-degreeworks-catalog-reconciliation-design.md` (that spec reinvented an engine that already exists in `gc_advisor`; this one wires the existing engine instead).

---

## TL;DR — what we're asking `gc_advisor` to do

1. **Add the missing CLI `scripts/audit.py`** (Plan D Task 3, never completed). CUassistant already calls it; it's the only hard blocker.
2. **Confirm/freeze two versioned contracts** (`gc-progress-v1` input, the audit output dict) that CUassistant depends on.
3. **Confirm parser ownership:** CUassistant's cleaner is the canonical DegreeWorks parser → `gc_advisor` can drop Plan D's `web/` parser + `serve_advisor.py` page tasks (avoid two parsers).
4. **Confirm the architectural split** (below): CUassistant reconciles DegreeWorks-vs-audit at *its* agent layer, so `gc_advisor`'s engine stays pure — no need to ingest DegreeWorks placement.

Everything else needed is CUassistant-side.

---

## Current state (verified)

**Built on `gc_advisor`:**
- `src/gc_advisor/audit/engine.py::run_audit(db_path, progress) -> dict` — deterministic, offline, catalog-DB audit with two-pass waterfall allocation (each credit consumed once), `advisor_course` + wildcard curation, gen-ed progress, credits remaining, and prereq-eligible next courses. ~111 tests (`test_audit_engine/models/specialty/wildcards`).
- `advisor_course` curation layer + `manage_advisor_list.py` CLI; `transfer-and-substitutions.md` advisor-judgment skill.

**Built on CUassistant:**
- MCP tool **`audit-gc-progress`** (`src/mcp-tools/catalog.ts`) → `auditGcProgress()` (`src/gc-curriculum.ts`), which shells out to `GC_ADVISOR_AUDIT` (= `scripts/audit.py`) piping `gc-progress-v1` JSON via stdin.
- The **cleaner** (`advisor/cleaner/modules/degree-works.js`) already parses a DegreeWorks PDF and computes a `progress` object client-side (PII-stripped).

**Missing (the gap):**
- **`gc_advisor/scripts/audit.py`** — does not exist (only `query.py` does). So the wired MCP tool fails at runtime today.
- **CUassistant cleaner does not emit canonical `gc-progress-v1`** — its `progress` uses `schema`/`catalogYear`/`courses[]`; the engine wants `version`/`catalog_year`/`passed[]`+`in_progress[]`/`minor`/`grade_checks`. A mapping is required (CUassistant-side).

---

## Division of labor

| Concern | Owner |
|---|---|
| DegreeWorks PDF parse + PII stripping (client-side) | **CUassistant** (`advisor/cleaner`) — canonical |
| Emit canonical `gc-progress-v1` from the cleaner | **CUassistant** |
| Catalog-derived degree audit (`run_audit`) + curation | **`gc_advisor`** (exists) |
| `scripts/audit.py` CLI entrypoint | **`gc_advisor`** (missing — the ask) |
| MCP tool `audit-gc-progress` + caller | **CUassistant** (exists) |
| DegreeWorks-vs-audit reconciliation, substitution flags, planning | **CUassistant** agent layer |
| `advisor_course` curation of flagged substitutions | **`gc_advisor`** (via `manage_advisor_list.py`) |

---

## Contracts

### Input — `gc-progress-v1` (what `run_audit`'s `Progress.from_dict` expects)

```json
{
  "version": "gc-progress-v1",
  "catalog_year": "2026-2027",
  "program": "Graphic Communications, BS",
  "passed": [ { "code": "GC 1010", "term": "Fall 2025", "credits": 1 } ],
  "in_progress": ["GC 1040"],
  "minor": { "name": "Business Administration", "complete": false },
  "grade_checks": { "c_or_better": ["GC 1010"] },
  "warnings": ["1 unparsed line in Spring 2025 block"]
}
```
No identity, GPA, or raw grades — `grade_checks` carries only *which* codes met a threshold. **CUassistant's cleaner must emit exactly this shape** (currently it does not — see the gap).

### Output — the audit dict `run_audit` returns (verified)

```json
{
  "catalog_year": "...", "program": "...",
  "total_credits_required": 122, "credits_earned": 45, "credits_remaining": 77,
  "items": [
    { "kind": "fixed_course|choice|slot", "slot_type": "...", "credits": 3,
      "status": "met|unmet|...", "counted_courses": ["GC 3400"], "flags": [] }
  ],
  "gen_ed": [ { "status": "met|unmet", "min_credits": 3, "earned": 3, ... } ],
  "eligible_next": [ { "code": "GC 3410", "prereq": "all parsed prereqs passed", "co_reqs": ["GC 3411"] } ],
  "flags": ["GC 3400: not in course catalog — verify manually"]
}
```
`items[].status`/`counted_courses` + `flags` are what CUassistant needs to reconcile against DegreeWorks; `eligible_next` is the planning candidate list.

**Ask:** treat both as **versioned** (bump `gc-progress-v1` / add an output `schema` field on change) so CUassistant isn't broken by a silent shape change.

---

## The architectural decision to confirm

`gc_advisor`'s engine has a stated **purity invariant** (*"`run_audit` must remain pure, offline, catalog-DB only — no LLM/MCP/network"*), and handles substitutions deliberately via `advisor_course` curation + the `transfer-and-substitutions` skill, **not** by reading DegreeWorks' own placement.

CUassistant's user wants DegreeWorks (the per-student source of truth, incl. substitutions/waivers) to be **authoritative**. We reconcile these **without changing `gc_advisor`'s engine**:

- `run_audit` gives the **catalog-derived** audit (generic requirements + curation).
- CUassistant's cleaner *also* surfaces **DegreeWorks' own satisfied/remaining** (de-identified; it already extracts `requirementsRemaining`).
- CUassistant's **agent layer compares the two**: agreement → confident; disagreement (a substitution DegreeWorks credited that the audit didn't) → **defer to DegreeWorks**, **flag it**, and **suggest an `advisor_course` addition** for a human to curate on the `gc_advisor` side.

Net: `gc_advisor`'s engine stays pure; DegreeWorks authority lives in CUassistant's agent layer; the flag→curate loop closes over time. **Please confirm this division is acceptable and that `items[].counted_courses` + `flags` give enough signal to reconcile.**

---

## Open questions for `gc_advisor`

1. **`scripts/audit.py`** — OK to add the ~20-line stdin→`Progress.from_dict`→`run_audit`→stdout JSON CLI at that path (matching `GC_ADVISOR_AUDIT`)? Any preferred flags/errors contract?
2. **Contracts versioned?** — will you bump `gc-progress-v1` / stamp the output schema on change?
3. **Parser ownership** — agree CUassistant's cleaner is canonical and Plan D's `web/` parser + `serve_advisor.py` page can be dropped?
4. **Reconciliation split** — is the agent-layer DegreeWorks reconciliation (above) the right boundary, or do you want any of it in the engine?
5. **Program scope** — engine is GC-BS-focused today; is auditing other majors on your roadmap, or should CUassistant gate the feature to GC BS?

---

## Non-goals / future

- **HTTP service** (`serve.py`/`serve_advisor.py`, loopback `:8768`) replacing the shell-out — planned separately (`2026-06-23-gc-advisor-http-service.md`); **not** a blocker for v1. The shell-out works once `audit.py` exists.
- Editable/rendered checklist UI — deferred (agent-tool output for v1).
- Non-GC-BS programs — data/curation work, not engine work.
