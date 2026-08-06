// Pure schedule → weekly-grid renderer. No DOM, no network, no external assets:
// the HTML it returns is self-contained so it can be shown in a sandboxed iframe
// (inline chat), served as an export, or opened as a page. Called host-side only.

import { esc, type ProposedSection } from "./advisor-artifacts.js";
import type { CheckedSchedule } from "./advisor-schedule-verify.js";

export interface ScheduleEntry {
  label: string;        // e.g. "GC 1010 001"
  title?: string;
  days: string;         // "MWF"; "" = untimed
  startMin?: number;    // minutes since midnight; undefined = untimed
  endMin?: number;
  room?: string;
  credits?: number;
  colorKey?: string;    // stable hue seed (subject) so a course keeps its color
}
export interface ScheduleView {
  term: string;
  entries: ScheduleEntry[];
}

/** "1430" -> 870 minutes; anything not HHMM (e.g. "TBA", "") -> null. */
export function parseHhmm(t: string): number | null {
  if (!/^\d{4}$/.test(t)) return null;
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
}

function roomOf(s: ProposedSection): string | undefined {
  if (!s.building) return undefined;
  return `${s.building} ${s.room ?? ""}`.trim();
}

export function checkedScheduleToView(s: CheckedSchedule): ScheduleView {
  return {
    term: s.term,
    entries: s.sections.map((sec) => {
      const startMin = parseHhmm(sec.beginTime);
      const endMin = parseHhmm(sec.endTime);
      const entry: ScheduleEntry = {
        label: `${sec.subjectCourse} ${sec.section}`,
        title: sec.title,
        days: sec.days,
        room: roomOf(sec),
        credits: sec.creditHours,
        colorKey: sec.subjectCourse.split(" ")[0] || sec.subjectCourse,
      };
      if (startMin != null) entry.startMin = startMin;
      if (endMin != null) entry.endMin = endMin;
      return entry;
    }),
  };
}
