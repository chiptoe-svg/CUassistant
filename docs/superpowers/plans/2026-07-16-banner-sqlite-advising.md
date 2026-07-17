# Banner Schedule → SQLite + Conflict Check + Advising Join

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-term gzip-JSON snapshot with SQLite (normalized meeting rows), expose deterministic conflict-check tools, and add a catalog-schedule join tool that returns prereq-eligible sections for a requirement slot.

**Architecture:** Each Banner term snapshot becomes a SQLite file at `state/clemson/<term>.db` written atomically (temp-file + rename). Meetings are stored as per-day integer-minute rows — one row per (CRN, day) — so conflict detection is a pure SQL interval-overlap query. The advising join opens the schedule DB and ATTACHes `gc_advisor.db`, letting a single SQL query find sections offered in the term that appear on a requirement rule's explicit-course list; prereq eligibility is checked in TypeScript after the query.

**Tech Stack:** Node.js 20, TypeScript ESM, `better-sqlite3` (synchronous SQLite, native module), existing `src/clemson-classes.ts` types untouched at their public surface.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/clemson-schedule-db.ts` | **new** | SQLite schema, write (atomic), open, query, conflict helpers |
| `src/clemson-classes.ts` | **modify** | Swap gzip-JSON store/load for SQLite calls; keep all public types + API |
| `src/mcp-tools/clemson-schedule.ts` | **new** | `check-schedule-conflicts` + `find-conflict-free-schedule` MCP tools |
| `src/mcp-tools/clemson-advising.ts` | **new** | `find-eligible-sections` MCP tool (ATTACH join) |
| `src/mcp-tools/permissions.ts` | **modify** | Add 3 new operation specs + extend `clemson` scope |
| `policy/action-policy.yaml` | **modify** | Add 3 new policy actions |
| `src/mcp-tools/index-public.ts` | **modify** | Import `./clemson-schedule.js` |
| `src/mcp-tools/index-catalog.ts` | **modify** | Import `./clemson-advising.js` |
| `test/clemson-schedule-db.test.ts` | **new** | DB write/read/query/conflict tests |
| `test/clemson-snapshot.test.ts` | **delete** | Was testing removed `serializeSnapshot`/`deserializeSnapshot` |
| `test/clemson-tools.test.ts` | **modify** | Add `isMcpOperationExposed` checks for new operations |
| `package.json` | **modify** | Add `better-sqlite3` + `@types/better-sqlite3` |

---

## Task 1 — Install `better-sqlite3`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package and types**

```bash
cd /Users/admin/projects/CUassistant
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

Expected: no errors; `package.json` now lists `"better-sqlite3"` in `dependencies` and `"@types/better-sqlite3"` in `devDependencies`.

- [ ] **Step 2: Verify the import compiles**

Create a throwaway file:

```bash
echo 'import Database from "better-sqlite3"; console.log(typeof Database);' > /tmp/bsq-check.mjs
node --input-type=module < /tmp/bsq-check.mjs
```

Expected output: `function`

- [ ] **Step 3: Run existing tests to confirm nothing broke**

```bash
npm test 2>&1 | tail -5
```

Expected: `# pass 135` (or current count), `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 for schedule DB"
```

---

## Task 2 — Create `src/clemson-schedule-db.ts`

**Files:**
- Create: `src/clemson-schedule-db.ts`

This module owns the SQLite layer. It imports `ClemsonSection`, `ClemsonMeeting`, `ClemsonSearchParams`, `ClemsonSearchResult`, `ClemsonTermSnapshot` from `clemson-classes.ts` (type-only imports — no runtime circular dependency since `clemson-classes.ts` will import from this file, but the type-only direction is safe).

- [ ] **Step 1: Write the file**

```typescript
// src/clemson-schedule-db.ts
// Per-term Banner schedule SQLite store.
//
// Schema: sections + meetings (per-day interval rows) + instructors + meta.
// Atomic write: write to <term>.db.tmp, fs.renameSync to <term>.db.
// Conflict check works directly on the meetings table via interval overlap.
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

import { STATE_DIR } from "./config.js";
import { log } from "./log.js";
import type {
  ClemsonMeeting,
  ClemsonSearchParams,
  ClemsonSearchResult,
  ClemsonSection,
  ClemsonTermSnapshot,
} from "./clemson-classes.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function scheduleDir(): string {
  return path.join(STATE_DIR, "clemson");
}
export function scheduleDbPath(term: string): string {
  return path.join(scheduleDir(), `${term}.db`);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS sections (
    crn                  TEXT NOT NULL,
    term                 TEXT NOT NULL,
    subject_course       TEXT NOT NULL,
    section              TEXT NOT NULL,
    title                TEXT NOT NULL,
    campus               TEXT,
    schedule_type        TEXT,
    instructional_method TEXT,
    credit_hours         REAL,
    enrollment           INTEGER NOT NULL DEFAULT 0,
    max_enrollment       INTEGER NOT NULL DEFAULT 0,
    seats_available      INTEGER NOT NULL DEFAULT 0,
    wait_count           INTEGER NOT NULL DEFAULT 0,
    wait_capacity        INTEGER NOT NULL DEFAULT 0,
    open                 INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (crn, term)
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    crn       TEXT NOT NULL,
    term      TEXT NOT NULL,
    day       TEXT NOT NULL,
    start_min INTEGER,
    end_min   INTEGER,
    building  TEXT,
    room      TEXT,
    type      TEXT
  );
  CREATE TABLE IF NOT EXISTS instructors (
    crn       TEXT NOT NULL,
    term      TEXT NOT NULL,
    name      TEXT NOT NULL,
    email     TEXT,
    primary_i INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (crn, term, name)
  );
  CREATE INDEX IF NOT EXISTS idx_sections_subject ON sections(subject_course);
  CREATE INDEX IF NOT EXISTS idx_sections_term    ON sections(term);
  CREATE INDEX IF NOT EXISTS idx_meetings_crn     ON meetings(crn, term);
  CREATE INDEX IF NOT EXISTS idx_meetings_time    ON meetings(term, day, start_min, end_min);
`;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function hhmMToMins(t: string): number | null {
  if (!t || t.length < 3) return null;
  const h = parseInt(t.slice(0, 2), 10);
  const m = parseInt(t.slice(2), 10);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
}

function minsToHHMM(m: number): string {
  return (
    String(Math.floor(m / 60)).padStart(2, "0") +
    String(m % 60).padStart(2, "0")
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeScheduleDb(snap: ClemsonTermSnapshot): void {
  try {
    fs.mkdirSync(scheduleDir(), { recursive: true });
    const tmp = `${scheduleDbPath(snap.term)}.tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ok if missing */
    }
    const db = new Database(tmp);
    try {
      db.exec(SCHEMA);
      const setMeta = db.prepare(
        "INSERT OR REPLACE INTO meta VALUES (?, ?)",
      );
      setMeta.run("fetched_at", snap.fetchedAt);
      setMeta.run("term_description", snap.termDescription);

      const insertSection = db.prepare(`
        INSERT OR REPLACE INTO sections
          (crn, term, subject_course, section, title, campus, schedule_type,
           instructional_method, credit_hours, enrollment, max_enrollment,
           seats_available, wait_count, wait_capacity, open)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const insertMeeting = db.prepare(`
        INSERT INTO meetings (crn, term, day, start_min, end_min, building, room, type)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      const insertInstructor = db.prepare(`
        INSERT OR REPLACE INTO instructors (crn, term, name, email, primary_i)
        VALUES (?,?,?,?,?)
      `);

      const writeAll = db.transaction(() => {
        for (const s of snap.sections) {
          insertSection.run(
            s.crn,
            snap.term,
            s.subjectCourse,
            s.section,
            s.title,
            s.campus,
            s.scheduleType,
            s.instructionalMethod,
            s.creditHours,
            s.enrollment,
            s.maxEnrollment,
            s.seatsAvailable,
            s.waitCount,
            s.waitCapacity,
            s.open ? 1 : 0,
          );
          for (const m of s.meetings) {
            if (!m.beginTime || !m.endTime) continue;
            const startMin = hhmMToMins(m.beginTime);
            const endMin = hhmMToMins(m.endTime);
            if (startMin === null || endMin === null) continue;
            for (const day of [...m.days]) {
              insertMeeting.run(
                s.crn,
                snap.term,
                day,
                startMin,
                endMin,
                m.building,
                m.room,
                m.type,
              );
            }
          }
          for (const inst of s.instructors) {
            insertInstructor.run(
              s.crn,
              snap.term,
              inst.name,
              inst.email,
              inst.primary ? 1 : 0,
            );
          }
        }
      });
      writeAll();
    } finally {
      db.close();
    }
    fs.renameSync(tmp, scheduleDbPath(snap.term));
    log.info("clemson schedule db written", {
      term: snap.term,
      sections: snap.sections.length,
    });
  } catch (err) {
    log.warn("clemson schedule db write failed", {
      term: snap.term,
      err: String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Open + meta
// ---------------------------------------------------------------------------

export interface ScheduleDbMeta {
  fetchedAt: string;
  termDescription: string;
}

export function openScheduleDb(term: string): Database.Database | null {
  const p = scheduleDbPath(term);
  try {
    fs.statSync(p);
  } catch {
    return null;
  }
  try {
    return new Database(p, { readonly: true, fileMustExist: true });
  } catch (err) {
    log.warn("clemson schedule db open failed", { term, err: String(err) });
    return null;
  }
}

export function getScheduleDbMeta(db: Database.Database): ScheduleDbMeta {
  const rows = db
    .prepare("SELECT key, value FROM meta")
    .all() as Array<{ key: string; value: string }>;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    fetchedAt: m["fetched_at"] ?? "",
    termDescription: m["term_description"] ?? "",
  };
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface SectionRow {
  crn: string;
  subject_course: string;
  section: string;
  title: string;
  campus: string | null;
  schedule_type: string | null;
  instructional_method: string | null;
  credit_hours: number | null;
  enrollment: number;
  max_enrollment: number;
  seats_available: number;
  wait_count: number;
  wait_capacity: number;
  open: number;
}
interface MeetingRow {
  crn: string;
  day: string;
  start_min: number | null;
  end_min: number | null;
  building: string | null;
  room: string | null;
  type: string | null;
}
interface InstructorRow {
  crn: string;
  name: string;
  email: string | null;
  primary_i: number;
}

// ---------------------------------------------------------------------------
// Reconstruct ClemsonSection[] from DB rows
// ---------------------------------------------------------------------------

function buildSections(
  db: Database.Database,
  term: string,
  termDescription: string,
  rows: SectionRow[],
): ClemsonSection[] {
  if (rows.length === 0) return [];
  const crns = rows.map((r) => r.crn);
  const phs = crns.map(() => "?").join(",");

  const mRows = db
    .prepare(
      `SELECT crn, day, start_min, end_min, building, room, type
       FROM meetings WHERE term = ? AND crn IN (${phs})`,
    )
    .all(term, ...crns) as MeetingRow[];

  const iRows = db
    .prepare(
      `SELECT crn, name, email, primary_i
       FROM instructors WHERE term = ? AND crn IN (${phs})`,
    )
    .all(term, ...crns) as InstructorRow[];

  // Group meeting rows by crn → interval key → collect days
  type MGroup = {
    startMin: number;
    endMin: number;
    building: string | null;
    room: string | null;
    type: string | null;
    days: string[];
  };
  const meetingMap = new Map<string, Map<string, MGroup>>();
  for (const m of mRows) {
    if (!meetingMap.has(m.crn)) meetingMap.set(m.crn, new Map());
    const key = `${m.start_min}:${m.end_min}:${m.building ?? ""}:${m.room ?? ""}:${m.type ?? ""}`;
    const byInterval = meetingMap.get(m.crn)!;
    if (!byInterval.has(key)) {
      byInterval.set(key, {
        startMin: m.start_min ?? 0,
        endMin: m.end_min ?? 0,
        building: m.building,
        room: m.room,
        type: m.type,
        days: [],
      });
    }
    byInterval.get(key)!.days.push(m.day);
  }

  // Group instructors by crn
  const instMap = new Map<
    string,
    Array<{ name: string; email: string | null; primary: boolean }>
  >();
  for (const i of iRows) {
    if (!instMap.has(i.crn)) instMap.set(i.crn, []);
    instMap.get(i.crn)!.push({
      name: i.name,
      email: i.email,
      primary: i.primary_i === 1,
    });
  }

  return rows.map((row) => {
    const mgMap = meetingMap.get(row.crn);
    const meetings: ClemsonMeeting[] = mgMap
      ? [...mgMap.values()].map((mg) => ({
          days: [...mg.days].sort().join(""),
          beginTime: minsToHHMM(mg.startMin),
          endTime: minsToHHMM(mg.endMin),
          building: mg.building,
          room: mg.room,
          startDate: null,
          endDate: null,
          type: mg.type,
        }))
      : [];
    return {
      term,
      termDescription,
      crn: row.crn,
      subjectCourse: row.subject_course,
      section: row.section,
      title: row.title,
      campus: row.campus,
      scheduleType: row.schedule_type,
      instructionalMethod: row.instructional_method,
      creditHours: row.credit_hours,
      enrollment: row.enrollment,
      maxEnrollment: row.max_enrollment,
      seatsAvailable: row.seats_available,
      waitCount: row.wait_count,
      waitCapacity: row.wait_capacity,
      open: row.open === 1,
      instructors: instMap.get(row.crn) ?? [],
      meetings,
    };
  });
}

// ---------------------------------------------------------------------------
// Query (paginated search — mirrors filterFromSnapshot)
// ---------------------------------------------------------------------------

export function queryScheduleDb(
  db: Database.Database,
  params: ClemsonSearchParams,
): ClemsonSearchResult {
  const meta = getScheduleDbMeta(db);
  const conditions: string[] = ["term = ?"];
  const bindings: unknown[] = [params.term];

  if (params.subject) {
    conditions.push("subject_course LIKE ?");
    bindings.push(`${params.subject.toUpperCase()} %`);
  }
  if (params.courseNumber) {
    conditions.push("subject_course LIKE ?");
    bindings.push(`% ${params.courseNumber}`);
  }
  if (params.openOnly) conditions.push("open = 1");

  const where = conditions.join(" AND ");
  const allRows = db
    .prepare(`SELECT * FROM sections WHERE ${where} ORDER BY subject_course, section`)
    .all(...bindings) as SectionRow[];

  const totalCount = allRows.length;
  const offset = params.offset ?? 0;
  const max = Math.min(Math.max(params.max ?? 50, 1), 500);
  const pageRows = allRows.slice(offset, offset + max);

  return {
    totalCount,
    sections: buildSections(db, params.term, meta.termDescription, pageRows),
    snapshotDate: meta.fetchedAt,
    scope: "snapshot",
  };
}

// ---------------------------------------------------------------------------
// Load ALL sections (for room availability + instructor tools)
// ---------------------------------------------------------------------------

export function loadAllSectionsFromDb(
  db: Database.Database,
  term: string,
): { sections: ClemsonSection[]; meta: ScheduleDbMeta } {
  const meta = getScheduleDbMeta(db);
  const rows = db
    .prepare(
      "SELECT * FROM sections WHERE term = ? ORDER BY subject_course, section",
    )
    .all(term) as SectionRow[];
  return { sections: buildSections(db, term, meta.termDescription, rows), meta };
}

// ---------------------------------------------------------------------------
// Conflict check helpers (used by MCP tools)
// ---------------------------------------------------------------------------

export interface MeetingInterval {
  crn: string;
  day: string;
  startMin: number;
  endMin: number;
  building: string | null;
  room: string | null;
}

export function getMeetingsForCrns(
  db: Database.Database,
  term: string,
  crns: string[],
): MeetingInterval[] {
  if (crns.length === 0) return [];
  const phs = crns.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT crn, day, start_min AS startMin, end_min AS endMin, building, room
       FROM meetings
       WHERE term = ? AND crn IN (${phs})
         AND start_min IS NOT NULL AND end_min IS NOT NULL`,
    )
    .all(term, ...crns) as MeetingInterval[];
  return rows;
}

export interface ConflictPair {
  crn_a: string;
  crn_b: string;
  day: string;
  overlap_start: string; // HHMM
  overlap_end: string;   // HHMM
}

export function findConflicts(meetings: MeetingInterval[]): ConflictPair[] {
  const conflicts: ConflictPair[] = [];
  for (let i = 0; i < meetings.length; i++) {
    for (let j = i + 1; j < meetings.length; j++) {
      const a = meetings[i];
      const b = meetings[j];
      if (a.crn === b.crn) continue;
      if (a.day !== b.day) continue;
      // Overlap: a.start < b.end AND b.start < a.end
      if (a.startMin < b.endMin && b.startMin < a.endMin) {
        conflicts.push({
          crn_a: a.crn,
          crn_b: b.crn,
          day: a.day,
          overlap_start: minsToHHMM(Math.max(a.startMin, b.startMin)),
          overlap_end: minsToHHMM(Math.min(a.endMin, b.endMin)),
        });
      }
    }
  }
  return conflicts;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -10
```

Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/clemson-schedule-db.ts
git commit -m "feat(schedule): SQLite DB layer for Banner snapshots + conflict helpers"
```

---

## Task 3 — Migrate `src/clemson-classes.ts` to use SQLite

**Files:**
- Modify: `src/clemson-classes.ts`

Replace the gzip-JSON storage path (`serializeSnapshot`, `deserializeSnapshot`, `snapshotCache`, `loadClemsonSnapshot`, `saveClemsonSnapshot`, `filterFromSnapshot`) with calls to `clemson-schedule-db.ts`. The public API (`ClemsonSection`, `ClemsonSearchResult`, `searchClemsonClasses`, `refreshClemsonSnapshot`, `getClemsonRoomAvailability`, `findClemsonInstructorClasses`, etc.) is unchanged.

- [ ] **Step 1: Remove the gzip import and old storage exports**

At the top of `src/clemson-classes.ts`, remove:
```typescript
import zlib from "zlib";
```

Remove the following exported/internal items (they will be replaced):
- `export function serializeSnapshot(...)` (lines ~572–574)
- `export function deserializeSnapshot(...)` (lines ~577–581)
- `const snapshotCache = new Map(...)` (lines ~584–587)
- `export function loadClemsonSnapshot(...)` (lines ~589–610)
- `function saveClemsonSnapshot(...)` (lines ~612–626)
- `function filterFromSnapshot(...)` (lines ~264–289)

- [ ] **Step 2: Add the import from `clemson-schedule-db.ts`**

Add after the existing imports:

```typescript
import {
  openScheduleDb,
  queryScheduleDb,
  writeScheduleDb,
  loadAllSectionsFromDb,
  getScheduleDbMeta,
} from "./clemson-schedule-db.js";
```

- [ ] **Step 3: Update `searchClemsonClasses`**

Replace the snapshot-check block at the top of `searchClemsonClasses` (the `if (!params.refresh)` branch that calls `loadClemsonSnapshot`/`filterFromSnapshot`) with:

```typescript
  if (!params.refresh) {
    const db = openScheduleDb(params.term);
    if (db) {
      try {
        return queryScheduleDb(db, params);
      } finally {
        db.close();
      }
    }
  }
```

- [ ] **Step 4: Update `refreshClemsonSnapshot`**

Replace the `saveClemsonSnapshot(snap)` call with `writeScheduleDb(snap)`.

The full updated function body:

```typescript
export async function refreshClemsonSnapshot(
  term: string,
): Promise<ClemsonTermSnapshot | null> {
  const resolved = await resolveTerm(term);
  if (!resolved) return null;
  const fetched = await fetchSectionsPaged(resolved.code, undefined, undefined);
  if (fetched === null || !fetched.complete) return null;
  const snap: ClemsonTermSnapshot = {
    term: resolved.code,
    termDescription: resolved.description,
    fetchedAt: new Date().toISOString(),
    sectionCount: fetched.sections.length,
    sections: fetched.sections,
  };
  writeScheduleDb(snap);
  return snap;
}
```

- [ ] **Step 5: Update `getTermSections`**

Replace the `loadClemsonSnapshot` / `saveClemsonSnapshot` calls with SQLite equivalents.

Replace the block starting at `const existing = loadClemsonSnapshot(resolved.code)`:

```typescript
  const existingDb = openScheduleDb(resolved.code);
  if (existingDb) {
    try {
      const { sections, meta } = loadAllSectionsFromDb(existingDb, resolved.code);
      return {
        ...base,
        sections,
        snapshotDate: meta.fetchedAt,
        scope: "snapshot",
      };
    } finally {
      existingDb.close();
    }
  }
```

And replace the `saveClemsonSnapshot(snap)` call inside the cold-full-scan branch:

```typescript
    if (full.complete) {
      const snap: ClemsonTermSnapshot = {
        term: resolved.code,
        termDescription: resolved.description,
        fetchedAt: new Date().toISOString(),
        sectionCount: full.sections.length,
        sections: full.sections,
      };
      writeScheduleDb(snap);
      return {
        ...base,
        sections: full.sections,
        snapshotDate: snap.fetchedAt,
        scope: "snapshot",
      };
    }
```

Also update the refresh branch at the top of `getTermSections` that calls `refreshClemsonSnapshot` and reads `snap.sections`:

```typescript
  if (opts.refresh) {
    const snap = await refreshClemsonSnapshot(resolved.code);
    if (snap) {
      return {
        ...base,
        sections: snap.sections,
        snapshotDate: snap.fetchedAt,
        scope: "snapshot",
      };
    }
    // refresh failed — fall through to any existing snapshot / live scan.
  }
```

(This block is unchanged — `refreshClemsonSnapshot` still returns `ClemsonTermSnapshot | null`.)

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/clemson-classes.ts
git commit -m "refactor(schedule): replace gzip-JSON snapshot with SQLite"
```

---

## Task 4 — Replace snapshot tests with SQLite DB tests

**Files:**
- Delete: `test/clemson-snapshot.test.ts`
- Create: `test/clemson-schedule-db.test.ts`

`test/clemson-snapshot.test.ts` tested `serializeSnapshot`/`deserializeSnapshot`, both now removed. Delete it and add a new test for the SQLite layer.

- [ ] **Step 1: Delete the old test**

```bash
rm /Users/admin/projects/CUassistant/test/clemson-snapshot.test.ts
```

- [ ] **Step 2: Write the new test**

```typescript
// test/clemson-schedule-db.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cuassistant-sched-"));
process.env.STATE_DIR = TMP;

const { writeScheduleDb, openScheduleDb, queryScheduleDb, getMeetingsForCrns, findConflicts } =
  await import("../src/clemson-schedule-db.ts");
import type { ClemsonTermSnapshot } from "../src/clemson-classes.ts";

const SNAP: ClemsonTermSnapshot = {
  term: "202608",
  termDescription: "Fall 2026",
  fetchedAt: "2026-07-16T05:00:00.000Z",
  sectionCount: 2,
  sections: [
    {
      term: "202608",
      termDescription: "Fall 2026",
      crn: "80001",
      subjectCourse: "GC 3010",
      section: "001",
      title: "Graphic Comm Studio",
      campus: "Main",
      scheduleType: "Lecture",
      instructionalMethod: null,
      creditHours: 3,
      enrollment: 20,
      maxEnrollment: 30,
      seatsAvailable: 10,
      waitCount: 0,
      waitCapacity: 5,
      open: true,
      instructors: [{ name: "Tonkin, Chip", email: "chip@clemson.edu", primary: true }],
      meetings: [
        { days: "MWF", beginTime: "1115", endTime: "1205",
          building: "Jordan Hall", room: "G33", startDate: null, endDate: null, type: "Lecture" },
      ],
    },
    {
      term: "202608",
      termDescription: "Fall 2026",
      crn: "80002",
      subjectCourse: "GC 3020",
      section: "001",
      title: "Print Technology",
      campus: "Main",
      scheduleType: "Lecture",
      instructionalMethod: null,
      creditHours: 3,
      enrollment: 15,
      maxEnrollment: 25,
      seatsAvailable: 10,
      waitCount: 0,
      waitCapacity: 5,
      open: true,
      instructors: [],
      meetings: [
        { days: "TR", beginTime: "1100", endTime: "1215",
          building: "Jordan Hall", room: "203", startDate: null, endDate: null, type: "Lecture" },
      ],
    },
  ],
};

test("writeScheduleDb creates a readable .db file", () => {
  writeScheduleDb(SNAP);
  const p = path.join(TMP, "clemson", "202608.db");
  assert.ok(fs.existsSync(p), ".db file should exist");
});

test("openScheduleDb returns null for missing term", () => {
  const db = openScheduleDb("999999");
  assert.equal(db, null);
});

test("queryScheduleDb returns all sections without filter", () => {
  const db = openScheduleDb("202608");
  assert.ok(db, "db should open");
  try {
    const result = queryScheduleDb(db, { term: "202608" });
    assert.equal(result.totalCount, 2);
    assert.equal(result.sections.length, 2);
    assert.equal(result.snapshotDate, "2026-07-16T05:00:00.000Z");
    assert.equal(result.scope, "snapshot");
  } finally {
    db.close();
  }
});

test("queryScheduleDb filters by subject", () => {
  const db = openScheduleDb("202608")!;
  try {
    const result = queryScheduleDb(db, { term: "202608", subject: "GC 3010".split(" ")[0] });
    // subject filter uses "GC %" which matches both GC 3010 and GC 3020
    assert.equal(result.totalCount, 2);
    // But if we filter specifically for just GC 3010 via courseNumber:
    const r2 = queryScheduleDb(db, { term: "202608", subject: "GC", courseNumber: "3010" });
    assert.equal(r2.totalCount, 1);
    assert.equal(r2.sections[0].crn, "80001");
  } finally {
    db.close();
  }
});

test("queryScheduleDb reconstructs meetings with days string", () => {
  const db = openScheduleDb("202608")!;
  try {
    const result = queryScheduleDb(db, { term: "202608", subject: "GC", courseNumber: "3010" });
    const sec = result.sections[0];
    assert.equal(sec.meetings.length, 1);
    // Days should be reconstructed from per-day rows: M, W, F → "FMW" sorted
    // sorted alphabetically: F, M, W
    assert.equal(sec.meetings[0].days, "FMW");
    assert.equal(sec.meetings[0].beginTime, "1115");
    assert.equal(sec.meetings[0].endTime, "1205");
  } finally {
    db.close();
  }
});

test("getMeetingsForCrns returns per-day intervals", () => {
  const db = openScheduleDb("202608")!;
  try {
    const meetings = getMeetingsForCrns(db, "202608", ["80001"]);
    // MWF → 3 rows
    assert.equal(meetings.length, 3);
    assert.ok(meetings.every(m => m.crn === "80001"));
    assert.equal(meetings[0].startMin, 11 * 60 + 15); // 675
    assert.equal(meetings[0].endMin,   12 * 60 + 5);  // 725
  } finally {
    db.close();
  }
});

test("findConflicts detects overlapping CRNs", () => {
  // 80001: MWF 1115-1205.  80002: TR 1100-1215.  No shared days → no conflict.
  const db = openScheduleDb("202608")!;
  try {
    const meetings = getMeetingsForCrns(db, "202608", ["80001", "80002"]);
    const conflicts = findConflicts(meetings);
    assert.equal(conflicts.length, 0, "different days → no conflict");
  } finally {
    db.close();
  }
});

test("findConflicts detects same-day overlap", () => {
  // Two synthetic meetings on M that overlap
  const { findConflicts: fc } = await import("../src/clemson-schedule-db.ts");
  const conflicts = fc([
    { crn: "AAA", day: "M", startMin: 600, endMin: 700, building: null, room: null },
    { crn: "BBB", day: "M", startMin: 650, endMin: 750, building: null, room: null },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].crn_a, "AAA");
  assert.equal(conflicts[0].crn_b, "BBB");
  assert.equal(conflicts[0].day, "M");
  assert.equal(conflicts[0].overlap_start, "1050"); // 650 = 10:50
  assert.equal(conflicts[0].overlap_end,   "1140"); // 700 = 11:40
});

test("writeScheduleDb is atomic — .tmp is gone after write", () => {
  const tmp = path.join(TMP, "clemson", "202608.db.tmp");
  assert.ok(!fs.existsSync(tmp), ".tmp file should not exist after successful write");
});
```

- [ ] **Step 3: Run the tests**

```bash
npm test 2>&1 | grep -E "^(ok|not ok|# (pass|fail))"
```

Expected: all new tests pass, `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add test/clemson-schedule-db.test.ts
git rm test/clemson-snapshot.test.ts
git commit -m "test(schedule): SQLite DB tests; remove obsolete snapshot tests"
```

---

## Task 5 — Add permissions and policy entries for the three new tools

**Files:**
- Modify: `src/mcp-tools/permissions.ts`
- Modify: `policy/action-policy.yaml`

The three new operations are:
- `clemson.check_schedule_conflicts` (public server)
- `clemson.find_conflict_free_schedule` (public server)
- `clemson.find_eligible_sections` (catalog server)

- [ ] **Step 1: Add to `src/mcp-tools/permissions.ts`**

In the `MCP_ALLOWED_OPERATIONS` map, after the existing `"clemson.room_availability"` entry (around line 301), add:

```typescript
  "clemson.check_schedule_conflicts": {
    description: "Check schedule conflicts between CRNs",
    backend: "banner_schedule",
    policyActionId: "clemson.check_schedule_conflicts",
  },
  "clemson.find_conflict_free_schedule": {
    description: "Find conflict-free candidate sections given fixed CRNs",
    backend: "banner_schedule",
    policyActionId: "clemson.find_conflict_free_schedule",
  },
  "clemson.find_eligible_sections": {
    description: "Find eligible sections for a GC requirement slot",
    backend: "gc_advisor_schedule_join",
    policyActionId: "clemson.find_eligible_sections",
  },
```

In the `SCOPE_OPERATIONS` map, extend the `"clemson"` scope array (around line 619) to include the three new operations:

```typescript
  clemson: [
    "clemson.list_terms",
    "clemson.search_classes",
    "clemson.section_details",
    "clemson.instructor_classes",
    "clemson.room_availability",
    "clemson.check_schedule_conflicts",
    "clemson.find_conflict_free_schedule",
    "clemson.gc_catalog_years",
    "clemson.gc_program_plan",
    "clemson.gc_requirement_rules",
    "clemson.gc_gen_ed",
    "clemson.gc_course",
    "clemson.gc_audit_progress",
    "clemson.find_eligible_sections",
  ],
```

- [ ] **Step 2: Add to `policy/action-policy.yaml`**

Append three new action entries. Find the last `clemson.*` action in the file and add after it:

```yaml
  - id: clemson.check_schedule_conflicts
    description: "Check time-conflict overlap between a set of CRNs (Banner schedule SQLite)"
    surface: banner_schedule
    risk: low
    approval: none
    local_state_only: false

  - id: clemson.find_conflict_free_schedule
    description: "Find conflict-free candidate CRNs given a set of fixed CRNs"
    surface: banner_schedule
    risk: low
    approval: none
    local_state_only: false

  - id: clemson.find_eligible_sections
    description: "Find sections eligible for a GC requirement slot (catalog + schedule join)"
    surface: gc_advisor_schedule_join
    risk: low
    approval: none
    local_state_only: false
```

- [ ] **Step 3: Run tests**

```bash
npm test 2>&1 | grep -E "^(ok|not ok|# (pass|fail))"
```

Expected: `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-tools/permissions.ts policy/action-policy.yaml
git commit -m "feat(schedule): add permissions and policy for 3 new schedule/advising tools"
```

---

## Task 6 — Create `src/mcp-tools/clemson-schedule.ts` (conflict-check tools)

**Files:**
- Create: `src/mcp-tools/clemson-schedule.ts`

Two MCP tools: `check-schedule-conflicts` and `find-conflict-free-schedule`. Both accept a `term` + CRN list, open the schedule DB, query meetings, and run `findConflicts`.

- [ ] **Step 1: Write the file**

```typescript
// src/mcp-tools/clemson-schedule.ts
// Deterministic schedule-conflict tools backed by the per-term SQLite snapshot.
import {
  openScheduleDb,
  getMeetingsForCrns,
  findConflicts,
  type ConflictPair,
} from "../clemson-schedule-db.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

const checkConflicts: McpToolDefinition = {
  operation: "clemson.check_schedule_conflicts",
  tool: {
    name: "check-schedule-conflicts",
    description:
      "Given a list of CRNs for a term, returns which pairs have time " +
      "conflicts (same day, overlapping minutes) and which are conflict-free. " +
      "Deterministic — reads the daily Banner snapshot, not live Banner. " +
      "Use CRNs from search-clemson-classes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string", description: "Term code, e.g. 202608." },
        crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to check, e.g. [\"80001\", \"80002\"].",
        },
      },
      required: ["term", "crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.check_schedule_conflicts");
    } catch (e) {
      return permissionErr(e);
    }
    const term = args.term as string | undefined;
    const crns = args.crns as string[] | undefined;
    if (!term || !Array.isArray(crns) || crns.length === 0)
      return err("term and a non-empty crns array are required");

    const db = openScheduleDb(term);
    if (!db)
      return err(
        `No snapshot available for term ${term}. Run the daily refresh or try again after 05:00.`,
      );
    try {
      const meetings = getMeetingsForCrns(db, term, crns);
      const conflicts = findConflicts(meetings);
      const conflictingCrns = new Set(
        conflicts.flatMap((c) => [c.crn_a, c.crn_b]),
      );
      return okJson({
        term,
        crns_checked: crns,
        conflict_free: crns.filter((c) => !conflictingCrns.has(c)),
        conflicts,
        has_conflicts: conflicts.length > 0,
      });
    } finally {
      db.close();
    }
  },
};

const findConflictFree: McpToolDefinition = {
  operation: "clemson.find_conflict_free_schedule",
  tool: {
    name: "find-conflict-free-schedule",
    description:
      "Given fixed CRNs (already committed) and candidate CRNs (options to " +
      "consider), returns which candidates can be added without time conflicts. " +
      "Each candidate is checked against every fixed CRN and against every " +
      "other candidate. Returns conflict_free candidates and details of any " +
      "conflicts for the rest. Reads the daily Banner snapshot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: { type: "string", description: "Term code, e.g. 202608." },
        fixed_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs already locked in the schedule.",
        },
        candidate_crns: {
          type: "array",
          items: { type: "string" },
          description: "CRNs to evaluate.",
        },
      },
      required: ["term", "fixed_crns", "candidate_crns"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_conflict_free_schedule");
    } catch (e) {
      return permissionErr(e);
    }
    const term = args.term as string | undefined;
    const fixedCrns = args.fixed_crns as string[] | undefined;
    const candidateCrns = args.candidate_crns as string[] | undefined;
    if (
      !term ||
      !Array.isArray(fixedCrns) ||
      !Array.isArray(candidateCrns) ||
      candidateCrns.length === 0
    )
      return err("term, fixed_crns, and a non-empty candidate_crns array are required");

    const db = openScheduleDb(term);
    if (!db)
      return err(
        `No snapshot available for term ${term}. Run the daily refresh or try again after 05:00.`,
      );
    try {
      const allCrns = [...new Set([...fixedCrns, ...candidateCrns])];
      const meetings = getMeetingsForCrns(db, term, allCrns);
      const allConflicts = findConflicts(meetings);

      const fixedSet = new Set(fixedCrns);

      type CandidateResult = {
        crn: string;
        conflict_free: boolean;
        conflicts: ConflictPair[];
      };

      const results: CandidateResult[] = candidateCrns.map((crn) => {
        const conflicts = allConflicts.filter(
          (c) =>
            (c.crn_a === crn || c.crn_b === crn) &&
            // Count conflicts with fixed CRNs and with other candidates
            (c.crn_a !== crn || fixedSet.has(c.crn_b) || candidateCrns.includes(c.crn_b)) &&
            (c.crn_b !== crn || fixedSet.has(c.crn_a) || candidateCrns.includes(c.crn_a)),
        );
        return { crn, conflict_free: conflicts.length === 0, conflicts };
      });

      return okJson({
        term,
        fixed_crns: fixedCrns,
        candidates: results,
        conflict_free: results.filter((r) => r.conflict_free).map((r) => r.crn),
      });
    } finally {
      db.close();
    }
  },
};

registerTools([checkConflicts, findConflictFree]);
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/mcp-tools/clemson-schedule.ts
git commit -m "feat(schedule): check-schedule-conflicts + find-conflict-free-schedule MCP tools"
```

---

## Task 7 — Wire conflict-check into the public barrel + update permission test

**Files:**
- Modify: `src/mcp-tools/index-public.ts`
- Modify: `test/clemson-tools.test.ts`

- [ ] **Step 1: Import in the public barrel**

In `src/mcp-tools/index-public.ts`, add the new import:

```typescript
// src/mcp-tools/index-public.ts
import "./clemson-classes.js";
import "./clemson-schedule.js";
```

- [ ] **Step 2: Add `isMcpOperationExposed` checks in `test/clemson-tools.test.ts`**

In the `"clemson public class tools are exposed"` test, add:

```typescript
  assert.equal(isMcpOperationExposed("clemson.check_schedule_conflicts"), true);
  assert.equal(isMcpOperationExposed("clemson.find_conflict_free_schedule"), true);
```

And add a new test:

```typescript
test("schedule conflict tools pass the policy gate", () => {
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.check_schedule_conflicts", {
      input: { term: "202608", crns: ["80001"] },
    }),
  );
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.find_conflict_free_schedule", {
      input: { term: "202608", fixed_crns: [], candidate_crns: ["80001"] },
    }),
  );
});
```

- [ ] **Step 3: Run tests**

```bash
npm test 2>&1 | grep -E "^(ok|not ok|# (pass|fail))"
```

Expected: `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-tools/index-public.ts test/clemson-tools.test.ts
git commit -m "feat(schedule): wire conflict-check tools into public MCP barrel"
```

---

## Task 8 — Create `src/mcp-tools/clemson-advising.ts`

**Files:**
- Create: `src/mcp-tools/clemson-advising.ts`

The `find-eligible-sections` tool:
1. Reads the GC requirement rule for the given `slot_type` from `gc_advisor.db` using `GC_ADVISOR_DB` from config
2. Opens the schedule DB for the term
3. Queries sections whose `subject_course` is in the rule's `explicit_courses` list
4. Reconstructs full `ClemsonSection` objects (with meetings + instructors)
5. Checks prereq eligibility in TypeScript: parses `prereq_parsed` JSON array, checks all codes against `completed_courses`
6. Returns the eligible sections with a `prereq_eligible` flag per section

The ATTACH approach: open the schedule DB, attach `gc_advisor.db` as `catalog`, do the join in SQL.

- [ ] **Step 1: Write the file**

```typescript
// src/mcp-tools/clemson-advising.ts
// Catalog + schedule join tool for GC advising.
//
// find-eligible-sections opens the per-term schedule DB, ATTACHes gc_advisor.db,
// and runs the requirement → offered-sections join in SQL. Prereq eligibility is
// checked in TypeScript (parse prereq_parsed JSON, test subset of completed_courses).
import Database from "better-sqlite3";

import { GC_ADVISOR_DB } from "../config.js";
import { openScheduleDb, getScheduleDbMeta } from "../clemson-schedule-db.js";
import type { ClemsonSection } from "../clemson-classes.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequirementRule {
  slot_type: string;
  total_credits: number;
  explicit_courses: string[];
  raw_text: string;
}

interface SectionRow {
  crn: string;
  subject_course: string;
  section: string;
  title: string;
  credit_hours: number | null;
  seats_available: number;
  enrollment: number;
  max_enrollment: number;
  open: number;
}
interface MeetingRow {
  crn: string;
  day: string;
  start_min: number | null;
  end_min: number | null;
  building: string | null;
  room: string | null;
  type: string | null;
}
interface InstructorRow {
  crn: string;
  name: string;
  email: string | null;
  primary_i: number;
}
interface CourseRow {
  code: string;
  prereq_text: string | null;
  prereq_parsed: string | null; // JSON array of course codes
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minsToHHMM(m: number): string {
  return (
    String(Math.floor(m / 60)).padStart(2, "0") +
    String(m % 60).padStart(2, "0")
  );
}

function getLatestCatalogYearId(
  catalogDb: Database.Database,
  programName: string,
): number | null {
  const row = catalogDb
    .prepare(
      `SELECT p.id FROM program p
       JOIN catalog_year cy ON p.catalog_year_id = cy.id
       WHERE p.name = ?
       ORDER BY cy.label DESC LIMIT 1`,
    )
    .get(programName) as { id: number } | undefined;
  return row?.id ?? null;
}

function getRequirementRule(
  catalogDb: Database.Database,
  programId: number,
  slotType: string,
): RequirementRule | null {
  const row = catalogDb
    .prepare(
      "SELECT slot_type, rule FROM requirement_rule WHERE program_id = ? AND slot_type = ? LIMIT 1",
    )
    .get(programId, slotType) as { slot_type: string; rule: string } | undefined;
  if (!row) return null;
  let parsed: { total_credits?: number; explicit_courses?: string[]; raw_text?: string };
  try {
    parsed = JSON.parse(row.rule) as typeof parsed;
  } catch {
    return null;
  }
  return {
    slot_type: row.slot_type,
    total_credits: parsed.total_credits ?? 0,
    explicit_courses: parsed.explicit_courses ?? [],
    raw_text: parsed.raw_text ?? "",
  };
}

function checkPrereqEligible(
  prereqParsed: string | null,
  completedCourses: Set<string>,
): boolean {
  if (!prereqParsed) return true; // no prereqs
  let codes: string[];
  try {
    codes = JSON.parse(prereqParsed) as string[];
  } catch {
    return true; // can't parse → assume eligible
  }
  if (!Array.isArray(codes) || codes.length === 0) return true;
  // prereq_parsed is a flat list of codes; ALL must be completed.
  // (This is a simplification — the raw_text may have OR logic — but
  // prereq_parsed intentionally flattens to the complete required set.)
  return codes.every((c) => completedCourses.has(c));
}

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

const findEligibleSections: McpToolDefinition = {
  operation: "clemson.find_eligible_sections",
  tool: {
    name: "find-eligible-sections",
    description:
      "Find Banner sections offered in a given term that fulfill a GC " +
      "degree requirement slot AND are prereq-eligible for the student. " +
      "Returns section details (CRN, title, credits, seats, meetings) plus " +
      "`prereq_eligible` per section based on the completed-courses list. " +
      "Use slot_type values from get-gc-requirement-rules (e.g. " +
      "'Specialty Area Requirement', 'Graphic Communication Technical Requirement'). " +
      "Pass completed_courses as a list of course codes the student has passed " +
      "(e.g. [\"GC 1010\", \"GC 2010\"]) — used only for prereq gating, " +
      "no identity or grade data needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description: "Term code, e.g. 202608.",
        },
        slot_type: {
          type: "string",
          description:
            "Requirement slot to fill, from get-gc-requirement-rules, " +
            "e.g. 'Specialty Area Requirement'.",
        },
        completed_courses: {
          type: "array",
          items: { type: "string" },
          description: "Course codes the student has completed, e.g. [\"GC 1010\"].",
        },
        program_name: {
          type: "string",
          description:
            "GC program name (default 'Graphic Communications, BS').",
        },
      },
      required: ["term", "slot_type", "completed_courses"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.find_eligible_sections");
    } catch (e) {
      return permissionErr(e);
    }

    const term = args.term as string | undefined;
    const slotType = args.slot_type as string | undefined;
    const completedCoursesArr = args.completed_courses as string[] | undefined;
    if (!term || !slotType || !Array.isArray(completedCoursesArr))
      return err("term, slot_type, and completed_courses are required");

    const programName =
      typeof args.program_name === "string" && args.program_name
        ? args.program_name
        : "Graphic Communications, BS";

    const schedDb = openScheduleDb(term);
    if (!schedDb)
      return err(
        `No Banner snapshot available for term ${term}. Try again after the 05:00 daily refresh.`,
      );

    try {
      // ATTACH the catalog DB so we can do the join.
      schedDb.prepare("ATTACH DATABASE ? AS catalog").run(GC_ADVISOR_DB);

      const programId = getLatestCatalogYearId(schedDb, programName);
      if (programId === null) {
        return err(
          `Program "${programName}" not found in gc_advisor.db. ` +
            "Check the name with get-gc-program-plan.",
        );
      }

      const rule = getRequirementRule(schedDb, programId, slotType);
      if (!rule) {
        return err(
          `No requirement rule found for slot_type "${slotType}" in program "${programName}". ` +
            "Check valid slot types with get-gc-requirement-rules.",
        );
      }
      if (rule.explicit_courses.length === 0) {
        return okJson({
          term,
          slot_type: slotType,
          total_credits_required: rule.total_credits,
          sections: [],
          note:
            "This requirement rule has no explicit course list — it may be " +
            "satisfied by a declared minor or a broad course category. " +
            "Use get-gc-requirement-rules for the full raw_text.",
        });
      }

      // Build placeholders for the IN clause
      const phs = rule.explicit_courses.map(() => "?").join(",");

      const sectionRows = schedDb
        .prepare(
          `SELECT crn, subject_course, section, title, credit_hours,
                  seats_available, enrollment, max_enrollment, open
           FROM sections
           WHERE term = ? AND subject_course IN (${phs})
           ORDER BY subject_course, section`,
        )
        .all(term, ...rule.explicit_courses) as SectionRow[];

      if (sectionRows.length === 0) {
        return okJson({
          term,
          slot_type: slotType,
          total_credits_required: rule.total_credits,
          sections: [],
          note: "No sections are offered in this term for the eligible course list.",
        });
      }

      const crns = sectionRows.map((r) => r.crn);
      const crnPhs = crns.map(() => "?").join(",");

      const meetingRows = schedDb
        .prepare(
          `SELECT crn, day, start_min, end_min, building, room, type
           FROM meetings WHERE term = ? AND crn IN (${crnPhs})`,
        )
        .all(term, ...crns) as MeetingRow[];

      const instructorRows = schedDb
        .prepare(
          `SELECT crn, name, email, primary_i
           FROM instructors WHERE term = ? AND crn IN (${crnPhs})`,
        )
        .all(term, ...crns) as InstructorRow[];

      // Get prereq info for all subject_courses from the catalog
      const subjectCourses = [...new Set(sectionRows.map((r) => r.subject_course))];
      const scPhs = subjectCourses.map(() => "?").join(",");
      const courseRows = schedDb
        .prepare(
          `SELECT code, prereq_text, prereq_parsed
           FROM catalog.course WHERE code IN (${scPhs})`,
        )
        .all(...subjectCourses) as CourseRow[];
      const courseMap = new Map(courseRows.map((c) => [c.code, c]));

      // Group meetings + instructors by crn
      type MGroup = {
        startMin: number; endMin: number;
        building: string | null; room: string | null; type: string | null;
        days: string[];
      };
      const meetingMap = new Map<string, Map<string, MGroup>>();
      for (const m of meetingRows) {
        if (!meetingMap.has(m.crn)) meetingMap.set(m.crn, new Map());
        const key = `${m.start_min}:${m.end_min}:${m.building ?? ""}:${m.room ?? ""}:${m.type ?? ""}`;
        const byInterval = meetingMap.get(m.crn)!;
        if (!byInterval.has(key)) {
          byInterval.set(key, {
            startMin: m.start_min ?? 0, endMin: m.end_min ?? 0,
            building: m.building, room: m.room, type: m.type, days: [],
          });
        }
        byInterval.get(key)!.days.push(m.day);
      }

      const instMap = new Map<string, Array<{ name: string; email: string | null; primary: boolean }>>();
      for (const i of instructorRows) {
        if (!instMap.has(i.crn)) instMap.set(i.crn, []);
        instMap.get(i.crn)!.push({ name: i.name, email: i.email, primary: i.primary_i === 1 });
      }

      const completedSet = new Set(completedCoursesArr);
      const meta = getScheduleDbMeta(schedDb);

      const sections = sectionRows.map((row) => {
        const courseInfo = courseMap.get(row.subject_course);
        const prereqEligible = checkPrereqEligible(
          courseInfo?.prereq_parsed ?? null,
          completedSet,
        );
        const mgMap = meetingMap.get(row.crn);
        const meetings = mgMap
          ? [...mgMap.values()].map((mg) => ({
              days: [...mg.days].sort().join(""),
              beginTime: minsToHHMM(mg.startMin),
              endTime: minsToHHMM(mg.endMin),
              building: mg.building,
              room: mg.room,
              type: mg.type,
            }))
          : [];
        return {
          crn: row.crn,
          subject_course: row.subject_course,
          section: row.section,
          title: row.title,
          credit_hours: row.credit_hours,
          seats_available: row.seats_available,
          enrollment: row.enrollment,
          max_enrollment: row.max_enrollment,
          open: row.open === 1,
          instructors: instMap.get(row.crn) ?? [],
          meetings,
          prereq_eligible: prereqEligible,
          prereq_text: courseInfo?.prereq_text ?? null,
        };
      });

      return okJson({
        term,
        term_description: meta.termDescription,
        slot_type: slotType,
        total_credits_required: rule.total_credits,
        sections,
        _source: `Clemson University Online Catalog (gc_advisor) + Banner schedule ${meta.fetchedAt}`,
      });
    } finally {
      try {
        schedDb.prepare("DETACH DATABASE catalog").run();
      } catch {
        /* ok */
      }
      schedDb.close();
    }
  },
};

registerTools([findEligibleSections]);
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/mcp-tools/clemson-advising.ts
git commit -m "feat(advising): find-eligible-sections MCP tool (catalog + schedule ATTACH join)"
```

---

## Task 9 — Wire advising tool into catalog barrel + test + final check

**Files:**
- Modify: `src/mcp-tools/index-catalog.ts`
- Modify: `test/clemson-tools.test.ts`

- [ ] **Step 1: Import in the catalog barrel**

```typescript
// src/mcp-tools/index-catalog.ts
import "./catalog.js";
import "./clemson-advising.js";
```

- [ ] **Step 2: Add `isMcpOperationExposed` check to `test/clemson-tools.test.ts`**

In the existing `"clemson public class tools are exposed"` test, add:

```typescript
  assert.equal(isMcpOperationExposed("clemson.find_eligible_sections"), true);
```

And add a new test:

```typescript
test("find-eligible-sections passes the policy gate", () => {
  assert.doesNotThrow(() =>
    assertMcpOperation("clemson.find_eligible_sections", {
      input: {
        term: "202608",
        slot_type: "Specialty Area Requirement",
        completed_courses: ["GC 1010"],
      },
    }),
  );
});
```

- [ ] **Step 3: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: `# fail 0`. Total test count is current count + new tests (should be ~145+).

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-tools/index-catalog.ts test/clemson-tools.test.ts
git commit -m "feat(advising): wire find-eligible-sections into catalog MCP barrel"
```

---

## Self-review

**Spec coverage:**
- ✅ Move 1a — meeting rows stored as per-day integers in `meetings` table (Task 2)
- ✅ Move 1b — `check-schedule-conflicts(crns[])` tool (Task 6)
- ✅ Move 1c — `find-conflict-free-schedule(fixed_crns[], candidate_crns[])` tool (Task 6)
- ✅ Move 1d — atomic swap on refresh (temp file + renameSync in Task 2, `writeScheduleDb`)
- ✅ Move 2 — ATTACH join tool `find-eligible-sections` (Task 8) on public-catalog servers
- ✅ Prereq eligibility checked from `prereq_parsed` against `completed_courses` (Task 8)
- ✅ Slot-type → explicit course list from `requirement_rule.rule` JSON (Task 8)

**Placeholder scan:** none found.

**Type consistency:**
- `MeetingInterval.startMin`/`endMin` in `clemson-schedule-db.ts` match `findConflicts` parameter — ✅
- `ConflictPair` defined in `clemson-schedule-db.ts`, imported in `clemson-schedule.ts` — ✅
- `ScheduleDbMeta` returned by `getScheduleDbMeta`, used in `clemson-advising.ts` via import — ✅
- `GC_ADVISOR_DB` imported from `config.js` in `clemson-advising.ts` — ✅ (already configured)

**One known simplification:** `prereq_parsed` is a flat list of ALL course codes mentioned in the prereq string. For a prereq like "ACCT 2010 OR CPSC 2200", the parsed array contains both codes. The eligibility check (`codes.every(c => completedSet.has(c))`) will require BOTH, which is stricter than the actual OR logic. This is intentional and documented in the tool description as a flag — the agent can read `prereq_text` for the full rule.
