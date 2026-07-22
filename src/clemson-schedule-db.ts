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
import { roomCapacity } from "./clemson-room-capacity.js";
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
  if (!t || t.length !== 4) return null;
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
       FROM meetings WHERE term = ? AND crn IN (${phs})
         AND start_min IS NOT NULL AND end_min IS NOT NULL`,
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

  const DAY_ORDER = "MTWRFSU";
  return rows.map((row) => {
    const mgMap = meetingMap.get(row.crn);
    const meetings: ClemsonMeeting[] = mgMap
      ? [...mgMap.values()].map((mg) => ({
          days: [...mg.days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)).join(""),
          beginTime: minsToHHMM(mg.startMin),
          endTime: minsToHHMM(mg.endMin),
          building: mg.building,
          room: mg.room,
          roomCapacity: roomCapacity(mg.building, mg.room),
          startDate: null, // not stored in DB — Banner value available on live results only
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

  // subject_course is stored in Banner's spaceless form ("GC1010"), so filters
  // must match that — not "GC 1010". Subject is anchored to the alpha→digit
  // boundary via GLOB so "AS" does not also match "ASTR…" (real prefix clashes
  // exist: AS/ASTR, CH/CHE, ED/EDL, …).
  const subject = params.subject?.toUpperCase();
  if (subject && params.courseNumber) {
    conditions.push("subject_course = ?");
    bindings.push(`${subject}${params.courseNumber}`);
  } else if (subject) {
    conditions.push("subject_course GLOB ?");
    bindings.push(`${subject}[0-9]*`);
  } else if (params.courseNumber) {
    conditions.push("subject_course LIKE ?");
    bindings.push(`%${params.courseNumber}`);
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
