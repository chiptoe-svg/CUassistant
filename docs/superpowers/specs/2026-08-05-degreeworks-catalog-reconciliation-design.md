# DegreeWorks ↔ Catalog Reconciliation Engine — Design

**Goal:** Turn a student's DegreeWorks PDF into a compact, structured **requirement checklist** (satisfied / remaining per catalog slot) that the advising agent uses to plan an upcoming semester — so the messy DegreeWorks "Still needed" prose no longer matters.

**Status:** Design approved; ready for implementation planning.

## Context

The advisor already has the pieces: the **Degree Works cleaner** (`advisor/cleaner/modules/degree-works.js`) parses a DegreeWorks PDF into a PII-free ledger; `gc_advisor.db` holds the catalog requirement structure; and the agent has `get-program-requirements`, `find-eligible-sections`, `get-gc-course`, and `propose_schedule`. What's missing is a deterministic step that **reconciles what the student has completed against the catalog's requirements** and hands the agent a checklist to plan from.

DegreeWorks is the **per-student source of truth** (it incorporates transcript, substitutions, waivers, transfer credit). The catalog is authoritative only for the **generic requirement structure**. So DegreeWorks decides what's satisfied; the catalog enumerates the slots and supplies candidates for what's left.

### Catalog data model (verified in `gc_advisor.db`)

- `program` — one row per program per catalog year (GC BS has 8 years: 2019-2020 … 2026-2027).
- `requirement_group` — for the current GC BS, a **term-by-term plan of study** (`kind='term'`, e.g. "Freshman/First Semester", `credit_total`).
- `plan_item` — the requirement atoms, each under a `requirement_group`:
  - `kind='fixed_course'` → a specific `course_code` (e.g. `GC 1010`).
  - `kind='choice'` → `one_of` is a JSON array of interchangeable codes (e.g. `["STAT 2220","STAT 2300","STAT 3090","STAT 3300"]`).
  - `kind='slot'` → a named `slot_type` (e.g. "Specialty Area Requirement", "Approved Laboratory Science Requirement", "Elective") with `credits`.
- `requirement_rule` — per-`slot_type` rule JSON (total credits, etc.).
- `advisor_course` — curated allow/deny candidate courses per `slot_type` (per program + catalog year, with `note`). **This is the curation surface.**
- `course` — descriptions, prereqs (`prereq_parsed`), coreqs (`coreq_parsed`), terms offered.

## Decisions

1. **V1 scope:** the reconciliation *engine* is program-agnostic; v1 proves it against **GC BS, one catalog year**. Scaling to more years / minors / other majors is adding `advisor_course` rows, not code.
2. **Output:** an **agent tool only** — a structured checklist the agent reasons over and explains; no new UI in v1.
3. **Requirement types reconciled:** **course slots (`fixed_course`, `choice`, curated `slot`) + credit totals.** Gen-ed *distribution* buckets, `Elective`, residency, and GPA are emitted as `deferred: "see DegreeWorks"` — never silently checked.
4. **Matching strategy — hybrid, DegreeWorks-authoritative:** DegreeWorks' course→block placement is the authority for what's satisfied; **course-code overlap** is the mechanism that connects DegreeWorks blocks to catalog slots (no prose-label matching) and the fallback when block placement is missing/low-confidence.

## Non-goals (v1)

- No rendered/editable checklist UI (agent-tool output only).
- No auto-checking of gen-ed distribution, `Elective`, residency, or GPA.
- No writes to `gc_advisor.db` (it is owned by the `gc_advisor` project; curation happens there).
- No coverage beyond GC BS + one catalog year (engine supports more via data).

---

## Architecture (four units)

```
DegreeWorks PDF ──▶ [1] Cleaner (client, PII-safe)
                        │  ledger = completed/in-progress courses
                        │        + each course's DegreeWorks BLOCK placement (appliesTo)
                        │        + program + catalog year
                        ▼   (advisor pastes ledger into chat)
            [2] reconcile tool (server, reads gc_advisor.db)
                 ├─ [3] crosswalk builder (block ↔ catalog slot, by course-overlap; pure, DB-free)
                 └─ [4] matcher           (DegreeWorks-authoritative satisfaction; pure, DB-free)
                        │  → checklist (gc-reconcile-v1)
                        ▼
                     Agent ──▶ explains + drives propose_schedule
```

- **[1] Cleaner** — one change: `makeCourseLedger` **retains** each course's `appliesTo` (block/requirement), which `toPublicCourse` already computes but currently drops. Still whitelist-extracted; no PII.
- **[2] reconcile tool** — new host/MCP tool `reconcile({ ledger, program?, catalogYear? })`. Owns no matching logic; composes [3]+[4]; the only unit that reads `gc_advisor.db`.
- **[3] crosswalk builder** — pure function: DegreeWorks blocks (with courses) + catalog slots (+ `advisor_course`) → block↔slot mappings by course-set overlap.
- **[4] matcher** — pure function: crosswalk + completed courses (with placement) + `plan_item` list → the checklist.

**Boundary rules:** [3] and [4] are pure and DB-free (fixture-testable, no network). The ledger is the *only* student data that enters the tool; the catalog is never merged into the ledger.

---

## Data contract

**Cleaner → ledger** (extends today's `gc-course-ledger-v1`; only new thing is retained `appliesTo`):

```json
{ "schema": "gc-course-ledger-v1",
  "programName": "Graphic Communications, BS",
  "catalogYear": "2026-2027",
  "creditsRequired": 122, "creditsApplied": 45,
  "courses": [
    { "code": "GC 1010", "title": "...", "term": "Fall 2025",
      "credits": 1, "status": "completed",
      "appliesTo": [ { "block": "Degree", "requirement": "Graphic Communication Technical Requirement" } ] }
  ] }
```

**Tool input:** `reconcile({ ledger, program?, catalogYear? })` — `program`/`catalogYear` default from the ledger, overridable when the ledger's program string is ambiguous.

**Catalog reads (from `gc_advisor.db`, keyed on `program.name` + `catalog_year`):** `plan_item`, `advisor_course`, `requirement_rule`, `course`.

---

## Matching engine

**Setup:** from the ledger, build `completed` and `inProgress` code sets and a `block → [completed courses]` map from `appliesTo`. From the catalog, load the program's `plan_item` list.

**Per `plan_item`:**

- **`fixed_course`** — `satisfied` iff `course_code ∈ completed`; `in_progress` iff in `inProgress`; else `remaining` (it is its own candidate). Pure code check.
- **`choice`** — `satisfied` iff any code in `one_of` is completed; `in_progress` if only in-progress; else `remaining`, `candidates = one_of`. Pure code check.
- **`slot`** — hybrid:
  1. **Crosswalk:** map `slot_type` to the DegreeWorks block whose completed courses best overlap the slot's `advisor_course` candidates (course-overlap, not label). Curated overrides via `advisor_course`.
  2. **Satisfied credits (DegreeWorks-authoritative):** sum `credits` of completed courses DegreeWorks placed under that block — inherits substitutions and excess.
  3. **Fallback:** for a completed course with missing/low-confidence block placement, use `advisor_course` candidacy.
  4. `satisfied` iff satisfied-credits ≥ `slot.credits`; else `partial`/`remaining` with `candidates = advisor_course allow − deny − completed`.

**Precedence (DegreeWorks wins):**
- Candidate course that DegreeWorks applied *elsewhere* or marked *excess* → **not** counted here (no over-checking).
- Non-candidate course DegreeWorks placed under the block → **counted**, flagged `substitution` (surfaced as a suggestion to add to `advisor_course`).

**Deferred types:** `slot_type ∈ {Elective, gen-ed distribution}` and institutional (residency/GPA, which the cleaner drops) → `deferred: "see DegreeWorks"`. Never silently checked/unchecked.

**Credit totals:** roll up satisfied vs required credits per term group and overall; the ledger's `creditsApplied`/`creditsRequired` cross-checks the sum.

**Double-count guard:** a completed course contributes only to the item(s) DegreeWorks actually applied it to.

---

## Output schema (`gc-reconcile-v1`)

```json
{
  "schema": "gc-reconcile-v1",
  "program": "Graphic Communications, BS",
  "catalogYear": "2026-2027",
  "summary": {
    "creditsApplied": 45, "creditsRequired": 122,
    "counts": { "satisfied": 24, "in_progress": 2, "partial": 1, "remaining": 9, "deferred": 3 }
  },
  "items": [
    { "requirement": "GC 1010", "kind": "fixed_course", "credits": 1,
      "status": "satisfied", "by": ["GC 1010"], "term": "Freshman/First Semester" },
    { "requirement": "Statistics choice", "kind": "choice", "credits": 3,
      "status": "remaining", "candidates": ["STAT 2220","STAT 2300","STAT 3090","STAT 3300"] },
    { "requirement": "Specialty Area Requirement", "kind": "slot", "credits": 8,
      "status": "partial", "satisfiedCredits": 3, "by": ["GC 3400"],
      "candidates": ["GC 3410","GC 3520","GC 4080"], "candidatesTruncated": true,
      "flags": ["substitution"] },
    { "requirement": "Elective", "kind": "slot", "credits": 3,
      "status": "deferred", "note": "see DegreeWorks" }
  ],
  "warnings": [
    "2 completed courses had no DegreeWorks block placement; used candidacy fallback",
    "1 DegreeWorks block did not map to any catalog slot (possible substitution) — review"
  ]
}
```

**Per-item fields:** `status ∈ satisfied|in_progress|partial|remaining|deferred`; `by` (satisfying course(s)); `satisfiedCredits` (partial slots); `candidates` (remaining/partial, **capped** with `candidatesTruncated`); `flags` (`substitution`, `low_confidence`, `fallback_candidacy`); `term`. **Absent by design:** descriptions, prereqs, section lists, PII — fetched on demand via existing tools.

---

## Curation, error handling, testing

**Curation:** the block↔slot crosswalk is *computed* per reconcile (no stored table in v1). The single curation surface is `advisor_course` (allow/deny per slot). **`gc_advisor.db` is owned by the `gc_advisor` project** — the reconcile tool reads it read-only; `substitution` flags are suggestions a human adds on the `gc_advisor` side. Scaling = adding rows there.

**Error handling:**
- Ambiguous program (8 GC years) → resolve via ledger `catalogYear`; if absent, error listing available years.
- Empty/garbled ledger → "no completed courses parsed," not a bogus all-remaining checklist.
- Unmapped DegreeWorks block → `warning` + candidacy fallback; never a silent drop.
- `gc_advisor.db` unavailable → clear "catalog unavailable" error (matches existing tools).

**Testing:**
- **[3]/[4] pure units** (fixture-driven, no DB): fixed_course satisfied/in-progress/remaining; choice; slot via candidacy; slot via DegreeWorks placement with non-candidate → `substitution`; an **excess** course that must not over-check; deferred slot; credit rollup; unmapped-block warning.
- **Cleaner change:** `appliesTo` retained in the ledger; still no PII.
- **[2] reconcile tool:** one golden integration test — de-identified DegreeWorks ledger + small `gc_advisor.db` slice → expected `gc-reconcile-v1`.

**Success criterion:** for a real de-identified GC BS DegreeWorks, the reconcile output's satisfied/remaining set **matches DegreeWorks' own audit** on a spot-check, substitutions are flagged (not dropped or wrongly counted), and the output carries no PII.
