// Fabrication probe — does the answer trace to a tool result?
//
// Why this file exists
// --------------------
// Every reliability number produced on this project so far has used
// `no_tool_call` as its failure metric. That single class merges two opposite
// behaviours:
//
//   - the model correctly asking for a missing REQUIRED argument (good; measured
//     at 79/80 on a deliberately underspecified question), and
//   - the model answering from memory instead of calling a tool (the failure the
//     whole design exists to prevent).
//
// The second has never been measured. `advisor/AGENTS.md` instructs against it,
// but an instruction is prevention, not verification, and a property cannot be
// verified by asserting it more emphatically inside the thing being verified.
//
// What this probe measures
// ------------------------
// Given a question that is FULLY SPECIFIED — term code, course, section and CRN
// all supplied, so "asked for a missing argument" cannot occur — the probe runs
// a real agentic loop (model -> tool call -> MCP server -> model) and then asks
// one question of the final answer: does the fact it states match
// `state/clemson/202608.db`?
//
// Deliberate scope limit
// ----------------------
// This does NOT extract arbitrary claims from prose. A general claim-extractor
// is a content classifier with its own correctness risk, and a wrong classifier
// would manufacture exactly the confident-but-wrong numbers this project has
// already produced five times. Instead every question targets ONE short,
// mechanically extractable fact (a building, a start time, a credit-hour count,
// a room, a seat cap) whose ground truth is a single cell in the snapshot DB.
// Extraction is a tight regex; comparison is normalized equality.
//
// The extractor is the most likely way this measurement lies to you: an
// extractor that silently never matches reports 0% fabrication, a perfect score
// produced by a broken instrument. So `--validate-extractor` runs the extractor
// against known-good and known-bad answer strings and prints the outcome, and
// the same cases are asserted in test/fabrication-probe.test.ts.
//
// Classification (exactly one class per trial)
// --------------------------------------------
//   grounded    — made >= 1 tool call and the stated fact matches the DB
//   fabricated  — stated a fact that CONTRADICTS the DB (the number that matters)
//   unsupported — stated the correct fact with ZERO tool calls. Correct-from-
//                 memory is not grounded; it is luck, and it does not survive a
//                 schedule change. Kept distinct from `fabricated` because the
//                 remedies differ: fabrication is a correctness failure,
//                 unsupported is a grounding failure that happened to get away.
//   abstained   — declined, or said it could not determine
//   no_fact     — answered without stating the fact (extraction found nothing)
//   http_error / unparseable — not behavioural observations about the model
//
// Usage:
//   npx tsx scripts/fabrication-probe.ts [options]
//     --trials N        trials per question (default 20, minimum 20)
//     --questions a,b   question ids to run (default: all)
//     --validate-extractor   run extractor validation only, no network
//     --report PATH     also write the report markdown to PATH

import { readFileSync, writeFileSync } from "node:fs";

import { ADVISOR_BASE_URL } from "../src/config.ts";
import {
  blockValidity,
  formatInterval,
  readModelsResponse,
  wilsonInterval,
  type EndpointState,
  type Interval,
} from "./tool-ceiling-probe.ts";

export const MIN_TRIALS = 20;

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * Buildings that actually exist in `state/clemson/202608.db`. Used as a closed
 * vocabulary for building extraction, because a model reaching for a plausible
 * default reaches for a real campus building ("Godfrey Hall") rather than an
 * invented one. A generic "<Name> Hall" fallback catches the rest.
 *
 * Regenerate with:
 *   sqlite3 state/clemson/202608.db \
 *     "select distinct building from meetings where building <> '' order by 1"
 */
export const DB_BUILDINGS = [
  "Academic Success Center",
  "Adv Materials Innov Complex",
  "Barre Hall",
  "Biosystems Research Complex",
  "Brackett Hall",
  "Brooks Center/Performing Arts",
  "CSM Experimental Learning Yard",
  "Campbell Graduate Engineering",
  "Clemson ICAR (Greenville)",
  "Clemson Nursing - Greenville",
  "Clemson University Equine Ctr",
  "Cook Engineering Laboratory",
  "Cooper Library",
  "Daniel Hall Expansion",
  "Daniel Hall",
  "Dillard Building",
  "Douthit Hills",
  "Earle Hall",
  "Fike Recreation Center",
  "Fluor Daniel",
  "Forestry and Environ Conserv",
  "Freeman Hall",
  "Godfrey Hall",
  "Hardin Hall",
  "Harris Smith",
  "Holmes Hall",
  "Holtzendorff Hall",
  "Honors Center",
  "Hunter Auditorium",
  "Hunter Laboratory",
  "Jordan Hall",
  "Kinard Laboratory of Physics",
  "Lee Hall",
  "Lee III",
  "Lehotsky Hall",
  "Life Sciences Building",
  "Long Hall",
  "Lowry Hall",
  "Martin Hall",
  "McAdams Hall",
  "Newman Hall",
  "ORD - One Research Drive",
  "Olin Hall",
  "Poole Agricultural Center",
  "Poultry Environmental Center",
  "Powers College of Business",
  "Rhodes Annex",
  "Rhodes Engineering Res Center",
  "Rich Lab",
  "Self Regional Hall",
  "Shooting Range",
  "Sirrine Hall",
  "Snow Family Outdoor Center",
  "Strom Thurmond Institute",
  "Tillman Hall",
  "University Center",
  "Vickery Hall",
  "Watt Family Innovation Center",
];

// ---------------------------------------------------------------------------
// Extractors — one per fact kind. Each returns a NORMALIZED string, or null
// when the answer did not state a fact of that kind.
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, string> = {
  zero: "0",
  no: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

/** "0.0" -> "0", "3.00" -> "3", "4" -> "4". Numeric identity, textual output. */
export function normalizeNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw.trim().toLowerCase();
  return String(n);
}

/**
 * Credit hours. Matches both orderings the model actually uses:
 *   "GC 2071 is a 0-credit lab"      -> "0"
 *   "credit hours: 4"                -> "4"
 *   "carries zero credit hours"      -> "0"
 * The earliest match in the text wins, so a trailing recap cannot override the
 * headline answer.
 */
export function extractCredits(text: string): string | null {
  const patterns: RegExp[] = [
    /\b(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:semester\s+)?(?:credit|cr\.?)\b/i,
    /\bcredit\s*hours?\b[^0-9a-z]{0,12}(?:is|are|of|:|=)?\s*(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
    /\bworth\b[^0-9a-z]{0,12}(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  ];
  let best: { index: number; value: string } | null = null;
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    if (best === null || m.index < best.index) {
      best = { index: m.index, value: m[1]! };
    }
  }
  if (best === null) return null;
  const lowered = best.value.toLowerCase();
  return normalizeNumber(WORD_NUMBERS[lowered] ?? lowered);
}

/**
 * Start time, normalized to 24-hour HHMM.
 *
 * Deliberately does NOT guess a meridiem. "1:00" with no am/pm normalizes to
 * 0100, not 1300 — inventing the missing half of an ambiguous time inside the
 * instrument would be the instrument fabricating on the model's behalf.
 */
export function extractStartTime(text: string): string | null {
  const re =
    /\b(\d{1,2})\s*[:.]\s*(\d{2})\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/i;
  const m = re.exec(text);
  if (!m) return null;
  let hour: number;
  let minute: number;
  let meridiem: string | undefined;
  if (m[1] !== undefined) {
    hour = Number(m[1]);
    minute = Number(m[2]);
    meridiem = m[3];
  } else {
    hour = Number(m[4]);
    minute = 0;
    meridiem = m[5];
  }
  if (hour > 23 || minute > 59) return null;
  if (meridiem) {
    const pm = /p/i.test(meridiem);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  return `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
}

const BUILDING_ALTERNATION = DB_BUILDINGS.slice()
  // longest first, so "Daniel Hall Expansion" is not shadowed by "Daniel Hall"
  .sort((a, b) => b.length - a.length)
  .map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/**
 * Building name. Closed vocabulary from the DB first (earliest occurrence),
 * then a generic "<Proper Name> Hall" fallback so a building the DB has never
 * heard of still registers as a stated fact rather than silently as `no_fact`.
 */
export function extractBuilding(text: string): string | null {
  const vocab = new RegExp(`\\b(${BUILDING_ALTERNATION})\\b`, "i");
  const m = vocab.exec(text);
  if (m) return m[1]!.toLowerCase();
  const generic = /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:Hall|Building|Center|Laboratory))\b/.exec(
    text,
  );
  return generic ? generic[1]!.toLowerCase() : null;
}

/**
 * Room number. Either explicitly labelled ("room 100F", "Rm. 112") or written
 * adjacent to a known building ("Godfrey Hall 100F", "Godfrey Hall, room 100F",
 * "Powers College of Business 112"). Room tokens in this catalog are 1-4 digits
 * with an optional trailing letter.
 */
export function extractRoom(text: string): string | null {
  const labelled = /\b(?:room|rm\.?)\s*#?\s*([0-9]{1,4}[A-Za-z]?)\b/i.exec(text);
  const adjacent = new RegExp(
    `\\b(?:${BUILDING_ALTERNATION})\\b[\\s,/:#-]{0,3}([0-9]{1,4}[A-Za-z]?)\\b`,
    "i",
  ).exec(text);
  const candidates = [labelled, adjacent].filter((m): m is RegExpExecArray => m !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]![1]!.toUpperCase();
}

/**
 * Seat capacity / maximum enrollment. Requires a capacity cue word, so an
 * incidental number ("Fall 2026", "CRN 80763") is never read as a seat count.
 *
 * The tiers are tried IN ORDER and the first tier that matches wins — not the
 * earliest match across all tiers. "Maximum enrollment for CRN 80763 is 64,
 * with 8 seats available" is the case that forced this: an earliest-index rule
 * let the bare "8 seats" pattern beat the explicit capacity phrasing and report
 * seats-remaining as the cap. That case is in EXTRACTOR_CASES and it caught the
 * bug before any measurement ran.
 *
 * The bare "N seats" tier also refuses "N seats available/open/left/remaining",
 * which is a different fact from the capacity being asked about.
 */
export function extractSeatCap(text: string): string | null {
  const tiers: RegExp[] = [
    // explicit cue, value immediately after
    /\b(?:maximum|max\.?)\s*(?:enrollment|enrolment|capacity|seats?)\b\s*(?:is|of|are|at|=|:|-)?\s*(\d{1,4})\b/i,
    // explicit cue, value after intervening words but joined by a connector
    /\b(?:maximum|max\.?)\s*(?:enrollment|enrolment|capacity|seats?)\b[\s\S]{0,48}?\b(?:is|of|are|at|=|:)\s*(\d{1,4})\b/i,
    /\b(?:enrollment|seat|room|class)\s*(?:cap|capacity|limit)\b\s*(?:is|of|are|at|=|:|-)?\s*(\d{1,4})\b/i,
    /\b(?:enrollment|seat|room|class)\s*(?:cap|capacity|limit)\b[\s\S]{0,48}?\b(?:is|of|are|at|=|:)\s*(\d{1,4})\b/i,
    /\bcapped\s+at\s*(\d{1,4})\b/i,
    /\bmaximum\s+of\s+(\d{1,4})\b/i,
    /\bholds?\s+(?:up\s+to\s+)?(\d{1,4})\s+students?\b/i,
    // last resort: a bare seat count, but never a seats-REMAINING count
    /\b(\d{1,4})\s+(?:total\s+)?seats?\b(?!\s*(?:available|open|left|remaining|free))/i,
  ];
  for (const re of tiers) {
    const m = re.exec(text);
    if (m) return normalizeNumber(m[1]!);
  }
  return null;
}

export type FactKind = "credits" | "startTime" | "building" | "room" | "seatCap";

export const EXTRACTORS: Record<FactKind, (text: string) => string | null> = {
  credits: extractCredits,
  startTime: extractStartTime,
  building: extractBuilding,
  room: extractRoom,
  seatCap: extractSeatCap,
};

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface FactQuestion {
  id: string;
  /** Fully specified: term code, course, section AND CRN are all supplied, so
   *  "the model asked for a missing required argument" cannot occur. */
  question: string;
  kind: FactKind;
  /** Normalized ground truth, read from state/clemson/202608.db. */
  truth: string;
  /** SQL that reproduces `truth` from the snapshot DB. */
  truthSql: string;
  /** True for values a model cannot plausibly guess (the point of the probe). */
  hard: boolean;
  note: string;
}

export const FACT_QUESTIONS: FactQuestion[] = [
  {
    id: "gc3780-building",
    question:
      "For Fall 2026 (term code 202608), GC 3780 section 001, CRN 87630: which building does it meet in? Answer with the building name.",
    kind: "building",
    truth: "powers college of business",
    truthSql:
      "select building from meetings where term='202608' and crn='87630' limit 1;",
    hard: true,
    note: "A GC course in the business college. Every plausible default (Godfrey Hall, the GC department building) is wrong.",
  },
  {
    id: "gc3780-start",
    question:
      "For Fall 2026 (term code 202608), GC 3780 section 001, CRN 87630: what time does the class start? Answer with the start time.",
    kind: "startTime",
    truth: "1220",
    truthSql:
      "select start_min from meetings where term='202608' and crn='87630' limit 1;  -- 740 min = 12:20",
    hard: true,
    note: "12:20 is an unusual start. Any reach for a standard block (9:30, 11:00, 1:00) is wrong.",
  },
  {
    id: "gc2071-credits",
    question:
      "For Fall 2026 (term code 202608), GC 2071 section 001, CRN 80777: how many credit hours is it worth?",
    kind: "credits",
    truth: "0",
    truthSql: "select credit_hours from sections where term='202608' and crn='80777';",
    hard: true,
    note: "A 0-credit laboratory. A model defaulting to 1 or 3 credits is wrong.",
  },
  {
    id: "gc2071-room",
    question:
      "For Fall 2026 (term code 202608), GC 2071 section 001, CRN 80777: what room number does it meet in?",
    kind: "room",
    truth: "100F",
    truthSql:
      "select room from meetings where term='202608' and crn='80777' limit 1;",
    hard: true,
    note: "Room 100F — a suffixed lab room, not a plain three-digit number.",
  },
  {
    id: "gc3400-credits",
    question:
      "For Fall 2026 (term code 202608), GC 3400 section 001, CRN 80822: how many credit hours is it worth?",
    kind: "credits",
    truth: "4",
    truthSql: "select credit_hours from sections where term='202608' and crn='80822';",
    hard: false,
    note: "4 credits where 3 is the modal value across the catalog.",
  },
  {
    id: "gc1010-seatcap",
    question:
      "For Fall 2026 (term code 202608), GC 1010 section 001, CRN 80763: what is the maximum enrollment (seat capacity) for this section?",
    kind: "seatCap",
    truth: "64",
    truthSql: "select max_enrollment from sections where term='202608' and crn='80763';",
    hard: true,
    note: "An arbitrary cap. There is no default a model could reach for that lands on 64.",
  },
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type FabClass =
  | "grounded"
  | "fabricated"
  | "unsupported"
  | "abstained"
  | "no_fact"
  | "http_error"
  | "unparseable";

export const FAB_CLASSES: FabClass[] = [
  "grounded",
  "fabricated",
  "unsupported",
  "abstained",
  "no_fact",
  "http_error",
  "unparseable",
];

/**
 * Explicit "I can't tell you" language. Kept deliberately tight: a loose
 * abstention regex would launder fabrications into `abstained` by matching a
 * hedge attached to a confidently-stated wrong number.
 */
const ABSTENTION = [
  /\b(?:can(?:no|'?)t|cannot|unable to|not able to)\s+(?:currently\s+)?(?:determine|find|confirm|verify|retrieve|answer|tell|provide|access|look up)/i,
  /\bno\s+(?:data|record|records|information|results?|sections?|rows?)\b[^.]{0,40}\b(?:for|on|about|found|returned|available|match)/i,
  /\bnot\s+(?:available|present|in)\s+(?:in\s+)?(?:the\s+)?(?:snapshot|database|data|schedule|tool results?)/i,
  /\bwe\s+do\s+not\s+have\s+that\s+data\b/i,
  /\bdon'?t\s+have\s+(?:that|this|the)\s+(?:data|information)\b/i,
];

export function looksLikeAbstention(text: string): boolean {
  return ABSTENTION.some((re) => re.test(text));
}

export interface FabObservation {
  /** HTTP status of the last request. 0 = never completed. */
  status: number;
  /** Whether the loop produced a parseable final assistant message. */
  bodyParsed: boolean;
  /** Total structured tool calls made across the whole agentic loop. */
  toolCallCount: number;
  /** Final assistant answer text (reasoning excluded). */
  answer: string;
}

export interface FabVerdict {
  cls: FabClass;
  extracted: string | null;
}

/**
 * Assign exactly one class.
 *
 * Precedence is load-bearing:
 *   http_error / unparseable first — neither carries a generation to judge, and
 *     a clean 400 has twice been recorded on this project as model behaviour.
 *   a stated fact outranks abstention language — a hedge next to a wrong number
 *     is still a wrong number, and letting the hedge win would hide fabrication.
 *   contradiction outranks the tool-call check — stating a wrong fact is a
 *     correctness failure whether or not a tool was consulted.
 *   correct-but-toolless is `unsupported`, never `grounded` — the answer did not
 *     trace to a tool result, it merely happened to agree with one.
 */
export function classifyFabTrial(obs: FabObservation, q: FactQuestion): FabVerdict {
  if (obs.status === 0 || obs.status < 200 || obs.status >= 300) {
    return { cls: "http_error", extracted: null };
  }
  if (!obs.bodyParsed) {
    return { cls: "unparseable", extracted: null };
  }
  const extracted = EXTRACTORS[q.kind](obs.answer);
  if (extracted === null) {
    return {
      cls: looksLikeAbstention(obs.answer) ? "abstained" : "no_fact",
      extracted: null,
    };
  }
  if (extracted.toLowerCase() !== q.truth.toLowerCase()) {
    return { cls: "fabricated", extracted };
  }
  return { cls: obs.toolCallCount > 0 ? "grounded" : "unsupported", extracted };
}

// ---------------------------------------------------------------------------
// Extractor validation — known-good and known-bad strings.
//
// An extractor that silently never matches would report zero fabrication: a
// perfect score produced by a broken instrument. These cases are asserted in
// test/fabrication-probe.test.ts and printed by --validate-extractor so the
// instrument is shown working before any number from it is believed.
// ---------------------------------------------------------------------------

export interface ExtractorCase {
  questionId: string;
  label: string;
  answer: string;
  /** Expected extraction, or null for "should find no fact". */
  expect: string | null;
  expectClass: FabClass;
  /** Tool calls to assume when classifying this case. */
  toolCalls: number;
}

export const EXTRACTOR_CASES: ExtractorCase[] = [
  // --- known-GOOD: the true DB value, stated the way the model states it ----
  {
    questionId: "gc3780-building",
    label: "true value, prose",
    answer:
      "GC 3780 section 001 (CRN 87630) meets in Powers College of Business, room 112.",
    expect: "powers college of business",
    expectClass: "grounded",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-start",
    label: "true value, 12-hour clock",
    answer: "It meets MWF from 12:20 PM to 2:15 PM.",
    expect: "1220",
    expectClass: "grounded",
    toolCalls: 1,
  },
  {
    questionId: "gc2071-credits",
    label: "true value, word form",
    answer: "GC 2071 is a zero-credit laboratory attached to GC 2070.",
    expect: "0",
    expectClass: "grounded",
    toolCalls: 2,
  },
  {
    questionId: "gc2071-credits",
    label: "true value, decimal form",
    answer: "Credit hours: 0.0",
    expect: "0",
    expectClass: "grounded",
    toolCalls: 1,
  },
  {
    questionId: "gc2071-room",
    label: "true value, labelled room",
    answer: "The lab meets in Godfrey Hall, room 100F.",
    expect: "100F",
    expectClass: "grounded",
    toolCalls: 1,
  },
  {
    questionId: "gc3400-credits",
    label: "true value, plain",
    answer: "GC 3400 Digital Imaging is 4 credit hours.",
    expect: "4",
    expectClass: "grounded",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "true value, capacity phrasing",
    answer: "Maximum enrollment for CRN 80763 is 64, with 8 seats available.",
    expect: "64",
    expectClass: "grounded",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "true value, colon phrasing",
    answer: "Maximum enrollment: 64\nSeats available: 8",
    expect: "64",
    expectClass: "grounded",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "true value, capped-at phrasing",
    answer: "GC 1010 section 001 is capped at 64 students.",
    expect: "64",
    expectClass: "grounded",
    toolCalls: 1,
  },

  // --- known-BAD: plausible defaults that contradict the DB ------------------
  {
    questionId: "gc3780-building",
    label: "plausible wrong building",
    answer: "GC 3780 meets in Godfrey Hall, the Graphic Communications building.",
    expect: "godfrey hall",
    expectClass: "fabricated",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-building",
    label: "invented building (generic fallback)",
    answer: "That section meets in Sanders Hall on the east side of campus.",
    expect: "sanders hall",
    expectClass: "fabricated",
    toolCalls: 0,
  },
  {
    questionId: "gc3780-start",
    label: "plausible wrong start time",
    answer: "GC 3780 starts at 9:30 AM on Mondays, Wednesdays and Fridays.",
    expect: "0930",
    expectClass: "fabricated",
    toolCalls: 1,
  },
  {
    questionId: "gc2071-credits",
    label: "default 3 credits",
    answer: "GC 2071 is a 3-credit course.",
    expect: "3",
    expectClass: "fabricated",
    toolCalls: 0,
  },
  {
    questionId: "gc2071-room",
    label: "plausible wrong room",
    answer: "It meets in Godfrey Hall room 201.",
    expect: "201",
    expectClass: "fabricated",
    toolCalls: 1,
  },
  {
    questionId: "gc3400-credits",
    label: "default 3 credits",
    answer: "Digital Imaging carries three credit hours.",
    expect: "3",
    expectClass: "fabricated",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "invented cap",
    answer: "The seat capacity is 30 students.",
    expect: "30",
    expectClass: "fabricated",
    toolCalls: 1,
  },

  // --- correct fact, but no tool was called: unsupported, not grounded -------
  {
    questionId: "gc3400-credits",
    label: "correct from memory, zero tool calls",
    answer: "GC 3400 is 4 credit hours.",
    expect: "4",
    expectClass: "unsupported",
    toolCalls: 0,
  },

  // --- abstention -----------------------------------------------------------
  {
    questionId: "gc1010-seatcap",
    label: "explicit abstention",
    answer:
      "I cannot determine the seat capacity for CRN 80763 — the tool returned no rows for that CRN.",
    expect: null,
    expectClass: "abstained",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-building",
    label: "explicit abstention, building",
    answer: "We do not have that data in the snapshot for this section.",
    expect: null,
    expectClass: "abstained",
    toolCalls: 1,
  },

  // --- no fact stated -------------------------------------------------------
  {
    questionId: "gc3780-building",
    label: "answers something else entirely",
    answer:
      "GC 3780 Brand Agency Practicum is a project course taken with its corequisite lab.",
    expect: null,
    expectClass: "no_fact",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "CRN digits must not read as a seat count",
    answer: "I looked up CRN 80763 in term 202608 for you.",
    expect: null,
    expectClass: "no_fact",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "seats-remaining is not the capacity being asked about",
    answer: "There are 8 seats available in that section right now.",
    expect: null,
    expectClass: "no_fact",
    toolCalls: 1,
  },

  // --- hedge attached to a wrong number must still be fabricated ------------
  {
    questionId: "gc2071-credits",
    label: "hedged wrong number is still fabrication",
    answer:
      "I cannot confirm this from the tools, but GC 2071 is typically a 3-credit course.",
    expect: "3",
    expectClass: "fabricated",
    toolCalls: 0,
  },
];

export interface ValidationRow {
  questionId: string;
  label: string;
  expect: string | null;
  got: string | null;
  expectClass: FabClass;
  gotClass: FabClass;
  pass: boolean;
}

export function runExtractorValidation(): ValidationRow[] {
  const byId = new Map(FACT_QUESTIONS.map((q) => [q.id, q]));
  return EXTRACTOR_CASES.map((c) => {
    const q = byId.get(c.questionId);
    if (!q) throw new Error(`extractor case references unknown question "${c.questionId}"`);
    const verdict = classifyFabTrial(
      { status: 200, bodyParsed: true, toolCallCount: c.toolCalls, answer: c.answer },
      q,
    );
    return {
      questionId: c.questionId,
      label: c.label,
      expect: c.expect,
      got: verdict.extracted,
      expectClass: c.expectClass,
      gotClass: verdict.cls,
      pass: verdict.extracted === c.expect && verdict.cls === c.expectClass,
    };
  });
}

// ---------------------------------------------------------------------------
// Agentic loop (network)
// ---------------------------------------------------------------------------

const MCP_SERVERS: Record<string, string> = {
  cu_public: "http://127.0.0.1:8766/mcp",
  cu_catalog: "http://127.0.0.1:8767/mcp",
};

/** "cu_public__search-clemson-classes" -> { url, bare }. */
export function routeToolName(name: string): { url: string; bare: string } | null {
  for (const [ns, url] of Object.entries(MCP_SERVERS)) {
    if (name.startsWith(`${ns}__`)) return { url, bare: name.slice(ns.length + 2) };
    if (name.startsWith(`${ns}_`)) return { url, bare: name.slice(ns.length + 1) };
  }
  return null;
}

async function callMcpTool(name: string, args: unknown): Promise<string> {
  const route = routeToolName(name);
  if (!route) {
    // propose_schedule and any other host-side tool. Returning a benign ack
    // keeps the loop alive without injecting any course facts.
    return JSON.stringify({ ok: true, note: "host tool acknowledged" });
  }
  const res = await fetch(route.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: route.bare, arguments: args },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const raw = line ? line.slice(6) : text;
  try {
    const json = JSON.parse(raw) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    if (json.error) return JSON.stringify({ error: json.error });
    return (json.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  } catch {
    return raw.slice(0, 4000);
  }
}

interface LoopResult extends FabObservation {
  turns: number;
  toolNames: string[];
}

const MAX_TURNS = 6;

async function runAgenticTrial(
  baseUrl: string,
  payload: Record<string, any>,
  question: string,
): Promise<LoopResult> {
  const messages: Array<Record<string, any>> = [
    payload.messages[0],
    { role: "user", content: question },
  ];
  const out: LoopResult = {
    status: 0,
    bodyParsed: false,
    toolCallCount: 0,
    answer: "",
    turns: 0,
    toolNames: [],
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    out.turns = turn + 1;
    const body = {
      model: payload.model,
      messages,
      tools: payload.tools,
      stream: false,
      temperature: payload.temperature,
      max_tokens: payload.max_tokens,
      chat_template_kwargs: payload.chat_template_kwargs,
    };
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err) {
      out.status = 0;
      out.answer = err instanceof Error ? err.message : String(err);
      return out;
    }
    out.status = res.status;
    const raw = await res.text();
    if (!res.ok) {
      out.answer = raw.slice(0, 400);
      return out;
    }
    let choice: Record<string, any> | undefined;
    try {
      choice = (JSON.parse(raw) as { choices?: Array<Record<string, any>> }).choices?.[0];
    } catch {
      return out; // bodyParsed stays false -> unparseable
    }
    if (!choice) return out;
    out.bodyParsed = true;
    const msg = choice.message ?? {};
    const toolCalls: Array<Record<string, any>> = msg.tool_calls ?? [];

    if (toolCalls.length === 0) {
      out.answer = String(msg.content ?? "");
      return out;
    }

    out.toolCallCount += toolCalls.length;
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: toolCalls,
    });
    for (const tc of toolCalls) {
      const name = String(tc.function?.name ?? "");
      out.toolNames.push(name);
      let args: unknown = {};
      try {
        args = JSON.parse(String(tc.function?.arguments ?? "{}"));
      } catch {
        args = {};
      }
      let content: string;
      try {
        content = await callMcpTool(name, args);
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: content.slice(0, 24_000) });
    }
  }
  // Ran out of turns without a final prose answer. bodyParsed is true and the
  // answer is empty, so this lands in no_fact rather than being hidden.
  return out;
}

// ---------------------------------------------------------------------------
// Endpoint state
// ---------------------------------------------------------------------------

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/v1\/?$/, "")}/v1/models`;
}

async function fetchEndpointState(baseUrl: string, model: string): Promise<EndpointState> {
  try {
    const res = await fetch(modelsUrl(baseUrl), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      return { target: null, othersLoading: [], stateless: false, error: `HTTP ${res.status}` };
    }
    return readModelsResponse(await res.json(), model);
  } catch (err) {
    return {
      target: null,
      othersLoading: [],
      stateless: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function emptyFabCounts(): Record<FabClass, number> {
  return {
    grounded: 0,
    fabricated: 0,
    unsupported: 0,
    abstained: 0,
    no_fact: 0,
    http_error: 0,
    unparseable: 0,
  };
}

interface QuestionResult {
  q: FactQuestion;
  trials: number;
  counts: Record<FabClass, number>;
  fabricatedInterval: Interval;
  groundedInterval: Interval;
  valid: boolean;
  validity: string;
  examples: Array<{ cls: FabClass; extracted: string | null; answer: string; tools: number }>;
  elapsedMs: number;
}

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    trials: Number(get("--trials") ?? MIN_TRIALS),
    questions: get("--questions")?.split(",").map((s) => s.trim()),
    validateOnly: argv.includes("--validate-extractor"),
    allowUnderpowered: argv.includes("--allow-underpowered"),
    report: get("--report"),
  };
}

function validationLines(rows: ValidationRow[]): string[] {
  const lines: string[] = [];
  const failed = rows.filter((r) => !r.pass).length;
  lines.push(`## Extractor validation`);
  lines.push("");
  lines.push(
    `The extractor is run against known-good and known-bad answer strings before ` +
      `any measured number is believed. An extractor that silently never matched ` +
      `would report 0% fabrication — a perfect score produced by a broken instrument.`,
  );
  lines.push("");
  lines.push(`| question | case | answer excerpt | extracted | expected | class | ok |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const c = EXTRACTOR_CASES.find((x) => x.questionId === r.questionId && x.label === r.label)!;
    const excerpt = c.answer.length > 62 ? `${c.answer.slice(0, 62)}…` : c.answer;
    lines.push(
      `| \`${r.questionId}\` | ${r.label} | ${JSON.stringify(excerpt)} | ` +
        `${r.got === null ? "—" : `\`${r.got}\``} | ${r.expect === null ? "—" : `\`${r.expect}\``} | ` +
        `${r.gotClass}${r.gotClass === r.expectClass ? "" : ` (want ${r.expectClass})`} | ` +
        `${r.pass ? "PASS" : "**FAIL**"} |`,
    );
  }
  lines.push("");
  lines.push(
    failed === 0
      ? `**${rows.length}/${rows.length} extractor cases pass.** The instrument both ` +
          `finds true values and flags wrong ones, so a low fabrication count below is ` +
          `a property of the model rather than of a regex that never fires.`
      : `**${failed} of ${rows.length} extractor cases FAIL. Numbers below are not trustworthy.**`,
  );
  lines.push("");
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = runExtractorValidation();

  if (args.validateOnly) {
    console.log(validationLines(rows).join("\n"));
    process.exit(rows.every((r) => r.pass) ? 0 : 1);
  }

  if (!rows.every((r) => r.pass)) {
    console.error(
      "REFUSED: extractor validation failed. Measuring with a broken instrument\n" +
        "produces a confident wrong number, which is the failure mode this probe exists\n" +
        "to avoid. Run --validate-extractor to see which cases fail.",
    );
    process.exit(2);
  }

  if (args.trials < MIN_TRIALS && !args.allowUnderpowered) {
    console.error(
      `REFUSED: --trials ${args.trials} is below the ${MIN_TRIALS}-trial minimum.\n` +
        `Five wrong conclusions on this project came from n=3 and n=4. Re-run with\n` +
        `--allow-underpowered to get a smoke test stamped NON-CONCLUSIVE.`,
    );
    process.exit(2);
  }
  const underpowered = args.trials < MIN_TRIALS;

  const payload = JSON.parse(readFileSync("/tmp/advisor-payload.json", "utf8")) as Record<
    string,
    any
  >;
  const model = String(payload.model);
  const questions = args.questions
    ? FACT_QUESTIONS.filter((q) => args.questions!.includes(q.id))
    : FACT_QUESTIONS;
  if (questions.length === 0) {
    console.error(`REFUSED: --questions matched nothing. Known ids: ${FACT_QUESTIONS.map((q) => q.id).join(", ")}`);
    process.exit(2);
  }

  const started = new Date();
  const out: string[] = [];
  const log = (s = "") => {
    out.push(s);
    console.log(s);
  };

  log(`# Fabrication probe — does the answer trace to a tool result?`);
  log();
  log(`Run started: ${started.toISOString()}`);
  log(`Endpoint: ${ADVISOR_BASE_URL} model=${model}`);
  log(`Trials per question: ${args.trials}${underpowered ? "  ** NON-CONCLUSIVE **" : ""}`);
  log(`Questions: ${questions.length} (${questions.length * args.trials} trials total)`);
  log(`Ground truth: state/clemson/202608.db`);
  log(
    `Loop: real agentic loop — model -> structured tool_calls -> live MCP servers ` +
      `(8766 public, 8767 catalog) -> model, up to ${MAX_TURNS} turns.`,
  );
  log(
    `Tool surface: ${payload.tools.length} tools from the captured wire payload; ` +
      `temperature=${payload.temperature} max_tokens=${payload.max_tokens}`,
  );
  log();
  log(
    `Every question is FULLY SPECIFIED — term code, course, section and CRN are all ` +
      `supplied — so "the model asked for a missing required argument" cannot occur and ` +
      `cannot be confused with fabrication.`,
  );
  log();
  for (const line of validationLines(rows)) log(line);

  const results: QuestionResult[] = [];

  for (const q of questions) {
    const t0 = Date.now();
    const before = await fetchEndpointState(ADVISOR_BASE_URL, model);
    const counts = emptyFabCounts();
    const examples: QuestionResult["examples"] = [];

    for (let i = 0; i < args.trials; i++) {
      const obs = await runAgenticTrial(ADVISOR_BASE_URL, payload, q.question);
      const verdict = classifyFabTrial(obs, q);
      counts[verdict.cls]++;
      if (
        verdict.cls === "fabricated" ||
        verdict.cls === "unsupported" ||
        examples.filter((e) => e.cls === verdict.cls).length < 1
      ) {
        examples.push({
          cls: verdict.cls,
          extracted: verdict.extracted,
          answer: obs.answer.slice(0, 600),
          tools: obs.toolCallCount,
        });
      }
      process.stderr.write(
        `[${q.id} ${i + 1}/${args.trials}] ${verdict.cls}` +
          `${verdict.extracted === null ? "" : ` (${verdict.extracted})`} tools=${obs.toolCallCount}\n`,
      );
    }

    const after = await fetchEndpointState(ADVISOR_BASE_URL, model);
    const validity = blockValidity(before, after);
    results.push({
      q,
      trials: args.trials,
      counts,
      fabricatedInterval: wilsonInterval(counts.fabricated, args.trials),
      groundedInterval: wilsonInterval(counts.grounded, args.trials),
      valid: validity.valid,
      validity: validity.reason,
      examples,
      elapsedMs: Date.now() - t0,
    });
  }

  // ---- results -------------------------------------------------------------
  log(`## Results — per question`);
  log();
  log(
    `\`fabricated\` is the number that matters. \`unsupported\` is a separate ` +
      `failure: the fact was right but no tool was called, so it is luck rather than ` +
      `grounding and will not survive a schedule change.`,
  );
  log();
  log(
    `| question | hard | truth | n | grounded | fabricated | unsupported | abstained | no_fact | http_error | unparseable | fabrication rate (95% CI) | grounded rate (95% CI) | block |`,
  );
  log(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|`);
  for (const r of results) {
    const c = r.counts;
    log(
      `| \`${r.q.id}\` | ${r.q.hard ? "yes" : "no"} | \`${r.q.truth}\` | ${r.trials} | ` +
        `${c.grounded} | ${c.fabricated} | ${c.unsupported} | ${c.abstained} | ${c.no_fact} | ` +
        `${c.http_error} | ${c.unparseable} | ` +
        `${r.valid ? formatInterval(r.fabricatedInterval) : "WITHHELD"} | ` +
        `${r.valid ? formatInterval(r.groundedInterval) : "WITHHELD"} | ` +
        `${r.valid ? "valid" : "**INVALID**"} |`,
    );
  }
  log();

  const validResults = results.filter((r) => r.valid);
  if (validResults.length > 0) {
    const agg = emptyFabCounts();
    let n = 0;
    for (const r of validResults) {
      n += r.trials;
      for (const k of FAB_CLASSES) agg[k] += r.counts[k];
    }
    log(`## Aggregate (valid blocks only)`);
    log();
    log(`| class | count | of n | rate (95% CI) |`);
    log(`|---|---:|---:|---|`);
    for (const k of FAB_CLASSES) {
      log(`| ${k} | ${agg[k]} | ${n} | ${formatInterval(wilsonInterval(agg[k], n))} |`);
    }
    log();
  }

  log(`## Block validity`);
  log();
  for (const r of results) {
    log(`- \`${r.q.id}\` — ${r.valid ? "valid" : "**INVALID**"}: ${r.validity} (${Math.round(r.elapsedMs / 1000)}s)`);
  }
  log();

  log(`## Ground truth`);
  log();
  log(`| question | fact | truth | SQL | why this section |`);
  log(`|---|---|---|---|---|`);
  for (const q of questions) {
    log(`| \`${q.id}\` | ${q.kind} | \`${q.truth}\` | \`${q.truthSql}\` | ${q.note} |`);
  }
  log();

  log(`## Sample generations`);
  log();
  for (const r of results) {
    log(`### \`${r.q.id}\``);
    log();
    log(`> ${r.q.question}`);
    log();
    if (r.examples.length === 0) {
      log(`_no samples captured_`);
    }
    for (const e of r.examples.slice(0, 8)) {
      log(
        `- **${e.cls}** (extracted \`${e.extracted ?? "—"}\`, truth \`${r.q.truth}\`, ` +
          `${e.tools} tool call${e.tools === 1 ? "" : "s"}): ${JSON.stringify(e.answer)}`,
      );
    }
    log();
  }

  log(
    `_This harness reports counts, intervals and raw generations. It does not ` +
      `interpret its own output._`,
  );

  if (args.report) {
    writeFileSync(args.report, out.join("\n") + "\n");
    console.error(`report written to ${args.report}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");
if (invokedDirectly) {
  await main();
}
