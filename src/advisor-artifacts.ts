// Host-side rendering of agent-proposed schedules.
//
// "No write actions" governs systems of record - registering, mailing, calendar
// writes. It does not govern artifacts: a proposed-schedule document changes
// nothing outside the session, so it is in scope. But the agent holds only
// bridge.tools plus propose_schedule and none of them write, so an artifact
// cannot come from the agent directly - the host must render it.
//
// The structured output therefore arrives as a TOOL CALL, not a response
// format: propose_schedule's parameters ARE the schedule. That reuses the
// tool-calling path already verified working on every provider in the chain,
// instead of depending on a runner-specific structured-output mode a given
// model may not support.
//
// Three things this buys beyond preserving the sandbox: formatting is
// deterministic because a template produces it; output is validatable in a way
// a model-authored document is not; and the model decides WHAT is in the
// schedule while never deciding how the page looks.

import { readFileSync } from "node:fs";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { verifySchedule } from "./advisor-schedule-verify.js";
import type { CheckedSchedule } from "./advisor-schedule-verify.js";

export interface ProposedSection {
  crn: string;
  subjectCourse: string;
  section: string;
  title: string;
  creditHours: number;
  days: string;
  beginTime: string;
  endTime: string;
  building: string | null;
  room: string | null;
}

export interface ProposedSchedule {
  term: string;
  sections: ProposedSection[];
  notes: string | null;
}

/**
 * The schema is a file rather than a literal so the tool's advertised
 * parameters and the host's validation cannot drift apart: both read this.
 */
export const SCHEDULE_SCHEMA: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL("../schemas/advisor-schedule.schema.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const REQUIRED_STRINGS: (keyof ProposedSection)[] = [
  "crn",
  "subjectCourse",
  "section",
  "title",
  "days",
  "beginTime",
  "endTime",
];

/**
 * Validate model output into a ProposedSchedule, or throw.
 *
 * Validation lives on the host and refuses rather than repairs. A document an
 * advisor might hand to a student must not be built from output that failed
 * validation, and a "best effort" coercion is how a printed page ends up
 * claiming 33 credit hours because a model sent creditHours as a string.
 */
export function parseSchedule(raw: string): ProposedSchedule {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("schedule output could not be parsed as JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("schedule output is not an object");
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.term !== "string" || obj.term.trim() === "") {
    throw new Error("schedule output is missing term");
  }
  if (!Array.isArray(obj.sections)) {
    throw new Error("schedule output is missing sections");
  }
  if (
    obj.notes !== undefined &&
    obj.notes !== null &&
    typeof obj.notes !== "string"
  ) {
    throw new Error("schedule output has a non-text notes field");
  }

  const sections: ProposedSection[] = [];
  for (const entry of obj.sections) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("schedule output has an incomplete section: not an object");
    }
    const s = entry as Record<string, unknown>;
    for (const key of REQUIRED_STRINGS) {
      if (typeof s[key] !== "string" || (s[key] as string) === "") {
        throw new Error(`schedule output has an incomplete section: ${key}`);
      }
    }
    if (typeof s.creditHours !== "number" || !Number.isFinite(s.creditHours)) {
      throw new Error(
        "schedule output has an incomplete section: creditHours must be a number",
      );
    }
    for (const key of ["building", "room"] as const) {
      if (
        s[key] !== undefined &&
        s[key] !== null &&
        typeof s[key] !== "string"
      ) {
        throw new Error(`schedule output has an incomplete section: ${key}`);
      }
    }
    sections.push({
      crn: s.crn as string,
      subjectCourse: s.subjectCourse as string,
      section: s.section as string,
      title: s.title as string,
      creditHours: s.creditHours,
      days: s.days as string,
      beginTime: s.beginTime as string,
      endTime: s.endTime as string,
      building: (s.building as string | null | undefined) ?? null,
      room: (s.room as string | null | undefined) ?? null,
    });
  }

  return {
    term: obj.term,
    notes: (obj.notes as string | null | undefined) ?? null,
    sections,
  };
}

/**
 * Every interpolated value goes through this. Model output is untrusted: a
 * course title is a string the model chose, and it reaches a page an advisor
 * opens in a browser.
 */
function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function hhmm(t: string): string {
  return /^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : t;
}

function place(s: ProposedSection): string {
  if (!s.building) return "";
  return `${esc(s.building)} ${esc(s.room ?? "")}`.trim();
}

/**
 * Renders a CheckedSchedule, not a ProposedSchedule: the type is how the
 * compiler guarantees nothing reaches this template without having been through
 * host-side verification.
 */
export function renderSchedule(s: CheckedSchedule): string {
  const rows = s.sections
    .map(
      (x) => `    <tr>
      <td>${esc(x.subjectCourse)}-${esc(x.section)}</td>
      <td>${esc(x.title)}</td>
      <td>${esc(x.crn)}</td>
      <td>${esc(x.creditHours)} credit${x.creditHours === 1 ? "" : "s"}</td>
      <td>${esc(x.days)} ${esc(hhmm(x.beginTime))}&ndash;${esc(hhmm(x.endTime))}</td>
      <td>${place(x)}</td>
    </tr>`,
    )
    .join("\n");
  const credits = s.sections.reduce((n, x) => n + x.creditHours, 0);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proposed schedule &mdash; ${esc(s.term)}</title>
<style>
  body { font: 12pt/1.4 system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  caption { text-align: left; padding-bottom: .5rem; }
  th, td { border: 1px solid #999; padding: .4rem .6rem; text-align: left; }
  footer { margin-top: 1.5rem; font-size: 10pt; }
  .unverified { border: 3px solid #000; background: #f2f2f2; padding: .6rem .8rem;
                margin-bottom: 1rem; font-weight: bold; }
  .verified { font-size: 10pt; color: #333; margin-bottom: 1rem; }
  @media print { body { margin: 0; } button { display: none; } }
</style></head>
<body>
<h1>Proposed schedule &mdash; ${esc(s.term)}</h1>
${
  s.verifiedAgainst === null
    ? `<p class="unverified">NOT VERIFIED &mdash; no local schedule snapshot exists
for term ${esc(s.term)}, so the CRNs, times, and rooms below could not be checked
against published schedule data. Confirm every line against Banner before use.</p>`
    : `<p class="verified">CRNs, credit hours, meeting times, and rooms checked
against the published schedule snapshot fetched ${esc(s.verifiedAgainst)}.</p>`
}
<table>
  <caption>${esc(s.sections.length)} sections, ${esc(credits)} credits total</caption>
  <thead><tr><th>Course</th><th>Title</th><th>CRN</th><th>Credits</th>
  <th>Meets</th><th>Location</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
${s.notes ? `<p>${esc(s.notes)}</p>` : ""}
<footer><em>Proposed by an assistant from published schedule data. Verify before
registration; petitions and substitutions are not reflected here.</em></footer>
</body></html>`;
}

/** Anything the host can hang the current schedule off — in practice an AdvisorSession. */
export interface ScheduleHolder {
  lastSchedule?: CheckedSchedule;
}

/**
 * The ONE tool the host adds beyond bridge.tools. It still writes nothing: it
 * hands validated structured data back to the host, which does the rendering.
 *
 * Built per turn so the schedule lands on the session that asked for it.
 */
export function createProposeScheduleTool(holder: ScheduleHolder): AgentTool {
  return {
    name: "propose_schedule",
    label: "propose schedule",
    description:
      "Produce a printable proposed-schedule document for the advisor. Call " +
      "this when the advisor asks for a schedule they can print, save, hand " +
      "to a student, or download — the parameters are the schedule itself, " +
      "and the host renders the page. Use the exact CRNs, times, and rooms " +
      "returned by the schedule tools; do not invent sections — every CRN and " +
      "its course, credits, days, times, and room are checked against the " +
      "published schedule snapshot and the call is refused if they disagree. " +
      "Ordinary " +
      "answers stay prose — do not call this for discussion.",
    parameters: Type.Unsafe(SCHEDULE_SCHEMA),
    async execute(_toolCallId, params) {
      // Validation lives on the host: malformed structure is refused, never
      // rendered into something an advisor might hand to a student. Throwing is
      // how a Pi tool reports a recoverable failure — agent-loop.js catches it,
      // feeds the message back as an error tool result, and lets the model
      // correct its arguments. Nothing is stored on the way through.
      //
      // Structure first, then truth: parseSchedule refuses a malformed payload,
      // verifySchedule refuses a well-formed one whose CRNs, courses, credits,
      // times, or rooms disagree with the local snapshot. A hallucinated CRN
      // passes the first check and fails the second.
      const schedule = verifySchedule(parseSchedule(JSON.stringify(params)));
      holder.lastSchedule = schedule;
      return {
        content: [
          {
            type: "text",
            text:
              `Schedule document ready (${schedule.sections.length} sections). ` +
              (schedule.verifiedAgainst === null
                ? `No schedule snapshot exists for term ${schedule.term}, so ` +
                  `nothing on it could be verified — the document is marked ` +
                  `NOT VERIFIED and the advisor must confirm every line. `
                : `Every section was verified against the published schedule ` +
                  `snapshot. `) +
              `Tell the advisor it can be opened with the "Open proposed ` +
              `schedule" button.`,
          },
        ],
        details: schedule,
      };
    },
  };
}
