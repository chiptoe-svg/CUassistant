// Advisor question analytics — PRIVACY-SAFE BY CONSTRUCTION.
//
// Purpose: learn what KINDS of questions advisors ask, so we can optimize the
// deterministic tools, seed benchmarks, and write better skills. The advisor
// persona invites advisors to "describe specific students," so question text
// routinely carries names, C-IDs, and GPAs — none of which can be reliably
// redacted (names false-fire on course/instructor/building names). So the hard
// rule here is: NEVER persist the question text, the answer text, or any tool
// ARGUMENT VALUE. We store only:
//   - a coarse category LABEL from a fixed enum (computed here, text discarded),
//   - the tool NAMES the turn called and their argument KEYS (never values),
//   - per-tool outcome booleans (empty / needs_narrowing),
//   - the turn outcome, mode, tool count, and latency.
// The record is appended to an on-host JSONL under STATE_DIR — no egress, same
// posture as the feedback drop. Classification is rule-based (no model), so the
// text is never sent anywhere, on-host or off.

import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./config.js";
import { log } from "./log.js";

/** Fixed taxonomy. Anything unmatched falls to "general_advising" — the label
 *  set is closed so a stored value can never echo free text. Tune the RULES
 *  below over time; the enum is the stable contract. */
export type QuestionCategory =
  | "seat_availability"
  | "prereq_eligibility"
  | "schedule_build"
  | "degree_requirements"
  | "room_capacity"
  | "course_info"
  | "how_it_works"
  | "general_advising";

// Ordered, first-match-wins. More specific intents come first because keywords
// overlap (e.g. "plan" appears in both scheduling and degree questions).
const RULES: { category: QuestionCategory; re: RegExp }[] = [
  {
    category: "how_it_works",
    re: /how (do|does) (you|this|it)|behind the scenes|which (model|ai|llm)|what (data|model|llm)|how (current|often|fresh|up[- ]to[- ]date)|data updated/i,
  },
  {
    category: "room_capacity",
    re: /\broom\b|\bcapacit|\bbuilding\b|fit in|seats in/i,
  },
  {
    category: "seat_availability",
    re: /\bseats?\b|\bopen (seat|section)|is .*\bfull\b|spots? (left|open|available)|availab|how many .*(enrolled|left)|waitlist/i,
  },
  {
    category: "prereq_eligibility",
    re: /pre[- ]?req|prerequisite|co[- ]?req|eligib|can .*\btake\b|qualif/i,
  },
  {
    category: "schedule_build",
    re: /\bschedule\b|\bconflict|no class(es)? before|\bmorning\b|\bafternoon\b|time slot|fit .*(together|around)|\bmwf\b|\btr\b|\btth\b/i,
  },
  {
    category: "degree_requirements",
    re: /\brequire|\bdegree\b|graduat|\bcredits?\b|\bminor\b|\bcertificate\b|\bmajor\b|\baudit\b|catalog year|program plan|what .*\bneed/i,
  },
  {
    category: "course_info",
    re: /\bwhat is (gc|the)\b|descript|\babout (gc ?\d|the course)|cross[- ]list|credit hours/i,
  },
];

/** Map a question to one fixed-enum label. Runs in-memory; the text is NEVER
 *  stored or transmitted — only the returned label is persisted. */
export function classifyQuestion(text: string): QuestionCategory {
  for (const { category, re } of RULES) if (re.test(text)) return category;
  return "general_advising";
}

/** One tool call within a turn. argKeys are Object.keys of the tool input —
 *  KEYS ONLY, never values. empty/needsNarrowing are derived booleans. */
export interface TurnToolRecord {
  name: string;
  argKeys: string[];
  empty?: boolean;
  needsNarrowing?: boolean;
}

export interface RecordTurnContext {
  mode: string;
  outcome: string;
  toolLog: TurnToolRecord[];
  latencyMs: number;
}

function analyticsDir(): string {
  return process.env.ADVISOR_ANALYTICS_DIR || path.join(STATE_DIR, "analytics");
}

/**
 * Append one PII-free analytics line for a completed turn. `question` is used
 * ONLY to compute the category label and is then discarded — it is never
 * written to disk. Best-effort: any failure is logged and swallowed so
 * analytics can never break a turn. Set ADVISOR_ANALYTICS=off to disable.
 */
export function recordTurn(question: string, ctx: RecordTurnContext): void {
  if (process.env.ADVISOR_ANALYTICS === "off") return;
  try {
    const tools = ctx.toolLog.map((t) => t.name);
    const argKeys: Record<string, string[]> = {};
    for (const t of ctx.toolLog) {
      const set = (argKeys[t.name] ??= []);
      for (const k of t.argKeys) if (!set.includes(k)) set.push(k);
    }
    const record = {
      ts: new Date().toISOString(),
      mode: ctx.mode,
      category: classifyQuestion(question),
      outcome: ctx.outcome,
      tools,
      arg_keys: argKeys,
      empty_tools: ctx.toolLog.filter((t) => t.empty).map((t) => t.name),
      needs_narrowing: ctx.toolLog.some((t) => t.needsNarrowing),
      tool_count: tools.length,
      latency_ms: ctx.latencyMs,
    };
    const dir = analyticsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "turns.jsonl"), JSON.stringify(record) + "\n");
  } catch (err) {
    log.warn("advisor analytics write failed", { err: String(err) });
  }
}

/** Best-effort extraction of outcome booleans from a tool's JSON result text.
 *  Reads only structural flags (needs_narrowing, empty section lists) — the
 *  content itself is never stored. Returns {} for non-JSON or unrecognized
 *  shapes. */
export function deriveToolOutcome(resultText: string): {
  empty?: boolean;
  needsNarrowing?: boolean;
} {
  try {
    const j = JSON.parse(resultText) as Record<string, unknown>;
    const out: { empty?: boolean; needsNarrowing?: boolean } = {};
    if (j.needs_narrowing === true) out.needsNarrowing = true;
    if (
      j.total_matched === 0 ||
      j.total_matched === "0" ||
      (Array.isArray(j.sections) && j.sections.length === 0) ||
      j.has_snapshot === false
    ) {
      out.empty = true;
    }
    return out;
  } catch {
    return {};
  }
}
