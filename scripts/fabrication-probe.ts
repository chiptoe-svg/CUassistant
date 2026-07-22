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
//   tool_backed — made >= 1 tool call AND the extracted fact matches the DB.
//                 Named for exactly what is checked. It is NOT a claim that the
//                 answer was about the right CRN, term or section, that the rest
//                 of the answer was correct, or that the tool call that was made
//                 is the one the fact came from: the check is
//                 `toolCallCount > 0 && extracted === truth` and nothing more.
//                 Read it as "one extracted fact matched, and some tool was
//                 called on that turn".
//   fabricated  — stated a fact that CONTRADICTS the DB (the number that matters)
//   unsupported — stated the correct fact with ZERO tool calls. Correct-from-
//                 memory is not tool-backed; it is luck, and it does not survive a
//                 schedule change. Kept distinct from `fabricated` because the
//                 remedies differ: fabrication is a correctness failure,
//                 unsupported is a grounding failure that happened to get away.
//   abstained   — declined, or said it could not determine
//   no_fact     — answered without stating the fact (extraction found nothing)
//   unclassifiable — extraction found several conflicting readings and could not
//                 determine which one answers the question. This is the
//                 INSTRUMENT declining to judge, not an observation about the
//                 model, and it is reported as its own count. "I could not tell"
//                 and "it was wrong" must not look the same — the same reason
//                 roomCapacity() returns null rather than 0.
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
// Extraction result — three outcomes, never two.
//
// The first version of this file returned `string | null`, which forced every
// uncertain reading into one of two confident answers: a value (which the
// classifier then compares to the DB and may call `fabricated`) or "no fact"
// (which reads as the model having dodged the question). Both are assertions.
// Neither can say "I could not tell".
//
// That gap produced the worst possible defect for this instrument. Given:
//
//   "The maximum enrollment (seat capacity) for GC 1010 section 001 (CRN 80763)
//    in Fall 2026 is 64 students. The section is currently meeting in Jordan
//    Hall G33, which has a physical room capacity of 102, but the enrollment
//    limit for the section itself is capped at 64."
//
// — an entirely correct answer, 64 being the true cap and Jordan Hall G33
// genuinely seating 102 — the old extractor returned "102" and the harness
// reported `fabricated`. It manufactured evidence of the exact failure this
// project exists to prevent, against a model that was right.
//
// So this follows the precedent already set twice in this repo: `roomCapacity()`
// returns null rather than 0, and the schedule renderer shows a NOT VERIFIED
// banner rather than silently claiming verification. "I could not tell" and "it
// was wrong" must not look the same.
// ---------------------------------------------------------------------------

export type Extraction =
  | { kind: "found"; value: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: string[] };

const NONE: Extraction = { kind: "none" };

function found(value: string): Extraction {
  return { kind: "found", value };
}

/** Collapse a candidate list: one distinct value is an answer, several is not. */
function resolve(values: string[]): Extraction {
  const distinct = [...new Set(values)];
  if (distinct.length === 0) return NONE;
  if (distinct.length === 1) return found(distinct[0]!);
  return { kind: "ambiguous", candidates: distinct.sort() };
}

/** The extracted value, or null for both "none" and "ambiguous". */
export function extractionValue(e: Extraction): string | null {
  return e.kind === "found" ? e.value : null;
}

/**
 * Strip the emphasis models wrap answers in.
 *
 * This is not cosmetic. The real answer above wrote the value as `**64
 * students**`, and every cue-bound pattern in the first version joined cue to
 * value with `\s*`, which does not match `*`. The bold markers alone turned a
 * correct, well-grounded answer into `no_fact` — the second of the two
 * misclassifications this rewrite exists to fix.
 *
 * `_` becomes a space rather than being deleted, so a raw DB column echoed back
 * ("max_enrollment: 64") reads as the cue "max enrollment" instead of being
 * welded into the unmatchable "maxenrollment".
 */
export function stripMarkup(text: string): string {
  return text.replace(/[*`~]/g, "").replace(/_/g, " ");
}

/**
 * Abbreviations whose trailing period does not end a sentence. Without this,
 * "Rm. 112" splits into "Rm." and "112" and the room label is severed from the
 * room number — the sentence scoping below would then find no room at all.
 */
const ABBREVIATION =
  /(?:\b(?:rm|no|bldg|dr|mr|mrs|ms|approx|max|min|cr|vs|etc|sect|sec|dept|univ|hr|hrs|fig|cf)|a\.m|p\.m|e\.g|i\.e)\.$/i;

/**
 * Split on sentence end, but only where a space follows — so a decimal ("0.0")
 * is never split — and never after a known abbreviation.
 */
export function splitSentences(text: string): string[] {
  const rough = text.split(/(?<=[.!?])\s+|\n+/);
  const joined: string[] = [];
  for (const piece of rough) {
    const prev = joined[joined.length - 1];
    if (prev !== undefined && ABBREVIATION.test(prev.trim())) {
      joined[joined.length - 1] = `${prev} ${piece}`;
    } else {
      joined.push(piece);
    }
  }
  return joined.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Run `gather` over sentences in order; the FIRST sentence that yields any
 * candidate decides the answer.
 *
 * Sentence scoping is what keeps a correct headline answer from being overruled
 * by later context. "…is 64 students." is sentence one; "…physical room
 * capacity of 102…" is sentence two and is never consulted. It also bounds
 * ambiguity: only values competing *within one sentence* can be genuinely
 * indistinguishable, and a trailing recap cannot manufacture a conflict.
 */
function firstSentenceWithCandidates(
  text: string,
  gather: (sentence: string) => string[],
): Extraction {
  for (const sentence of splitSentences(stripMarkup(text))) {
    const values = gather(sentence);
    if (values.length > 0) return resolve(values);
  }
  return NONE;
}

/** All global-regex matches, as [start, end) spans. */
function spansOf(sentence: string, re: RegExp): Array<[number, number]> {
  return [...sentence.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
}

function insideAny(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => index >= a && index < b);
}

// ---------------------------------------------------------------------------
// Extractors — one per fact kind. Each binds to language that names the fact
// being asked about, and explicitly refuses the language of its near neighbour:
// seat capacity refuses room capacity, a start time refuses an end time, a room
// number refuses a building number.
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

const NUM_OR_WORD = String.raw`\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten`;

/** "0.0" -> "0", "3.00" -> "3", "4" -> "4". Numeric identity, textual output. */
export function normalizeNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw.trim().toLowerCase();
  return String(n);
}

function numericValue(raw: string): string {
  const lowered = raw.toLowerCase();
  return normalizeNumber(WORD_NUMBERS[lowered] ?? lowered);
}

/**
 * Credit hours. Matches both orderings the model actually uses:
 *   "GC 2071 is a 0-credit lab"      -> "0"
 *   "credit hours: 4"                -> "4"
 *   "carries zero credit hours"      -> "0"
 */
export function extractCredits(text: string): Extraction {
  const patterns: RegExp[] = [
    new RegExp(String.raw`\b(${NUM_OR_WORD})[\s-]*(?:semester\s+)?(?:credit|cr\.?)\b`, "gi"),
    new RegExp(
      String.raw`\bcredit\s*hours?\b[^0-9a-z]{0,12}(?:is|are|of|:|=)?\s*(${NUM_OR_WORD})\b`,
      "gi",
    ),
    new RegExp(String.raw`\bworth\b[^0-9a-z]{0,12}(${NUM_OR_WORD})\b`, "gi"),
  ];
  return firstSentenceWithCandidates(text, (s) => {
    const values: string[] = [];
    for (const re of patterns) {
      for (const m of s.matchAll(re)) values.push(numericValue(m[1]!));
    }
    return values;
  });
}

// --- start time ------------------------------------------------------------

const TIME_TOKEN =
  /\b(\d{1,2})\s*[:.]\s*(\d{2})\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/gi;

/** Language that marks the time as the END of the meeting, never the start. */
const END_CUE = /\b(?:ends?|ended|ending|end\s+time|until|til|till|through|thru)\b[^0-9]{0,12}$/i;

/** Language that marks the time as the START of the meeting. */
const START_CUE =
  /\b(?:starts?|starting|start\s+time|begins?|beginning|commences?|from|at)\b[^0-9]{0,12}$/i;

/** A separator that makes the following time the tail of a range: "12:20 to 2:15". */
const RANGE_SEP = /^\s*(?:-|–|—|to|until|til|till|through|thru)\s*$/i;

interface TimeToken {
  hhmm: string;
  start: number;
  end: number;
}

function timeTokens(sentence: string): TimeToken[] {
  const out: TimeToken[] = [];
  for (const m of sentence.matchAll(TIME_TOKEN)) {
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
    if (hour > 23 || minute > 59) continue;
    if (meridiem) {
      const pm = /p/i.test(meridiem);
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    out.push({
      hhmm: `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`,
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

/**
 * Start time, normalized to 24-hour HHMM.
 *
 * An end time is never a start time. "The class ends at 2:15 PM and starts at
 * 12:20 PM" reads 1220, not 1415, because tokens carrying end language — or
 * sitting on the tail side of a range separator — are excluded before anything
 * is chosen. Times with no cue either way are used only when no explicitly
 * start-cued time exists.
 *
 * Deliberately does NOT guess a meridiem. "1:00" with no am/pm normalizes to
 * 0100, not 1300 — inventing the missing half of an ambiguous time inside the
 * instrument would be the instrument fabricating on the model's behalf.
 */
export function extractStartTime(text: string): Extraction {
  return firstSentenceWithCandidates(text, (s) => {
    const tokens = timeTokens(s);
    const starts: string[] = [];
    const unlabelled: string[] = [];
    tokens.forEach((t, i) => {
      const before = s.slice(Math.max(0, t.start - 30), t.start);
      const prev = tokens[i - 1];
      const isRangeTail = prev !== undefined && RANGE_SEP.test(s.slice(prev.end, t.start));
      if (isRangeTail || END_CUE.test(before)) return; // an end time, discard
      if (START_CUE.test(before)) starts.push(t.hhmm);
      else unlabelled.push(t.hhmm);
    });
    return starts.length > 0 ? starts : unlabelled;
  });
}

// --- building --------------------------------------------------------------

const BUILDING_ALTERNATION = DB_BUILDINGS.slice()
  // longest first, so "Daniel Hall Expansion" is not shadowed by "Daniel Hall"
  .sort((a, b) => b.length - a.length)
  .map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const GENERIC_BUILDING =
  /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:Hall|Building|Center|Laboratory))\b/g;

/**
 * Building name. Closed vocabulary from the DB first, then a generic
 * "<Proper Name> Hall" fallback so a building the DB has never heard of still
 * registers as a stated fact rather than silently as `no_fact`.
 *
 * The longest-first alternation is scanned globally, so "Daniel Hall Expansion"
 * consumes its own span and cannot also register as "Daniel Hall" — which would
 * otherwise read as two conflicting buildings in one sentence.
 */
export function extractBuilding(text: string): Extraction {
  const vocab = new RegExp(`\\b(${BUILDING_ALTERNATION})\\b`, "gi");
  return firstSentenceWithCandidates(text, (s) => {
    const hits = [...s.matchAll(vocab)].map((m) => m[1]!.toLowerCase());
    if (hits.length > 0) return hits;
    return [...s.matchAll(GENERIC_BUILDING)].map((m) => m[1]!.toLowerCase());
  });
}

// --- room ------------------------------------------------------------------

/** Rooms in this catalog: 1-4 digits, optionally lettered on either end
 *  ("112", "100F", "G33"). */
const ROOM_TOKEN = String.raw`[A-Za-z]?[0-9]{1,4}[A-Za-z]?`;

/**
 * Room number. Either explicitly labelled ("room 100F", "Rm. 112") or written
 * adjacent to a known building ("Godfrey Hall 100F", "Jordan Hall G33").
 *
 * A building number is not a room number: "Building 3" is rejected, unless the
 * word "Building" is the tail of a real DB building name ("Dillard Building 3"),
 * where the number genuinely is the room.
 */
export function extractRoom(text: string): Extraction {
  const labelled = new RegExp(String.raw`\b(?:room|rm\.?)\s*#?\s*(${ROOM_TOKEN})\b`, "gi");
  const adjacent = new RegExp(
    String.raw`\b(?:${BUILDING_ALTERNATION})\b[\s,/:#-]{0,3}(${ROOM_TOKEN})\b`,
    "gi",
  );
  const vocabSpans = new RegExp(`\\b(?:${BUILDING_ALTERNATION})\\b`, "gi");
  const buildingNumber = new RegExp(
    String.raw`\b(?:building|bldg\.?|floor|suite)\s*#?\s*(${ROOM_TOKEN})\b`,
    "gi",
  );

  return firstSentenceWithCandidates(text, (s) => {
    const knownBuildings = spansOf(s, vocabSpans);
    // "Building 3" is a building number unless "Building" closes a DB name.
    const rejected: Array<[number, number]> = [...s.matchAll(buildingNumber)]
      .filter((m) => !knownBuildings.some(([, end]) => end >= m.index! && end <= m.index! + m[0].length))
      .map((m) => [m.index!, m.index! + m[0].length]);

    const values: string[] = [];
    for (const re of [labelled, adjacent]) {
      for (const m of s.matchAll(re)) {
        const valueIndex = m.index! + m[0].lastIndexOf(m[1]!);
        if (insideAny(valueIndex, rejected)) continue;
        values.push(m[1]!.toUpperCase());
      }
    }
    return values;
  });
}

// --- seat capacity ---------------------------------------------------------

/**
 * Language naming the SECTION's enrollment limit — the fact being asked about.
 */
const ENROLLMENT_CUE = new RegExp(
  [
    String.raw`\b(?:maximum|max\.?)\s+(?:enrollment|enrolment)`,
    String.raw`\b(?:enrollment|enrolment)\s+(?:limit|cap|capacity|maximum|max)`,
    String.raw`\bseat(?:ing)?\s+(?:cap|capacity|limit)`,
    String.raw`\b(?:section|class)\s+(?:cap|capacity|limit)`,
    String.raw`\bcapped\s+at`,
    String.raw`\b(?:maximum|max\.?|limit)\s+of`,
    String.raw`\b(?:maximum|max\.?)\s+seats?`,
    String.raw`\bholds?\s+up\s+to`,
  ].join("|"),
  "gi",
);

/**
 * Language naming the ROOM's physical capacity — a DIFFERENT fact that happens
 * to be a number of people in the same sentence neighbourhood.
 *
 * This is the guard that the first version lacked. Its tier list contained
 * `(?:enrollment|seat|room|class)\s*(?:cap|capacity|limit)`, so "physical room
 * capacity of 102" matched, outranked the true answer, and reported a correct
 * model as fabricating. Room capacity is now not merely deprioritised — it
 * produces no candidate at all, and any enrollment cue that overlaps a room cue
 * ("the room holds up to 102") is suppressed.
 */
const ROOM_CAPACITY_CUE = new RegExp(
  [
    String.raw`\b(?:physical\s+)?(?:room|classroom|building|lecture\s+hall)\s+(?:cap|capacity)`,
    String.raw`\bphysical\s+cap(?:acity)?`,
    String.raw`\bcapacity\s+of\s+the\s+(?:room|building|hall)`,
    String.raw`\bthe\s+room\s+(?:holds?|seats?|fits?|accommodates?)`,
    String.raw`\broom\s+(?:holds?|seats?|fits?|accommodates?)`,
  ].join("|"),
  "gi",
);

/** A bare seat count that is explicitly seats REMAINING, never the capacity. */
const SEATS_REMAINING = /\b(\d{1,4})\s+seats?\b(?=\s*(?:available|open|left|remaining|free))/gi;
const BARE_SEATS = /\b(\d{1,4})\s+(?:total\s+)?seats?\b(?!\s*(?:available|open|left|remaining|free))/gi;

/** The value a cue points at: immediately adjacent, or joined by a connector. */
function valueAfterCue(sentence: string, cueEnd: number, window = 90): string | null {
  const tail = sentence.slice(cueEnd, cueEnd + window);
  const immediate = /^[^0-9A-Za-z]{0,4}(\d{1,4})\b/.exec(tail);
  if (immediate) return normalizeNumber(immediate[1]!);
  const connected = /\b(?:is|are|of|at|to|equals?)\b\s*[:=-]?\s*(\d{1,4})\b|[:=]\s*(\d{1,4})\b/.exec(
    tail,
  );
  if (connected) return normalizeNumber(connected[1] ?? connected[2]!);
  return null;
}

/**
 * Seat capacity / maximum enrollment.
 *
 * Bound to enrollment language, so an incidental number ("Fall 2026",
 * "CRN 80763"), a room's physical capacity, and a seats-remaining count are all
 * refused. The bare "N seats" reading is a last resort used only when no cued
 * value exists anywhere in the answer.
 */
export function extractSeatCap(text: string): Extraction {
  const cued = firstSentenceWithCandidates(text, (s) => {
    const roomSpans = spansOf(s, ROOM_CAPACITY_CUE);
    const values: string[] = [];
    for (const m of s.matchAll(ENROLLMENT_CUE)) {
      if (insideAny(m.index!, roomSpans)) continue; // "the room holds up to 102"
      const v = valueAfterCue(s, m.index! + m[0].length);
      if (v !== null) values.push(v);
    }
    return values;
  });
  if (cued.kind !== "none") return cued;

  return firstSentenceWithCandidates(text, (s) => {
    const remaining = spansOf(s, SEATS_REMAINING);
    const roomSpans = spansOf(s, ROOM_CAPACITY_CUE);
    return [...s.matchAll(BARE_SEATS)]
      .filter((m) => !insideAny(m.index!, remaining) && !insideAny(m.index!, roomSpans))
      .map((m) => normalizeNumber(m[1]!));
  });
}

export type FactKind = "credits" | "startTime" | "building" | "room" | "seatCap";

export const EXTRACTORS: Record<FactKind, (text: string) => Extraction> = {
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
  | "tool_backed"
  | "fabricated"
  | "unsupported"
  | "abstained"
  | "no_fact"
  | "unclassifiable"
  | "http_error"
  | "unparseable";

export const FAB_CLASSES: FabClass[] = [
  "tool_backed",
  "fabricated",
  "unsupported",
  "abstained",
  "no_fact",
  "unclassifiable",
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
  /** Set only for `unclassifiable`: the competing readings that could not be
   *  told apart. Printed in the report so the reader sees what was in conflict
   *  rather than a bare count. */
  candidates?: string[];
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
 *   correct-but-toolless is `unsupported`, never `tool_backed` — no tool was
 *     called on that turn, so the answer merely happened to agree with the DB.
 *
 * What `tool_backed` does NOT assert: that the tool call retrieved the fact,
 * that the answer concerned the CRN/term/section asked about, or that anything
 * else in the answer was right. It asserts `toolCallCount > 0` and one
 * normalized string equality.
 *   an ambiguous reading is `unclassifiable` and is reported on its own — never
 *     folded into `fabricated` (which would be a false accusation) and never
 *     into `no_fact` (which would hide that the model did answer). The
 *     instrument is allowed to say "I could not tell".
 */
export function classifyFabTrial(obs: FabObservation, q: FactQuestion): FabVerdict {
  if (obs.status === 0 || obs.status < 200 || obs.status >= 300) {
    return { cls: "http_error", extracted: null };
  }
  if (!obs.bodyParsed) {
    return { cls: "unparseable", extracted: null };
  }
  const extraction = EXTRACTORS[q.kind](obs.answer);
  if (extraction.kind === "ambiguous") {
    return { cls: "unclassifiable", extracted: null, candidates: extraction.candidates };
  }
  if (extraction.kind === "none") {
    return {
      cls: looksLikeAbstention(obs.answer) ? "abstained" : "no_fact",
      extracted: null,
    };
  }
  const extracted = extraction.value;
  if (extracted.toLowerCase() !== q.truth.toLowerCase()) {
    return { cls: "fabricated", extracted };
  }
  return { cls: obs.toolCallCount > 0 ? "tool_backed" : "unsupported", extracted };
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
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-start",
    label: "true value, 12-hour clock",
    answer: "It meets MWF from 12:20 PM to 2:15 PM.",
    expect: "1220",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc2071-credits",
    label: "true value, word form",
    answer: "GC 2071 is a zero-credit laboratory attached to GC 2070.",
    expect: "0",
    expectClass: "tool_backed",
    toolCalls: 2,
  },
  {
    questionId: "gc2071-credits",
    label: "true value, decimal form",
    answer: "Credit hours: 0.0",
    expect: "0",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc2071-room",
    label: "true value, labelled room",
    answer: "The lab meets in Godfrey Hall, room 100F.",
    expect: "100F",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc3400-credits",
    label: "true value, plain",
    answer: "GC 3400 Digital Imaging is 4 credit hours.",
    expect: "4",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "true value, capacity phrasing",
    answer: "Maximum enrollment for CRN 80763 is 64, with 8 seats available.",
    expect: "64",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "true value, colon phrasing",
    answer: "Maximum enrollment: 64\nSeats available: 8",
    expect: "64",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "true value, capped-at phrasing",
    answer: "GC 1010 section 001 is capped at 64 students.",
    expect: "64",
    expectClass: "tool_backed",
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

  // =========================================================================
  // MULTI-NUMBER ANSWERS
  //
  // Every case above this line contains exactly ONE number of the asked-for
  // kind. That is why the first version of this suite passed 23/23 and then
  // misclassified two of the first seven real answers: real prose states
  // several numbers, and the suite never covered the case that breaks the
  // extractor. A fixture set where every case has one number cannot certify an
  // extractor that runs on real prose.
  //
  // The first two cases below are verbatim generations from that run.
  // =========================================================================

  {
    questionId: "gc1010-seatcap",
    label: "REGRESSION: seat cap beside the room's physical capacity (verbatim)",
    answer:
      "The maximum enrollment (seat capacity) for GC 1010 section 001 (CRN 80763) " +
      "in Fall 2026 is **64 students**. The section is currently meeting in Jordan " +
      "Hall G33, which has a physical room capacity of 102, but the enrollment " +
      "limit for the section itself is capped at 64.",
    // Entirely correct: the cap is 64, and Jordan Hall G33 really does seat 102
    // (data/clemson-room-capacity.json). The old extractor read 102 and called
    // this a fabrication — a false accusation against a model that was right.
    expect: "64",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "REGRESSION: correct value inside bold markers (verbatim)",
    answer:
      "For GC 1010 section 001 (CRN 80763) in Fall 2026, the maximum enrollment " +
      "(seat capacity) is **64**.",
    // Scored `no_fact` by the old extractor: `\s*` between cue and value does
    // not match `**`, so the bold markers alone hid a correct answer.
    expect: "64",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "room capacity ALONE states no seat cap",
    answer: "That section meets in Jordan Hall G33, which has a room capacity of 102.",
    // The asked-for fact was never stated. `no_fact`, not `fabricated`.
    expect: null,
    expectClass: "no_fact",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "\"the room holds\" must not be read as the enrollment limit",
    answer: "The room holds up to 102 students, but the section is capped at 64.",
    expect: "64",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc1010-seatcap",
    label: "enrolled count stated beside the capacity",
    answer:
      "There are currently 56 students enrolled, and the maximum enrollment is 64.",
    expect: "64",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-start",
    label: "start and end time in one range",
    answer:
      "GC 3780 section 001 meets MWF from 12:20 PM to 2:15 PM in Powers College of Business 112.",
    expect: "1220",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-start",
    label: "end time stated FIRST must not be read as the start",
    answer: "The class ends at 2:15 PM; it starts at 12:20 PM.",
    expect: "1220",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-building",
    label: "building and room in one answer",
    answer:
      "GC 3780 section 001 (CRN 87630) meets in Powers College of Business, room 112, MWF 12:20-2:15 PM.",
    expect: "powers college of business",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc2071-room",
    label: "room stated with building, time and capacity around it",
    answer:
      "The lab meets in Godfrey Hall, room 100F, from 8:00 AM to 10:50 AM, and seats 20.",
    expect: "100F",
    expectClass: "tool_backed",
    toolCalls: 1,
  },
  {
    questionId: "gc2071-credits",
    label: "credit hours among a room number and a seat cap",
    answer:
      "GC 2071 is a 0-credit laboratory that meets in Godfrey Hall 100F with a maximum enrollment of 24.",
    expect: "0",
    expectClass: "tool_backed",
    toolCalls: 1,
  },

  // --- unclassifiable: the instrument is allowed to say "I could not tell" ---
  //
  // Reported as its own count, never folded into `fabricated` (a false
  // accusation) or `no_fact` (which would hide that the model did answer).
  {
    questionId: "gc1010-seatcap",
    label: "two conflicting capacities, neither identifiable as the answer",
    answer: "The section capacity is 64 and the maximum enrollment is 72.",
    expect: null,
    expectClass: "unclassifiable",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-start",
    label: "two sections, two start times",
    answer: "Section 001 starts at 12:20 PM and section 002 starts at 9:30 AM.",
    expect: null,
    expectClass: "unclassifiable",
    toolCalls: 1,
  },
  {
    questionId: "gc3780-building",
    label: "two buildings named in one sentence",
    answer: "It meets in Godfrey Hall and Powers College of Business.",
    expect: null,
    expectClass: "unclassifiable",
    toolCalls: 1,
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
    tool_backed: 0,
    fabricated: 0,
    unsupported: 0,
    abstained: 0,
    no_fact: 0,
    unclassifiable: 0,
    http_error: 0,
    unparseable: 0,
  };
}

interface QuestionResult {
  q: FactQuestion;
  trials: number;
  counts: Record<FabClass, number>;
  fabricatedInterval: Interval;
  toolBackedInterval: Interval;
  valid: boolean;
  validity: string;
  examples: Array<{
    cls: FabClass;
    extracted: string | null;
    candidates?: string[];
    answer: string;
    tools: number;
  }>;
  elapsedMs: number;
}

/**
 * Read `--flag value` or `--flag=value`.
 *
 * The equals form matters: `indexOf("--trials")` never matches `--trials=100`,
 * so that spelling silently fell back to the default and the report printed a
 * trial count nobody asked for.
 */
export function getFlag(argv: string[], flag: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  // `--trials --report x` must not read "--report" as the value. Returning the
  // next flag produced Number("--report") -> NaN, and NaN < MIN_TRIALS is false,
  // so the underpowered refusal was skipped and the trial loop ran zero times
  // under a "RUN COMPLETE" banner and exit 0.
  if (next === undefined || next.startsWith("--")) return undefined;
  return next;
}

/** Was the flag written at all, in either spelling? */
export function flagPresent(argv: string[], flag: string): boolean {
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

export function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => getFlag(argv, flag);
  const rawTrials = get("--trials");
  // "--trials was written but carries no value" is an ERROR, not a default.
  // Defaulting there is how `--trials --report x` used to yield a report nobody
  // could distinguish from a real one.
  const trials =
    rawTrials === undefined
      ? flagPresent(argv, "--trials")
        ? Number.NaN
        : MIN_TRIALS
      : Number(rawTrials);
  if (!Number.isInteger(trials) || trials < 1) {
    // Refuse rather than default. A trial count the caller did not choose is
    // exactly how an unexplained 7-of-100 run happens: the loop runs zero times
    // and prints RUN COMPLETE.
    throw new Error(
      `REFUSED: --trials ${JSON.stringify(rawTrials ?? "(no value)")} is not a positive ` +
        `whole number. A NaN or zero trial count produces a "RUN COMPLETE" report ` +
        `measuring nothing. Pass --trials N or --trials=N.`,
    );
  }
  return {
    trials,
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
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
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
  log(`## What this measurement does and does not establish`);
  log();
  log(
    `**Does:** for each of ${questions.length} fixed prompts, sampled ${args.trials} ` +
      `times, how often ONE mechanically extracted fact contradicts the snapshot DB.`,
  );
  log();
  log(
    `**Does not:** it is not a fabrication rate for the advisor as a whole. ` +
      `${questions.length} prompts about ${questions.length} sections of one department ` +
      `in one term is not a sample of the question space, so nothing here generalizes to ` +
      `questions that were not asked. Repeats of the same prompt are not independent ` +
      `evidence about the system, so per-question results must not be pooled into a ` +
      `single ${questions.length * args.trials}-draw interval. And only the extracted ` +
      `fact is checked — the surrounding answer is never verified, so a trial can be ` +
      `counted \`tool_backed\` while the rest of the answer is wrong.`,
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
        verdict.cls === "unclassifiable" ||
        examples.filter((e) => e.cls === verdict.cls).length < 1
      ) {
        examples.push({
          cls: verdict.cls,
          extracted: verdict.extracted,
          candidates: verdict.candidates,
          answer: obs.answer.slice(0, 600),
          tools: obs.toolCallCount,
        });
      }
      process.stderr.write(
        `[${q.id} ${i + 1}/${args.trials}] ${verdict.cls}` +
          `${verdict.extracted === null ? "" : ` (${verdict.extracted})`}` +
          `${verdict.candidates ? ` (candidates ${verdict.candidates.join(" | ")})` : ""}` +
          ` tools=${obs.toolCallCount} ${Math.round((Date.now() - t0) / 1000)}s\n`,
      );
    }

    const after = await fetchEndpointState(ADVISOR_BASE_URL, model);
    const validity = blockValidity(before, after);
    results.push({
      q,
      trials: args.trials,
      counts,
      fabricatedInterval: wilsonInterval(counts.fabricated, args.trials),
      toolBackedInterval: wilsonInterval(counts.tool_backed, args.trials),
      valid: validity.valid,
      validity: validity.reason,
      examples,
      elapsedMs: Date.now() - t0,
    });

    // Checkpoint after every question.
    //
    // The previous run of this probe was SIGTERM'd by a 2-minute foreground
    // timeout at trial 22 of 100, and because the report was only written after
    // ALL questions finished, it left no summary table, no intervals and no
    // validity block — a run that did 22% of the work and looked like a short
    // successful one. Partial evidence on disk beats none, and the sentinel
    // written at the end of main() is what distinguishes the two.
    if (args.report) {
      writeFileSync(
        args.report,
        [...out, "", `_RUN INCOMPLETE — checkpoint after \`${q.id}\`._`, ""].join("\n"),
      );
    }
  }

  // ---- results -------------------------------------------------------------
  log(`## Results — per question`);
  log();
  log(
    `\`fabricated\` is the number that matters. \`unsupported\` is a separate ` +
      `failure: the fact was right but no tool was called, so it is luck rather than ` +
      `grounding and will not survive a schedule change. \`unclassifiable\` is not a ` +
      `model failure at all — it is the instrument declining to judge an answer whose ` +
      `reading it could not determine, and it is never folded into \`fabricated\` or ` +
      `\`no_fact\`.`,
  );
  log();
  log(
    `\`tool_backed\` means \`toolCallCount > 0\` AND the one extracted fact equals ` +
      `the DB value. It does NOT establish that the answer was about the CRN, term or ` +
      `section asked about, that the tool call is where the fact came from, or that ` +
      `the rest of the answer was correct. Each of those would need a check this ` +
      `harness does not perform.`,
  );
  log();
  log(
    `**Read the per-question rows, not the pooled row.** Each question is its own ` +
      `experiment; the trials within a question are repeated draws on ONE prompt, so ` +
      `pooling ${questions.length} questions into ${questions.length * args.trials} ` +
      `i.i.d. draws would narrow the interval by assuming independence the design does ` +
      `not have. The per-question interval below is the defensible one.`,
  );
  log();
  log(
    `| question | hard | truth | n | tool_backed | fabricated | unsupported | abstained | no_fact | unclassifiable | http_error | unparseable | fabrication rate (95% CI) | tool_backed rate (95% CI) | block |`,
  );
  log(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|`);
  for (const r of results) {
    const c = r.counts;
    log(
      `| \`${r.q.id}\` | ${r.q.hard ? "yes" : "no"} | \`${r.q.truth}\` | ${r.trials} | ` +
        `${c.tool_backed} | ${c.fabricated} | ${c.unsupported} | ${c.abstained} | ${c.no_fact} | ` +
        `${c.unclassifiable} | ${c.http_error} | ${c.unparseable} | ` +
        `${r.valid ? formatInterval(r.fabricatedInterval) : "WITHHELD"} | ` +
        `${r.valid ? formatInterval(r.toolBackedInterval) : "WITHHELD"} | ` +
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
    log(`## Aggregate (valid blocks only) — COUNTS ONLY`);
    log();
    log(
      `No pooled confidence interval is printed here, and one must not be computed ` +
        `from these counts. Pooling treats ${validResults.length} questions x ` +
        `${args.trials} trials as ${n} independent draws; they are not — each question ` +
        `is one prompt sampled repeatedly, so the effective sample size for "does this ` +
        `system fabricate" is closer to ${validResults.length} than to ${n}. A pooled ` +
        `interval is therefore several times narrower than the evidence supports, and ` +
        `it is the number that gets quoted downstream.`,
    );
    log();
    log(
      `The honest per-class summary is the WORST per-question upper bound: with ` +
        `${args.trials} trials, a question that never fails still has a 95% Wilson ` +
        `upper bound near ` +
        `${formatInterval(wilsonInterval(0, args.trials)).trim()}, not near zero.`,
    );
    log();
    log(`| class | count | of n | worst per-question rate (95% CI) |`);
    log(`|---|---:|---:|---|`);
    for (const k of FAB_CLASSES) {
      // Widest per-question interval, by upper bound. Reporting the worst block
      // rather than the pool keeps the claim inside what the design measured.
      const worst = validResults
        .map((r) => wilsonInterval(r.counts[k], r.trials))
        .reduce((a, b) => (b.high > a.high ? b : a));
      log(`| ${k} | ${agg[k]} | ${n} | ${formatInterval(worst)} |`);
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
        `- **${e.cls}** (extracted \`${e.extracted ?? "—"}\`` +
          `${e.candidates ? `, competing readings \`${e.candidates.join("` / `")}\`` : ""}` +
          `, truth \`${r.q.truth}\`, ` +
          `${e.tools} tool call${e.tools === 1 ? "" : "s"}): ${JSON.stringify(e.answer)}`,
      );
    }
    log();
  }

  log(
    `_This harness reports counts, intervals and raw generations. It does not ` +
      `interpret its own output._`,
  );
  log();
  // Completion sentinel. A truncated run now says so on its own, instead of
  // being indistinguishable from a complete one.
  log(
    `RUN COMPLETE — ${questions.length} question(s) x ${args.trials} trials = ` +
      `${questions.length * args.trials} trials, finished ${new Date().toISOString()}.`,
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
  // Fail loudly and non-zero. A measurement harness that dies quietly is worse
  // than one that crashes: the caller reads a partial result as a whole one.
  await main().catch((err: unknown) => {
    console.error(`FABRICATION PROBE FAILED: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
