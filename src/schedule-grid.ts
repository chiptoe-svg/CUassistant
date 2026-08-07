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

const DAY_ORDER = ["M", "T", "W", "R", "F", "S", "U"] as const;
const DAY_LABEL: Record<string, string> = {
  M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat", U: "Sun",
};
const PX_PER_HOUR = 44;
const HEADER_PX = 34;
const CAPTION_PX = 44;

function isTimed(e: ScheduleEntry): boolean {
  return !!e.days && e.startMin != null && e.endMin != null;
}

/** A timed entry that meets on at least one real grid day (M–U). An entry whose
 * `days` hold only out-of-range letters can't land in any column, so it is
 * treated as unscheduled rather than silently vanishing. */
function isGriddable(e: ScheduleEntry): boolean {
  return isTimed(e) && [...e.days].some((d) => DAY_LABEL[d]);
}

/** Used days (Mon–Fri always shown; Sat/Sun only if used) + hour-snapped bounds. */
export function gridBounds(entries: ScheduleEntry[]): { days: string[]; startMin: number; endMin: number } {
  const timed = entries.filter(isGriddable);
  const used = new Set<string>();
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of timed) {
    for (const d of e.days) if (DAY_LABEL[d]) used.add(d);
    lo = Math.min(lo, e.startMin as number);
    hi = Math.max(hi, e.endMin as number);
  }
  const base = ["M", "T", "W", "R", "F"];
  const days = DAY_ORDER.filter((d) => base.includes(d) || used.has(d));
  if (!Number.isFinite(lo)) return { days, startMin: 8 * 60, endMin: 17 * 60 };
  return {
    days,
    startMin: Math.floor(lo / 60) * 60,
    endMin: Math.ceil(hi / 60) * 60,
  };
}

/** Which entries conflict (shared day + time overlap) and how many overlapping
 * PAIRS there are. Only timed entries participate. `pairs` counts clashes (a
 * 3-way overlap is 3 pairs), so the badge never shows a fractional count. */
function conflictInfo(entries: ScheduleEntry[]): { flagged: Set<number>; pairs: number } {
  const flagged = new Set<number>();
  let pairs = 0;
  const idx = entries.map((e, i) => i).filter((i) => isTimed(entries[i]));
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const x = entries[idx[a]];
      const y = entries[idx[b]];
      const sharedDay = [...x.days].some((d) => y.days.includes(d));
      if (!sharedDay) continue;
      if ((x.startMin as number) < (y.endMin as number) && (y.startMin as number) < (x.endMin as number)) {
        flagged.add(idx[a]);
        flagged.add(idx[b]);
        pairs++;
      }
    }
  }
  return { flagged, pairs };
}

/** Indices of entries that share a day and overlap in time. */
export function findConflicts(entries: ScheduleEntry[]): Set<number> {
  return conflictInfo(entries).flagged;
}

function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

function minLabel(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

export function scheduleGridHeightPx(view: ScheduleView): number {
  const b = gridBounds(view.entries);
  const hours = (b.endMin - b.startMin) / 60;
  return HEADER_PX + hours * PX_PER_HOUR + CAPTION_PX;
}

export function renderScheduleGrid(view: ScheduleView): string {
  const b = gridBounds(view.entries);
  const { flagged, pairs } = conflictInfo(view.entries);
  const span = b.endMin - b.startMin;
  const bodyPx = (span / 60) * PX_PER_HOUR;
  const credits = view.entries.reduce((n, e) => n + (e.credits ?? 0), 0);

  // Hour gridlines + labels.
  const hourMarks: string[] = [];
  for (let m = b.startMin; m <= b.endMin; m += 60) {
    const top = ((m - b.startMin) / span) * bodyPx;
    hourMarks.push(
      `<div class="hour" style="top:${top}px"><span>${esc(minLabel(m))}</span></div>`,
    );
  }

  // Blocks per day column.
  const columns = b.days.map((day) => {
    const blocks = view.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => isTimed(e) && e.days.includes(day))
      .map(({ e, i }) => {
        const top = (((e.startMin as number) - b.startMin) / span) * bodyPx;
        const height = (((e.endMin as number) - (e.startMin as number)) / span) * bodyPx;
        const hue = hueFor(e.colorKey ?? e.label);
        const conflict = flagged.has(i) ? " conflict" : "";
        const room = e.room ? `<div class="room">${esc(e.room)}</div>` : "";
        return `<div class="block${conflict}" style="top:${top}px;height:${Math.max(height, 16)}px;` +
          `background:hsl(${hue} 70% 92%);border-color:hsl(${hue} 55% 62%)">` +
          `<div class="code">${esc(e.label)}</div>` +
          `<div class="when">${esc(minLabel(e.startMin as number))}–${esc(minLabel(e.endMin as number))}</div>` +
          `${room}</div>`;
      })
      .join("");
    return `<div class="col"><div class="colhead">${esc(DAY_LABEL[day])}</div>` +
      `<div class="colbody" style="height:${bodyPx}px">${blocks}</div></div>`;
  }).join("");

  // Anything that can't be placed on the grid — no meeting time, or a day
  // outside M–U — is listed here rather than dropped.
  const unscheduled = view.entries.filter((e) => !isGriddable(e));
  const untimedHtml = unscheduled.length
    ? `<div class="unscheduled"><strong>Unscheduled:</strong> ` +
      unscheduled.map((e) => esc(e.label)).join(", ") + `</div>`
    : "";

  const conflictNote = pairs
    ? `<span class="warn">${pairs} conflict${pairs === 1 ? "" : "s"}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 8px; color: #1f2428; }
  @media (prefers-color-scheme: dark) { body { color: #e8eaed; } }
  .cap { font-size: 13px; margin-bottom: 6px; display: flex; gap: 10px; align-items: baseline; }
  .warn { color: #b3261e; font-weight: 700; }
  .grid { display: flex; border: 1px solid #8884; border-radius: 6px; overflow: hidden; }
  .axis { width: 52px; position: relative; border-right: 1px solid #8884; }
  .axis .pad { height: ${HEADER_PX}px; }
  .axis .body { position: relative; }
  .hour { position: absolute; left: 0; right: 0; border-top: 1px solid #8883; font-size: 10px; color: #8a9097; }
  .hour span { position: absolute; top: -6px; left: 4px; background: transparent; }
  .col { flex: 1 1 0; border-left: 1px solid #8883; position: relative; min-width: 0; }
  .colhead { height: ${HEADER_PX}px; display: flex; align-items: center; justify-content: center;
             font-weight: 650; font-size: 12px; border-bottom: 1px solid #8884; }
  .colbody { position: relative; }
  .block { position: absolute; left: 2px; right: 2px; border: 1px solid; border-radius: 5px;
           padding: 2px 4px; overflow: hidden; font-size: 11px; line-height: 1.15; color: #1f2428; }
  .block.conflict { outline: 2px solid #b3261e; }
  .block .code { font-weight: 700; }
  .block .when, .block .room { font-size: 10px; opacity: .8; }
  .unscheduled { margin-top: 8px; font-size: 12px; color: #687078; }
</style></head>
<body>
  <div class="cap"><strong>${esc(view.term)}</strong>
    <span>${view.entries.length} section${view.entries.length === 1 ? "" : "s"}, ${credits} credit${credits === 1 ? "" : "s"}</span>
    ${conflictNote}</div>
  <div class="grid">
    <div class="axis"><div class="pad"></div><div class="body" style="height:${bodyPx}px">${hourMarks.join("")}</div></div>
    ${columns}
  </div>
  ${untimedHtml}
</body></html>`;
}
