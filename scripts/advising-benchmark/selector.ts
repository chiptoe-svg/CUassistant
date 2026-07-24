// scripts/advising-benchmark/selector.ts
//
// PROTOTYPE host-side tool-subset selector for the advising-model benchmark.
// Measure-first: this module exists so scripts/advising-benchmark/report.ts
// can run an OPTIONAL `--tool-selection selector` arm and compare it against
// today's `full` (all 24 tools, every scenario) arm on malformed rate,
// latency, and correctness — see
// docs/superpowers/specs/2026-07-23-tool-surface-architecture-notes.md,
// Decision 1 ("route, don't nest") and the Latency section's item 2.
//
// This is BENCHMARK-ONLY. It is wired into report.ts's orchestrator behind an
// additive, default-off flag. It does NOT touch src/advisor-agent.ts or any
// live advisor code path — production wiring is a later, separately-gated
// step once this prototype's numbers justify it. The Pi constraint that tools
// are fixed at harness construction is a non-issue here: selection happens
// once per scenario, before any trial's harness is built, exactly like
// construction-time selection would in the live advisor.
//
// ---------------------------------------------------------------------------
// Design decisions made explicit (per the task brief's "ask if ambiguous"):
//
// 1. META (the 4 skill-reading tools: list-skills, get-skill-docs,
//    list-gc-skills, get-gc-skill-docs) is ALWAYS included in every selection,
//    regardless of what the router matches. Skills are how this codebase
//    documents its own tools/policies to the model at runtime (see
//    src/mcp-tools/skills.ts / src/mcp-catalog.ts's renameRegisteredTool for
//    list-gc-skills/get-gc-skill-docs) — dropping them when, say, only
//    SCHEDULING is selected would silently remove the model's ability to read
//    its own skill docs for a domain it might still need context on. The
//    brief explicitly allowed making this configurable instead; the simpler,
//    default-on choice is taken here (Working Rules: simplest thing that
//    works, no unrequested flexibility) with this seam: swap ALWAYS_ON_GROUPS
//    below to `[]` and thread a caller-supplied set through selectToolSubset
//    if a future benchmark run wants to measure "META off" too.
//
// 2. find-eligible-sections is CURRICULUM's tool, not a separate shared
//    bucket. It's the requirement -> offered-sections join (see
//    src/mcp-tools/clemson-advising.ts), i.e. it *answers* a curriculum
//    question ("what satisfies requirement X") using scheduling data as an
//    implementation detail — the question it answers is what determines the
//    group, not the tables it happens to read. This is also the reading the
//    brief itself states in Deliverable 1 item 1.
//
// 3. The literal signal-word lists in the brief ("time, section, CRN,
//    conflict, seat, room, fit, schedule" / "requirement, specialty,
//    technical, eligible, audit, degree, graduate, gen-ed, prereq, catalog")
//    are representative starting points, not exhaustive — e.g. neither list
//    contains a word appearing in the real S2 scenario prompt ("She wants to
//    add GC 4060, Tuesday/Thursday at 11."), which must still route to
//    SCHEDULING alone per the brief's own stated expectation. This module
//    extends the SCHEDULING list with registration verbs (add/drop),
//    meeting/day vocabulary, and weekday names — all squarely "scheduling"
//    signals in this domain — so real advising phrasing like S2's is caught
//    without the literal keyword "schedule" or "time" appearing in the text.
// ---------------------------------------------------------------------------

/**
 * Functional tool groups. NOT per-MCP-server: SCHEDULING and CURRICULUM each
 * pull from one physical server today (8766 and 8767 respectively) but the
 * grouping is by what QUESTION the tool answers, and WIKI/META cut across
 * server boundaries entirely (META tools live on both 8766 and 8767; WIKI is
 * its own service). See GROUP_TOOL_NAMES below for the full map.
 */
export type ToolGroup = "SCHEDULING" | "CURRICULUM" | "WIKI" | "META";

export const TOOL_GROUPS: readonly ToolGroup[] = [
  "SCHEDULING",
  "CURRICULUM",
  "WIKI",
  "META",
] as const;

/**
 * Every one of the live advisor's 24 tools, mapped to exactly one group.
 * Source: scripts/advising-benchmark/selector-brief.md's inventory, confirmed
 * against src/mcp-tools/{clemson-classes,clemson-schedule,clemson-advising,
 * catalog,skills}.ts and src/mcp-catalog.ts's renameRegisteredTool calls for
 * the gc-prefixed skill tools. The wiki tools (list_wiki, read_wiki,
 * search_wiki, coverage_for_target, prereq_chain, search_curriculum) are
 * served by a separate process (ADVISOR_MCP_WIKI_URL in src/config.ts) not
 * yet vendored into this repo, so their names are taken from the brief's
 * inventory rather than confirmed by grep here — see the
 * "GROUP_TOOL_NAMES exhaustiveness" describe block in
 * test/advising-benchmark-selector.test.ts, which checks this map against a
 * literal LIVE_TOOL_INVENTORY constant (the same 24 names).
 */
export const GROUP_TOOL_NAMES: Readonly<Record<ToolGroup, readonly string[]>> = {
  SCHEDULING: [
    "search-clemson-classes",
    "get-clemson-section-details",
    "check-schedule-conflicts",
    "find-conflict-free-schedule",
    "get-clemson-room-availability",
    "find-clemson-instructor-classes",
    "list-clemson-terms",
  ],
  CURRICULUM: [
    "find-eligible-sections",
    "audit-gc-progress",
    "get-gc-course",
    "get-gc-gen-ed",
    "get-gc-program-plan",
    "get-gc-requirement-rules",
    "list-gc-catalog-years",
  ],
  WIKI: [
    "list_wiki",
    "read_wiki",
    "search_wiki",
    "coverage_for_target",
    "prereq_chain",
    "search_curriculum",
  ],
  META: ["list-skills", "get-skill-docs", "list-gc-skills", "get-gc-skill-docs"],
};

/** Flattened union of every grouped tool name, for exhaustiveness checks. */
export const ALL_GROUPED_TOOL_NAMES: readonly string[] = TOOL_GROUPS.flatMap(
  (g) => GROUP_TOOL_NAMES[g],
);

/** Groups that are unconditionally included in every selection. See design
 *  decision 1 above. */
const ALWAYS_ON_GROUPS: readonly ToolGroup[] = ["META"];

/** Groups returned when the router matches nothing at all — a safe, generous
 *  default (never empty), per the brief. */
const FALLBACK_GROUPS: readonly ToolGroup[] = ["SCHEDULING", "CURRICULUM"];

// ---------------------------------------------------------------------------
// The deterministic keyword router. PURE, zero network, zero LLM call — v1
// per the brief. `DEFAULT_ROUTER` below is the seam for a future cheap-LLM
// router: any replacement just needs to match this same
// `(requestText: string) => ReadonlySet<ToolGroup>` shape and can be swapped
// in via the `router` parameter of selectToolSubset without touching
// report.ts's call site.
// ---------------------------------------------------------------------------

const SCHEDULING_SIGNAL_WORDS: readonly string[] = [
  "time",
  "section",
  "crn",
  "conflict",
  "seat",
  "room",
  "fit",
  "schedule",
  "meet",
  "meets",
  "meeting",
  "class",
  "add",
  "drop",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
];

const CURRICULUM_SIGNAL_WORDS: readonly string[] = [
  "requirement",
  "requirements",
  "eligible",
  "eligibility",
  "audit",
  "degree",
  "graduate",
  "graduation",
  "gen-ed",
  "gened",
  "prereq",
  "prerequisite",
  "catalog",
];

/**
 * "specialty" and "technical" are in the brief's own curriculum-signal list,
 * but as BARE words they false-positive on this benchmark's own fixture data:
 * FIXTURE_PASTE (scenarios.ts, shared by S3/S4/S5) contains the real GC
 * course titles "Package and Specialty Printing" and "Technical
 * Communication and Information Design" — ordinary English, not a curriculum
 * intent signal. That collision is exactly what would have broken the
 * "S3/S4 -> SCHEDULING only" property the brief requires (both scenarios
 * paste that same fixture). Matched as PHRASES instead — "specialty area"
 * and "technical requirement"/"gc technical" are how S5's real prompt
 * actually says it ("her Specialty Area or GC Technical requirement") and do
 * not appear in the fixture's course titles.
 */
const CURRICULUM_SIGNAL_PHRASES: readonly string[] = [
  "specialty area",
  "technical requirement",
  "gc technical",
];

const WIKI_SIGNAL_WORDS: readonly string[] = [
  "wiki",
  "explain",
  "policy",
  "background",
  "history",
  "overview",
  "glossary",
  "definition",
  "define",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `text` contains any of `words` as a whole word, case-insensitive. */
function matchesAny(text: string, words: readonly string[]): boolean {
  return words.some((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(text));
}

/** True if `text` contains any of `phrases` as a case-insensitive substring
 *  (word-bounded at both ends). Used for multi-word signals where the
 *  individual words are too ambiguous on their own — see
 *  CURRICULUM_SIGNAL_PHRASES. */
function matchesAnyPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => new RegExp(`\\b${escapeRegExp(p)}\\b`, "i").test(text));
}

/**
 * Deterministic keyword router: COMPOSES (unions) groups rather than picking
 * one. Per the brief: scheduling signals -> SCHEDULING; a curriculum signal
 * present -> ADD CURRICULUM (does not replace SCHEDULING); a wiki signal ->
 * ADD WIKI. META is always added (design decision 1). If nothing at all
 * matches, falls back to SCHEDULING+CURRICULUM rather than returning empty.
 */
export function routeGroups(requestText: string): ReadonlySet<ToolGroup> {
  const groups = new Set<ToolGroup>();
  if (matchesAny(requestText, SCHEDULING_SIGNAL_WORDS)) groups.add("SCHEDULING");
  if (
    matchesAny(requestText, CURRICULUM_SIGNAL_WORDS) ||
    matchesAnyPhrase(requestText, CURRICULUM_SIGNAL_PHRASES)
  ) {
    groups.add("CURRICULUM");
  }
  if (matchesAny(requestText, WIKI_SIGNAL_WORDS)) groups.add("WIKI");

  if (groups.size === 0) {
    for (const g of FALLBACK_GROUPS) groups.add(g);
  }
  for (const g of ALWAYS_ON_GROUPS) groups.add(g);
  return groups;
}

export type ToolRouter = (requestText: string) => ReadonlySet<ToolGroup>;

/** The default (v1) router. Exported as the explicit default so a future
 *  cheap-LLM router can be passed to selectToolSubset in its place without
 *  changing this constant's name at the call site. */
export const DEFAULT_ROUTER: ToolRouter = routeGroups;

// ---------------------------------------------------------------------------
// Selection over a real tool array (AgentTool[] from advisor-mcp.ts's bridge,
// or anything with a `.name`). Generic over T so tests can pass plain
// `{ name }` stubs without pulling in pi-agent-core.
// ---------------------------------------------------------------------------

export interface NamedTool {
  name: string;
}

/**
 * Select the subset of `tools` (by name) belonging to the groups the router
 * matches for `requestText`. Pure and deterministic — no network, no LLM
 * call. Never returns empty as long as `tools` contains at least one tool
 * from the matched (or fallback) groups.
 */
export function selectToolSubset<T extends NamedTool>(
  tools: readonly T[],
  requestText: string,
  router: ToolRouter = DEFAULT_ROUTER,
): T[] {
  const groups = router(requestText);
  const allowedNames = new Set<string>();
  for (const g of groups) {
    for (const name of GROUP_TOOL_NAMES[g]) allowedNames.add(name);
  }
  return tools.filter((t) => allowedNames.has(t.name));
}
