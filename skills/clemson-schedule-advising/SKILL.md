---
name: clemson-schedule-advising
description: Use when answering schedule, room-availability, conflict-check, or GC degree-advising questions using CUassistant's Clemson tools. Covers all public Banner + gc_advisor catalog MCP tools with input/output shapes, standard workflows, and known limitations.
---

# Clemson Schedule & Advising

CUassistant exposes two public MCP servers for Clemson data. Neither requires
credentials or a Bearer token.

| Server | Port | Prefix in NanoClaw |
|---|---|---|
| `cuassistant-public` | 8766 | `cuassistant-public__` |
| `cuassistant-catalog` | 8767 | `cuassistant-catalog__` |

All data is read-only. All Clemson content must be processed by **OpenAI or a
local model only** — never routed through Anthropic. This is a hard constraint
in `policy/action-policy.yaml`.

---

## Public server tools (`cuassistant-public`)

### `list-clemson-terms`
List available Banner term codes.

```
args:  { max?: number }          // default 20
return: { terms: [{ code: string, description: string }] }
example return: { terms: [{ code: "202608", description: "Fall 2026" }] }
```

Always call this first when you don't have a term code. Pass the `code` value
to every other tool that takes a `term` argument.

---

### `search-clemson-classes`
Search the Banner class schedule. Served from the daily SQLite snapshot by
default (fast, no Banner load); falls back to a live query if no snapshot exists.

```
args (required): { term: string }
args (optional): {
  subject: string,        // e.g. "CPSC"
  courseNumber: string,   // e.g. "1010"
  openOnly: boolean,      // default false
  max: number,            // default 50, capped at 500
  offset: number,         // default 0, for paging
  refresh: boolean        // force live Banner query (slow — use sparingly)
}
```

Returns:
```json
{
  "term": "202608",
  "snapshotDate": "2026-07-15",
  "scope": "snapshot",         // "snapshot" | "live"
  "totalCount": 412,
  "sections": [{
    "crn": "80001",
    "subject": "GC",
    "courseNumber": "1010",
    "subjectCourse": "GC 1010",
    "section": "001",
    "title": "Intro to Graphic Comm",
    "creditHours": 3,
    "seatsAvailable": 5,
    "enrollment": 25,
    "maxEnrollment": 30,
    "waitlistCount": 0,
    "instructors": [{ "name": "Kern Cox", "email": "kcox@clemson.edu" }],
    "meetings": [{
      "days": "MWF",
      "beginTime": "0900",
      "endTime": "0950",
      "building": "Godfrey",
      "room": "205"
    }]
  }]
}
```

**When to use `refresh: true`:** only when you need up-to-the-minute seat counts
(e.g., a student is registering right now). The snapshot is refreshed nightly at
~05:00; day-old seat counts are accurate for advising purposes.

**Paging:** if `totalCount > sections.length`, increment `offset` by `max` and
re-call to retrieve additional pages.

---

### `get-clemson-section-details`
Catalog detail for one section: description, prerequisites, corequisites,
restrictions, section attributes, bookstore link.

```
args (required): { term: string, crn: string }
```

Returns:
```json
{
  "term": "202608",
  "crn": "80001",
  "description": "...",
  "prerequisites": "...",
  "corequisites": "...",
  "restrictions": "...",
  "sectionAttributes": ["..."],
  "bookstoreUrl": "https://..."
}
```

There is no parsed textbook list — Banner only exposes a bookstore URL.

---

### `find-clemson-instructor-classes`
All sections a faculty member is teaching in a term.

```
args (required): { instructor: string, term: string }
args (optional): {
  subject: string,    // cold-term fallback only (see note)
  openOnly: boolean,
  max: number,        // default 50
  refresh: boolean
}
```

`term` accepts a code (`"202608"`) or text (`"Fall 2026"`).

**Ambiguity handling:** if the name matches more than one instructor, the
response includes `candidates` (list of full names) and an empty `sections`.
Repeat the call with the full unambiguous name.

Returns when resolved:
```json
{
  "matched": "Kern Cox",
  "sections": [/* same shape as search-clemson-classes sections */]
}
```

`subject` is only used as a cold-term fallback when no snapshot exists for
the term yet (snapshot is built after 05:00 on the first day of data). Passing
`subject` when a snapshot exists has no effect.

---

### `get-clemson-room-availability`
Busy/free blocks for a classroom derived from scheduled classes.

```
args (required): { building: string, room: string, term: string }
args (optional): {
  days: string,       // day pattern, e.g. "MW", "TR", "MWF" — default "MW"
  dayStart: string,   // HHMM, default "0800"
  dayEnd: string,     // HHMM, default "2200"
  minMinutes: number, // ignore free gaps shorter than this — default 50
  subject: string,    // cold-term fallback only (see warning)
  refresh: boolean
}
```

Returns:
```json
{
  "building": "Godfrey",
  "room": "205",
  "days": "MW",
  "busy": [{ "days": "MWF", "beginTime": "0900", "endTime": "0950", "course": "GC 1010" }],
  "free": [{ "days": "MW", "beginTime": "1000", "endTime": "1200", "durationMinutes": 120 }]
}
```

**Do not pass `subject` for room queries.** A room hosts classes from many
departments; a subject filter will undercount what is actually scheduled there.
`subject` is only a cold-term fallback.

**Ad-hoc events (25Live) are NOT included.** This tool only sees Banner-scheduled
classes.

---

### `check-schedule-conflicts`
Given a list of CRNs for a term, determine which pairs have time conflicts (same
day, overlapping minutes) and which are conflict-free. Reads the daily snapshot.

```
args (required): {
  term: string,
  crns: string[]    // e.g. ["80001", "80002", "80003"]
}
```

Returns:
```json
{
  "term": "202608",
  "crns_checked": ["80001", "80002", "80003"],
  "conflict_free": ["80003"],
  "conflicts": [{
    "crn_a": "80001",
    "crn_b": "80002",
    "day": "M",
    "overlap_start_min": 540,
    "overlap_end_min": 600
  }],
  "has_conflicts": true
}
```

`overlap_start_min` and `overlap_end_min` are minutes from midnight (e.g. 540 =
09:00). CRNs for TBA/online sections (no scheduled meeting time) are returned
in `conflict_free` because there is no time data to conflict with — they are not
guaranteed conflict-free in a calendar sense.

---

### `find-conflict-free-schedule`
Given fixed CRNs (already locked in) and candidate CRNs (under consideration),
return which candidates can be added without conflicts. Each candidate is checked
against all fixed CRNs and all other candidates.

```
args (required): {
  term: string,
  fixed_crns: string[],      // already committed
  candidate_crns: string[]   // options to evaluate
}
```

Returns:
```json
{
  "term": "202608",
  "fixed_crns": ["80001"],
  "candidates": [{
    "crn": "80002",
    "conflict_free": false,
    "conflicts": [{ "crn_a": "80001", "crn_b": "80002", "day": "M", ... }]
  }, {
    "crn": "80003",
    "conflict_free": true,
    "conflicts": []
  }],
  "conflict_free": ["80003"]
}
```

---

## Catalog server tools (`cuassistant-catalog`)

### `list-gc-catalog-years`
List available GC catalog years.

```
args:   {}    // no args
return: { years: ["2026-2027", "2025-2026", ...] }
```

Call this first before any other catalog tool to get a valid `year` string.

---

### `get-gc-program-plan`
Full semester-by-semester degree plan for a GC program.

```
args (required): { year: string }
args (optional): { name: string }   // default "Graphic Communications, BS"
```

Returns a structured plan: semesters, required courses, choice sets (pick one
from a list), requirement slots (e.g. "Lab Science"), per-semester and total
credits, and footnotes.

---

### `get-gc-requirement-rules`
Lab science, specialty area, and technical requirement rules for GC BS with
explicit course codes, total credits, and footnote text.

```
args (required): { year: string }
```

Returns:
```json
{
  "rules": [{
    "slot_type": "Specialty Area Requirement",
    "total_credits": 15,
    "explicit_courses": ["GC 3010", "GC 4050", ...],
    "raw_text": "..."
  }],
  "_source": "Clemson University Online Catalog 2026-2027"
}
```

**`slot_type` values from this tool are the required input for
`find-eligible-sections`.**

---

### `get-gc-gen-ed`
All six Clemson Gen Ed categories with minimum credits, allowed course lists,
constraint rules, and student learning outcomes.

```
args (required): { year: string }
```

Returns categories: Communication, Mathematics, Natural Sciences with Lab,
Arts and Humanities, Social Sciences, Global Challenges.

---

### `get-gc-course`
Title, credits, description, and prerequisites for one course.

```
args (required): { code: string }    // e.g. "GC 3010" or "MKTG 3010"
```

Returns:
```json
{
  "code": "GC 3010",
  "title": "...",
  "credits": 3,
  "description": "...",
  "prereq_text": "C or better in GC 1010 or GC 2010",
  "prereq_parsed": ["GC 1010", "GC 2010"],
  "_source": "..."
}
```

---

### `audit-gc-progress`
Deterministic degree audit on a sanitized progress record. Returns which
requirements are satisfied, which are partially complete, and which are open.

```
args (required): {
  completed_courses: [{ code: string, term: string, credits: number }]
}
args (optional): {
  year: string,       // catalog year — defaults to latest
  program_name: string
}
```

Returns satisfied, partial, and open requirement slots; no identity or grade
data is required (or accepted). Input is course codes + terms + credits only.

---

### `find-eligible-sections`
**The advising join tool.** Finds Banner sections offered in a given term that
fulfill a specific GC requirement slot AND are prereq-eligible for the student.
Performs a live SQL JOIN across the Banner schedule snapshot and gc_advisor.db.

```
args (required): {
  term: string,
  slot_type: string,              // from get-gc-requirement-rules
  completed_courses: string[]     // e.g. ["GC 1010", "GC 2010"]
}
args (optional): {
  program_name: string            // default "Graphic Communications, BS"
}
```

Returns:
```json
{
  "term": "202608",
  "term_description": "Fall 2026",
  "slot_type": "Specialty Area Requirement",
  "total_credits_required": 15,
  "sections": [{
    "crn": "80001",
    "subject_course": "GC 3010",
    "section": "001",
    "title": "...",
    "credit_hours": 3,
    "seats_available": 5,
    "enrollment": 25,
    "max_enrollment": 30,
    "open": true,
    "instructors": [{ "name": "Kern Cox", "email": "kcox@clemson.edu", "primary": true }],
    "meetings": [{ "days": "MWF", "beginTime": "0900", "endTime": "0950", "building": "Godfrey", "room": "205", "type": null }],
    "prereq_eligible": true,
    "prereq_text": "C or better in GC 1010"
  }],
  "_source": "Clemson University Online Catalog (gc_advisor) + Banner schedule 2026-07-15T05:02:11Z"
}
```

`prereq_eligible` is `true` when every course code in `prereq_parsed` for that
course appears in `completed_courses`. See **Known limitations** below.

---

## Standard workflows

### 1. Look up open sections for a subject

```
1. list-clemson-terms → get term code for the target semester
2. search-clemson-classes { term, subject: "GC", openOnly: true }
3. get-clemson-section-details { term, crn } for any section where full detail is needed
```

### 2. Check if a proposed schedule has conflicts

```
1. list-clemson-terms → term code
2. search-clemson-classes (or find-clemson-instructor-classes) → collect CRNs
3. check-schedule-conflicts { term, crns: [...] }
   → conflicts[] lists overlapping pairs; conflict_free[] is safe to register
```

### 3. Build a conflict-free schedule from options

```
1. Collect CRNs the student is definitely taking → fixed_crns
2. Collect CRNs for alternatives being considered → candidate_crns
3. find-conflict-free-schedule { term, fixed_crns, candidate_crns }
   → conflict_free[] contains candidates that fit; candidates[] has per-candidate detail
4. check-schedule-conflicts { term, crns: fixed_crns + [chosen_candidate] } to verify
```

### 4. Advising: find eligible sections for a requirement slot

```
1. list-gc-catalog-years → year
2. get-gc-requirement-rules { year } → note slot_type values and explicit_courses
3. list-clemson-terms → term code for next semester
4. find-eligible-sections {
     term,
     slot_type: "Specialty Area Requirement",  // from step 2
     completed_courses: ["GC 1010", "GC 2010", ...]
   }
   → sections[] filtered by offered + prereq_eligible
5. check-schedule-conflicts to verify fit with fixed schedule
```

### 5. Room availability for a meeting request

```
1. list-clemson-terms → term code
2. get-clemson-room-availability { building: "Godfrey", room: "205", term, days: "MW" }
   → free[] shows available windows; busy[] shows what is scheduled
   (Do NOT pass subject — it undercounts multi-department rooms)
```

### 6. Full advising session (audit + next semester)

```
1. list-gc-catalog-years → year
2. get-gc-program-plan { year } → full plan, identify open slots
3. audit-gc-progress { completed_courses: [...] } → which slots are open
4. get-gc-requirement-rules { year } → for specialty/technical slots: explicit_courses
5. list-clemson-terms → next term code
6. find-eligible-sections for each open requirement slot
7. build candidate set from eligible sections; find-conflict-free-schedule
8. check-schedule-conflicts on final proposed schedule to confirm
```

---

## Known limitations

### Prereq eligibility is AND-logic only
`find-eligible-sections` checks `prereq_parsed` (a flat list of course codes)
with AND: every code must appear in `completed_courses`. If the actual
prerequisite is "GC 1010 OR GC 2010", and the student has only GC 2010, the
tool will correctly return `prereq_eligible: true` only if GC 1010 is ALSO
in the list — which could wrongly report `false`. Always present `prereq_text`
to the student for OR-logic courses so they can verify manually.

### TBA/online sections have no meeting rows
Sections with no scheduled time (meeting days "TBA", or fully asynchronous
online sections) appear in `search-clemson-classes` results but have no entries
in `meetings[]`. `check-schedule-conflicts` returns them in `conflict_free`
because there is no time data to conflict — this is not a guarantee of
actual schedule compatibility.

### `startDate`/`endDate` are null in snapshot results
The Banner snapshot stores meeting times but not date ranges (first/last class
date). `search-clemson-classes` returns `startDate: null` and `endDate: null`
for snapshot-sourced results; live results (`refresh: true`) provide real dates.
For advising purposes this does not matter; for calendar-import use cases, add
`refresh: true`.

### Day ordering is MTWRFSU
Meeting days are always rendered in Monday-first order: M T W R F S U.
A MWF class returns `"days": "MWF"`, not `"FMW"` or `"WMF"`. S = Saturday,
U = Sunday.

### Snapshot lag
The daily snapshot is refreshed at ~05:00. Seat counts can be up to ~24 hours
old. For advising questions ("is this class usually offered?", "what are the
sections?") this is fine. For registration ("is there still a seat?") use
`refresh: true` or direct Banner.

### `find-eligible-sections` only works for GC programs
The ATTACH join is between the Banner schedule DB and `gc_advisor.db`. Only
programs and requirement rules loaded into `gc_advisor` are queryable. For
non-GC programs use `search-clemson-classes` with the known course codes from
`get-gc-program-plan` instead.

### `find-eligible-sections` requires a snapshot
The tool reads the per-term SQLite schedule snapshot (`state/clemson/<term>.db`).
If no snapshot exists yet for the term (e.g. a newly opened registration period
before 05:00), the tool returns an error. Workaround: call
`search-clemson-classes { term, refresh: true }` first to prime the snapshot,
then retry.
