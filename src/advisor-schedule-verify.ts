// src/advisor-schedule-verify.ts
// Deterministic host-side verification of an agent-proposed schedule against
// the local Banner snapshot.
//
// parseSchedule() checks STRUCTURE. Structure is not truth: a hallucinated CRN
// in a well-formed payload renders into a clean printable document, and that
// document is the one artifact that leaves the building. A model that fabricates
// a CRN believes the CRN is correct, so asking the model to self-check inherits
// the same failure — the check has to be made by the host, against data the host
// already holds: state/clemson/<term>.db, the same snapshot the schedule tools
// read from.
//
// Failures throw. Throwing is Pi's recoverable-tool-failure path: agent-loop
// catches it, feeds the message back as an error tool result, and the model gets
// one chance to correct itself instead of the turn dying. A specific message
// naming the CRN and the field that did not match is what makes that correction
// possible — and it is far cheaper than a wrong document.

import type DatabaseType from "better-sqlite3";

import { openScheduleDb, getScheduleDbMeta } from "./clemson-schedule-db.js";
import type { ProposedSchedule, ProposedSection } from "./advisor-artifacts.js";

/**
 * A schedule that has been through host-side verification.
 *
 * `verifiedAgainst` is the snapshot's fetchedAt when every section was checked
 * against a real record, and null when no snapshot exists for the term. This
 * follows the room-capacity precedent (see clemson-room-capacity.ts): unknown is
 * represented as null and never as a confident value, because "we don't know"
 * and "we checked and it's fine" must not look the same.
 *
 * renderSchedule() takes this type rather than ProposedSchedule, so a schedule
 * that skipped verification cannot reach the template — the compiler refuses it.
 */
export interface CheckedSchedule extends ProposedSchedule {
  verifiedAgainst: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Banner stores subject_course spaceless ("GC1040"); accept "GC 1040" too. */
function normCourse(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase();
}

/** Day letters compared as a set, so "TR" and "RT" are the same claim. */
function normDays(v: string): string {
  return [...v.replace(/[^A-Za-z]/g, "").toUpperCase()].sort().join("");
}

function normLoose(v: string): string {
  return v.replace(/\s+/g, " ").trim().toUpperCase();
}

/** "1100" or "11:00" → minutes past midnight; null when not a clock time. */
function toMinutes(t: string): number | null {
  const digits = t.replace(/[^0-9]/g, "");
  if (digits.length < 3 || digits.length > 4) return null;
  const p = digits.padStart(4, "0");
  const h = Number(p.slice(0, 2));
  const m = Number(p.slice(2));
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function hhmm(mins: number): string {
  return (
    String(Math.floor(mins / 60)).padStart(2, "0") +
    String(mins % 60).padStart(2, "0")
  );
}

/**
 * 45% of the sections in a term have no meeting rows at all (online and
 * asynchronous courses). The schema still requires days/beginTime/endTime to be
 * non-empty strings, so the only truthful thing a model can put there is a
 * "no scheduled meeting" marker. Anything else is a claimed meeting time the
 * snapshot contradicts.
 */
const NO_MEETING_MARKERS = new Set([
  "TBA",
  "TBD",
  "NA",
  "N/A",
  "NONE",
  "-",
  "--",
  "ONLINE",
  "ASYNC",
  "ASYNCHRONOUS",
  "ARR",
  "ARRANGED",
]);

function isNoMeetingMarker(v: string): boolean {
  return NO_MEETING_MARKERS.has(normLoose(v));
}

// ---------------------------------------------------------------------------
// Snapshot rows
// ---------------------------------------------------------------------------

interface SnapSection {
  crn: string;
  subject_course: string;
  section: string;
  credit_hours: number | null;
}

interface SnapMeeting {
  crn: string;
  day: string;
  start_min: number | null;
  end_min: number | null;
  building: string | null;
  room: string | null;
}

/** One meeting pattern: a start/end interval and every day it is held on. */
interface MeetingGroup {
  startMin: number;
  endMin: number;
  days: Set<string>;
  buildings: Set<string>;
  rooms: Set<string>;
}

function groupMeetings(rows: SnapMeeting[]): Map<string, MeetingGroup> {
  const groups = new Map<string, MeetingGroup>();
  for (const r of rows) {
    if (r.start_min === null || r.end_min === null) continue;
    const key = `${r.start_min}:${r.end_min}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        startMin: r.start_min,
        endMin: r.end_min,
        days: new Set(),
        buildings: new Set(),
        rooms: new Set(),
      };
      groups.set(key, g);
    }
    g.days.add(r.day.toUpperCase());
    if (r.building) g.buildings.add(normLoose(r.building));
    if (r.room) g.rooms.add(normLoose(r.room));
  }
  return groups;
}

function describeGroups(groups: Map<string, MeetingGroup>): string {
  return [...groups.values()]
    .map(
      (g) =>
        `${[...g.days].sort((a, b) => "MTWRFSU".indexOf(a) - "MTWRFSU".indexOf(b)).join("")} ` +
        `${hhmm(g.startMin)}-${hhmm(g.endMin)}`,
    )
    .join(", ");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function checkSection(
  sec: ProposedSection,
  term: string,
  row: SnapSection | undefined,
  meetingRows: SnapMeeting[],
): void {
  if (!row) {
    throw new Error(
      `CRN ${sec.crn} does not exist in the ${term} schedule snapshot. ` +
        `Use only CRNs returned by the schedule tools.`,
    );
  }

  if (normCourse(sec.subjectCourse) !== normCourse(row.subject_course)) {
    throw new Error(
      `CRN ${sec.crn}: subjectCourse "${sec.subjectCourse}" does not match the ` +
        `${term} snapshot, which records "${row.subject_course}".`,
    );
  }

  if (normLoose(sec.section) !== normLoose(row.section)) {
    throw new Error(
      `CRN ${sec.crn}: section "${sec.section}" does not match the ${term} ` +
        `snapshot, which records section "${row.section}".`,
    );
  }

  // A snapshot with no credit value is unknown, not a mismatch — the same
  // reason roomCapacity() returns null instead of 0.
  if (row.credit_hours !== null) {
    if (Math.abs(sec.creditHours - row.credit_hours) > 1e-6) {
      throw new Error(
        `CRN ${sec.crn}: creditHours ${sec.creditHours} does not match the ` +
          `${term} snapshot, which records ${row.credit_hours}.`,
      );
    }
  }

  const groups = groupMeetings(meetingRows);

  if (groups.size === 0) {
    if (
      !isNoMeetingMarker(sec.days) ||
      !isNoMeetingMarker(sec.beginTime) ||
      !isNoMeetingMarker(sec.endTime)
    ) {
      throw new Error(
        `CRN ${sec.crn}: the ${term} snapshot records no meeting times for this ` +
          `section, but the schedule claims "${sec.days} ${sec.beginTime}-${sec.endTime}". ` +
          `Use TBA for sections with no scheduled meeting.`,
      );
    }
    if (sec.building !== null || sec.room !== null) {
      throw new Error(
        `CRN ${sec.crn}: the ${term} snapshot records no meeting location for ` +
          `this section, but the schedule claims ` +
          `"${sec.building ?? ""} ${sec.room ?? ""}".trim().`,
      );
    }
    return;
  }

  const begin = toMinutes(sec.beginTime);
  const end = toMinutes(sec.endTime);
  if (begin === null || end === null) {
    throw new Error(
      `CRN ${sec.crn}: meeting time "${sec.beginTime}"-"${sec.endTime}" is not a ` +
        `clock time, but the ${term} snapshot records ${describeGroups(groups)}.`,
    );
  }

  const group = groups.get(`${begin}:${end}`);
  if (!group) {
    throw new Error(
      `CRN ${sec.crn}: meeting time ${sec.beginTime}-${sec.endTime} does not match ` +
        `the ${term} snapshot, which records ${describeGroups(groups)}.`,
    );
  }

  if (normDays(sec.days) !== normDays([...group.days].join(""))) {
    throw new Error(
      `CRN ${sec.crn}: meeting days "${sec.days}" do not match the ${term} ` +
        `snapshot, which records ${describeGroups(groups)}.`,
    );
  }

  // A building or room the model supplied must be the real one. Omitting it
  // (null) is under-claiming and prints nothing — that is not a false claim.
  if (sec.building !== null && !group.buildings.has(normLoose(sec.building))) {
    throw new Error(
      `CRN ${sec.crn}: building "${sec.building}" does not match the ${term} ` +
        `snapshot, which records ` +
        `${group.buildings.size ? [...group.buildings].join(", ") : "no building"}.`,
    );
  }
  if (sec.room !== null && !group.rooms.has(normLoose(sec.room))) {
    throw new Error(
      `CRN ${sec.crn}: room "${sec.room}" does not match the ${term} snapshot, ` +
        `which records ${group.rooms.size ? [...group.rooms].join(", ") : "no room"}.`,
    );
  }
}

/**
 * Check every section of a proposed schedule against the local snapshot for its
 * term. Throws on the first mismatch, naming the CRN and the field.
 *
 * When there is no snapshot for the term the schedule is returned with
 * `verifiedAgainst: null` rather than refused — see CheckedSchedule and
 * renderSchedule, which marks such a document unverified on its face.
 */
export function verifySchedule(schedule: ProposedSchedule): CheckedSchedule {
  const db = openScheduleDb(schedule.term);
  if (!db) return { ...schedule, verifiedAgainst: null };
  try {
    return verifyAgainstDb(db, schedule);
  } finally {
    db.close();
  }
}

function verifyAgainstDb(
  db: DatabaseType.Database,
  schedule: ProposedSchedule,
): CheckedSchedule {
  const meta = getScheduleDbMeta(db);
  const crns = [...new Set(schedule.sections.map((s) => s.crn))];

  const byCrn = new Map<string, SnapSection>();
  const meetingsByCrn = new Map<string, SnapMeeting[]>();

  if (crns.length > 0) {
    const phs = crns.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT crn, subject_course, section, credit_hours
           FROM sections WHERE term = ? AND crn IN (${phs})`,
      )
      .all(schedule.term, ...crns) as SnapSection[];
    for (const r of rows) byCrn.set(r.crn, r);

    const mRows = db
      .prepare(
        `SELECT crn, day, start_min, end_min, building, room
           FROM meetings WHERE term = ? AND crn IN (${phs})`,
      )
      .all(schedule.term, ...crns) as SnapMeeting[];
    for (const m of mRows) {
      const list = meetingsByCrn.get(m.crn);
      if (list) list.push(m);
      else meetingsByCrn.set(m.crn, [m]);
    }
  }

  for (const sec of schedule.sections) {
    checkSection(
      sec,
      schedule.term,
      byCrn.get(sec.crn),
      meetingsByCrn.get(sec.crn) ?? [],
    );
  }

  return { ...schedule, verifiedAgainst: meta.fetchedAt };
}
