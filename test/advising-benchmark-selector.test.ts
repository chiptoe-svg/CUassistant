// test/advising-benchmark-selector.test.ts
//
// Offline unit tests for scripts/advising-benchmark/selector.ts — the
// host-side, benchmark-only tool-subset selector prototype. No network, no
// live model calls, no MCP bridge: exercises only the pure group map and
// keyword router against the real SCENARIOS prompts (scripts/advising-
// benchmark/scenarios.ts) so "does the router actually differentiate on the
// real scenarios" is checked against the real fixture text, not a paraphrase
// of it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_GROUPED_TOOL_NAMES,
  GROUP_TOOL_NAMES,
  routeGroups,
  selectToolSubset,
  TOOL_GROUPS,
  type NamedTool,
} from "../scripts/advising-benchmark/selector.ts";
import { SCENARIOS } from "../scripts/advising-benchmark/scenarios.ts";

// The live tool inventory per the task brief, cross-checked against
// src/mcp-tools/*.ts and src/mcp-catalog.ts's renameRegisteredTool calls
// (public/scheduling + catalog/curriculum tools are grepped and confirmed
// directly there; the wiki tools live on a separate, not-yet-vendored
// service, so those 6 names are taken from the brief as the authoritative
// inventory — see selector.ts's GROUP_TOOL_NAMES doc comment).
const LIVE_TOOL_INVENTORY: readonly string[] = [
  // Public/scheduling (8766)
  "search-clemson-classes",
  "get-clemson-section-details",
  "check-schedule-conflicts",
  "find-conflict-free-schedule",
  "get-clemson-room-availability",
  "find-clemson-instructor-classes",
  "list-clemson-terms",
  "list-skills",
  "get-skill-docs",
  // Catalog/curriculum (8767)
  "find-eligible-sections",
  "audit-gc-progress",
  "get-gc-course",
  "get-gc-gen-ed",
  "get-gc-program-plan",
  "get-gc-requirement-rules",
  "list-gc-catalog-years",
  "list-gc-skills",
  "get-gc-skill-docs",
  // Wiki
  "list_wiki",
  "read_wiki",
  "search_wiki",
  "coverage_for_target",
  "prereq_chain",
  "search_curriculum",
];

function tool(name: string): NamedTool {
  return { name };
}

const ALL_TOOLS: NamedTool[] = LIVE_TOOL_INVENTORY.map(tool);

// --- group-map exhaustiveness -------------------------------------------------

describe("GROUP_TOOL_NAMES exhaustiveness", () => {
  it("has exactly 24 tools total, matching the live inventory's count", () => {
    assert.equal(LIVE_TOOL_INVENTORY.length, 24);
    assert.equal(ALL_GROUPED_TOOL_NAMES.length, 24);
  });

  it("every one of the 24 live tool names maps to exactly one group", () => {
    for (const name of LIVE_TOOL_INVENTORY) {
      const owningGroups = TOOL_GROUPS.filter((g) => GROUP_TOOL_NAMES[g].includes(name));
      assert.equal(
        owningGroups.length,
        1,
        `"${name}" should belong to exactly 1 group, found in [${owningGroups.join(", ")}]`,
      );
    }
  });

  it("no grouped tool name is orphaned (present in the live inventory) or a stray " +
    "(present in a group but absent from the live inventory)", () => {
    const grouped = new Set(ALL_GROUPED_TOOL_NAMES);
    const live = new Set(LIVE_TOOL_INVENTORY);
    for (const name of live) assert.ok(grouped.has(name), `"${name}" is not grouped`);
    for (const name of grouped) assert.ok(live.has(name), `"${name}" is grouped but not a live tool`);
  });

  it("no tool name is double-counted across groups", () => {
    const seen = new Set<string>();
    for (const g of TOOL_GROUPS) {
      for (const name of GROUP_TOOL_NAMES[g]) {
        assert.ok(!seen.has(name), `"${name}" appears in more than one group`);
        seen.add(name);
      }
    }
  });

  it("META always includes the 4 skill-reading tools (2 public + 2 gc-catalog)", () => {
    assert.deepEqual(
      [...GROUP_TOOL_NAMES.META].sort(),
      ["get-gc-skill-docs", "get-skill-docs", "list-gc-skills", "list-skills"].sort(),
    );
  });
});

// --- router differentiation on the REAL scenarios -----------------------------

function scenarioPrompt(id: string): string {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s.prompt;
}

describe("routeGroups on the real SCENARIOS prompts", () => {
  it("S1 (natural-key section/seat lookup) routes to SCHEDULING (+ always-on META)", () => {
    const groups = routeGroups(scenarioPrompt("S1"));
    assert.deepEqual([...groups].sort(), ["META", "SCHEDULING"].sort());
  });

  it("S2 (ambiguous section add, no literal 'schedule'/'time' keyword) still routes " +
    "to SCHEDULING (+ META) via the extended add/weekday signals", () => {
    const groups = routeGroups(scenarioPrompt("S2"));
    assert.deepEqual([...groups].sort(), ["META", "SCHEDULING"].sort());
  });

  it("S3 (pure conflict screen against a pasted schedule) routes to SCHEDULING ONLY " +
    "(+ META) — NOT CURRICULUM, NOT the full 24-tool surface", () => {
    const groups = routeGroups(scenarioPrompt("S3"));
    assert.deepEqual([...groups].sort(), ["META", "SCHEDULING"].sort());
    assert.ok(!groups.has("CURRICULUM"));
    assert.ok(!groups.has("WIKI"));
  });

  it("S4 (counterfactual lab-switch conflict check) routes to SCHEDULING ONLY (+ META)", () => {
    const groups = routeGroups(scenarioPrompt("S4"));
    assert.deepEqual([...groups].sort(), ["META", "SCHEDULING"].sort());
  });

  it("S5 (specialty/technical requirement search with hard time/day constraints) " +
    "routes to SCHEDULING+CURRICULUM (+ META)", () => {
    const groups = routeGroups(scenarioPrompt("S5"));
    assert.deepEqual([...groups].sort(), ["CURRICULUM", "META", "SCHEDULING"].sort());
  });
});

describe("selectToolSubset tool counts on the real scenarios", () => {
  it("S3/S4 select a SMALL subset (~7 scheduling + 4 META = 11), nowhere near the full 24", () => {
    for (const id of ["S3", "S4"]) {
      const selected = selectToolSubset(ALL_TOOLS, scenarioPrompt(id));
      assert.equal(selected.length, GROUP_TOOL_NAMES.SCHEDULING.length + GROUP_TOOL_NAMES.META.length);
      assert.ok(selected.length < ALL_TOOLS.length);
    }
  });

  it("S5 selects a LARGER subset than S3/S4 (scheduling + curriculum + meta)", () => {
    const s3Selected = selectToolSubset(ALL_TOOLS, scenarioPrompt("S3"));
    const s5Selected = selectToolSubset(ALL_TOOLS, scenarioPrompt("S5"));
    assert.ok(
      s5Selected.length > s3Selected.length,
      `expected S5 (${s5Selected.length}) > S3 (${s3Selected.length})`,
    );
    assert.equal(
      s5Selected.length,
      GROUP_TOOL_NAMES.SCHEDULING.length + GROUP_TOOL_NAMES.CURRICULUM.length + GROUP_TOOL_NAMES.META.length,
    );
  });
});

// --- composition + safe fallback ----------------------------------------------

describe("routeGroups composition and fallback", () => {
  it("COMPOSES (unions) groups for a multi-domain request rather than picking one", () => {
    const groups = routeGroups(
      "Does GC 3720 fit her schedule with no conflict, and does it also count toward her Specialty Area requirement?",
    );
    assert.ok(groups.has("SCHEDULING"));
    assert.ok(groups.has("CURRICULUM"));
    assert.ok(groups.has("META"));
    assert.ok(!groups.has("WIKI"));
  });

  it("adds WIKI only on an explicit wiki/explain signal, alongside whatever else matched", () => {
    const groups = routeGroups("Can you explain the wiki policy on prerequisite grandfathering?");
    assert.ok(groups.has("WIKI"));
    assert.ok(groups.has("CURRICULUM")); // "prerequisite" signal
  });

  it("an unmatched request falls back to SCHEDULING+CURRICULUM (+ META), never empty", () => {
    const groups = routeGroups("What is the weather like on campus today?");
    assert.deepEqual([...groups].sort(), ["CURRICULUM", "META", "SCHEDULING"].sort());
  });

  it("selectToolSubset on a totally unmatched request returns a non-empty, generous subset", () => {
    const selected = selectToolSubset(ALL_TOOLS, "What is the weather like on campus today?");
    assert.ok(selected.length > 0);
    assert.equal(
      selected.length,
      GROUP_TOOL_NAMES.SCHEDULING.length + GROUP_TOOL_NAMES.CURRICULUM.length + GROUP_TOOL_NAMES.META.length,
    );
  });

  it("an empty request string still falls back safely, never empty", () => {
    const selected = selectToolSubset(ALL_TOOLS, "");
    assert.ok(selected.length > 0);
  });
});

// --- selectToolSubset mechanics ------------------------------------------------

describe("selectToolSubset mechanics", () => {
  it("filters the GIVEN tools array by name — a tool present in a matched group " +
    "but absent from the input array is simply not returned (not fabricated)", () => {
    const partial: NamedTool[] = [tool("search-clemson-classes"), tool("list-skills")];
    const selected = selectToolSubset(partial, scenarioPrompt("S3"));
    assert.deepEqual(selected, partial); // both belong to SCHEDULING/META, both present
  });

  it("a custom router can be injected (the seam for a future cheap-LLM router)", () => {
    const alwaysWiki = () => new Set<"WIKI">(["WIKI"]) as ReadonlySet<import("../scripts/advising-benchmark/selector.ts").ToolGroup>;
    const selected = selectToolSubset(ALL_TOOLS, "anything", alwaysWiki);
    assert.deepEqual(
      selected.map((t) => t.name).sort(),
      [...GROUP_TOOL_NAMES.WIKI].sort(),
    );
  });
});
