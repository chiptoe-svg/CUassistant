---
name: clemson-schedule-advising
description: Use when answering schedule, room-availability, conflict-check, or GC degree-advising questions using CUassistant's Clemson tools. Indexes the public Banner + gc_advisor catalog MCP tools by purpose, gives the standard multi-tool workflows, and records the known limitations. Per-tool parameters live in each tool's own schema — this doc is for which tool to use when, and how they chain.
---

# Clemson Schedule & Advising

CUassistant exposes two public MCP servers for Clemson data. Neither requires
credentials.

| Server | Port | Tool prefix (NanoClaw) |
|---|---|---|
| `cuassistant-public` | 8766 | `cuassistant-public__` |
| `cuassistant-catalog` | 8767 | `cuassistant-catalog__` |

All data is read-only. All Clemson content must be processed by **OpenAI or a
local model only** — never routed through Anthropic. This is a hard constraint
in `policy/action-policy.yaml`.

**Parameters and return shapes are NOT repeated here.** Every tool arrives with
its own input schema (names, types, descriptions) — read that for the exact
arguments; it is always current. This document covers what a schema can't: which
tool to reach for, the order to call them in, and where the data lies to you.

---

## Scheduling tools (`cuassistant-public`, 8766)

| Tool | Use it to… | Watch out for |
|---|---|---|
| `list-clemson-terms` | Get a Banner term code | Call first whenever you don't already have a `term` code; pass its `code` to every other tool. |
| `search-clemson-classes` | Search the class schedule | **Must** scope by `subject` or `courseNumber` — a whole-term search is rejected. Snapshot-backed (nightly ~05:00); pass `refresh` only for live seat counts. Page with `offset` when `totalCount` exceeds what was returned. |
| `get-clemson-section-details` | Full catalog detail for one CRN (prereqs, restrictions, attributes) | No parsed textbook list — Banner exposes only a bookstore URL. |
| `find-clemson-instructor-classes` | Every section a faculty member teaches | An ambiguous name returns `candidates[]` with empty `sections` — re-call with a full unambiguous name. |
| `get-clemson-room-availability` | Busy/free blocks for a classroom | **Do not** pass `subject` — a room hosts many departments and a subject filter undercounts it. Sees only Banner-scheduled classes, **not** 25Live ad-hoc events. |
| `check-schedule-conflicts` | Find time-overlapping CRN pairs in a set | TBA/online sections (no meeting time) come back in `conflict_free` because there's no time to conflict — that is not a real compatibility guarantee. |
| `find-conflict-free-schedule` | Which candidate CRNs fit around already-fixed CRNs | Each candidate is checked against all fixed CRNs and all other candidates. |

## Catalog / advising tools (`cuassistant-catalog`, 8767)

| Tool | Use it to… | Notes |
|---|---|---|
| `list-gc-catalog-years` | Get a valid catalog `year` | Call first; students are pinned to their matriculation year — never mix years. |
| `get-gc-program-plan` | Full semester-by-semester GC degree plan | Groups → items (`fixed_course` / `choice` / `slot`) → footnotes. |
| `get-gc-requirement-rules` | Lab-science / specialty-area / technical slot rules | The `slot_type` values here are the required input to `find-eligible-sections`; `explicit_courses` lists what satisfies each slot. |
| `get-gc-gen-ed` | The six Gen-Ed categories with min credits + allowed courses | Apply the `rules` constraint sentences (e.g. Social Sciences "two different fields"). |
| `get-gc-course` | Title, credits, description, prereqs for one course | Returns null if the code isn't in the DB — tell the student to verify the code. |
| `audit-gc-progress` | Deterministic degree audit on a sanitized ledger | Input is course codes + terms + credits only — no identity, no grades (and none accepted). |
| `find-eligible-sections` | **The advising join** — sections that satisfy a GC slot AND are offered this term AND are prereq-eligible, with scheduling-constraint filters | Does the whole join in SQL. When a question combines a requirement slot with time/day/conflict/open-seat constraints, make **one** call with those filters — do not pull the full eligible list and hand-filter it. Read the schema for the current filter arguments. |

For deeper GC advising domain rules — degree-audit logic, specialty-area
approval, lab co-requisite pairs, internships, transfer credit, scheduling
heuristics — consult the **`gc-advisor`** skill (`list-gc-skills` /
`get-gc-skill-docs`). This document is the tool index + scheduling workflows;
`gc-advisor` is the advising playbook.

---

## Standard workflows

**Open sections for a subject**
`list-clemson-terms` → `search-clemson-classes { subject, openOnly }` →
`get-clemson-section-details` for any CRN needing full detail.

**Does a proposed schedule conflict?**
`list-clemson-terms` → collect CRNs (`search-clemson-classes` /
`find-clemson-instructor-classes`) → `check-schedule-conflicts { crns }`.

**Build a conflict-free schedule from options**
Split CRNs into fixed vs candidate → `find-conflict-free-schedule { fixed_crns,
candidate_crns }` → confirm the chosen set with `check-schedule-conflicts`.

**Find eligible sections for a requirement slot**
`list-gc-catalog-years` → `get-gc-requirement-rules` (note the `slot_type`) →
`list-clemson-terms` → `find-eligible-sections { term, slot_type,
completed_courses, …constraints }` → `check-schedule-conflicts` to confirm fit.

**Room availability**
`list-clemson-terms` → `get-clemson-room-availability { building, room, days }`
(no `subject`).

**Full advising session**
`list-gc-catalog-years` → `get-gc-program-plan` (identify open slots) →
`audit-gc-progress` (what's satisfied vs open) → `get-gc-requirement-rules`
(explicit courses for open slots) → `list-clemson-terms` →
`find-eligible-sections` per open slot → `find-conflict-free-schedule` on the
candidate set → `check-schedule-conflicts` on the final proposal. For lab pairs,
confirm **both** halves have seats and don't conflict.

---

## Known limitations

- **Prereq eligibility is AND-logic.** `find-eligible-sections` marks
  `prereq_eligible` true only when **every** parsed prereq code is in
  `completed_courses`. A real "GC 1010 **or** GC 2010" prereq can be reported
  `false` when the student has only one. Always show `prereq_text` for OR-logic
  courses so the student can verify.
- **TBA / async sections have no meeting rows.** They appear in searches but
  carry no `meetings[]`, so `check-schedule-conflicts` returns them
  `conflict_free` — not a guarantee of real compatibility.
- **Snapshot lag.** The schedule snapshot refreshes ~05:00; seat counts can be
  ~24h old. Fine for "what are the sections?"; for "is there a seat right now?"
  use the live `refresh` path or Banner directly.
- **Day ordering is MTWRFSU.** Meeting days are always Monday-first: M T W R F
  S U (S = Saturday, U = Sunday). A MWF class is `"MWF"`, never `"FMW"`.
- **`find-eligible-sections` is GC-only and needs a snapshot.** The join is
  between the Banner snapshot and `gc_advisor.db`, so only GC programs/rules are
  queryable, and a term with no snapshot yet (a newly opened term before ~05:00)
  errors — retry after the next daily refresh. For non-GC programs, use
  `search-clemson-classes` with course codes from `get-gc-program-plan`.
