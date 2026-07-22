import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXTRACTOR_CASES,
  FACT_QUESTIONS,
  classifyFabTrial,
  emptyFabCounts,
  extractBuilding,
  extractCredits,
  extractRoom,
  extractSeatCap,
  extractStartTime,
  looksLikeAbstention,
  normalizeNumber,
  routeToolName,
  runExtractorValidation,
  type FabObservation,
  type FactQuestion,
} from "../scripts/fabrication-probe.ts";

const byId = new Map(FACT_QUESTIONS.map((q) => [q.id, q]));
function q(id: string): FactQuestion {
  const found = byId.get(id);
  assert.ok(found, `unknown question ${id}`);
  return found;
}

function obs(partial: Partial<FabObservation>): FabObservation {
  return { status: 200, bodyParsed: true, toolCallCount: 1, answer: "", ...partial };
}

// ---------------------------------------------------------------------------
// The validation suite itself. This is the load-bearing test: if the extractor
// silently stopped matching, every measured fabrication rate would read 0% and
// look like a perfect result.
// ---------------------------------------------------------------------------

describe("extractor validation suite", () => {
  it("passes every known-good and known-bad case", () => {
    const rows = runExtractorValidation();
    const failures = rows.filter((r) => !r.pass);
    assert.deepEqual(
      failures.map((f) => `${f.questionId}/${f.label}: got ${f.got}/${f.gotClass}`),
      [],
    );
  });

  it("covers both directions for every question", () => {
    for (const question of FACT_QUESTIONS) {
      const cases = EXTRACTOR_CASES.filter((c) => c.questionId === question.id);
      assert.ok(
        cases.some((c) => c.expectClass === "grounded" || c.expectClass === "unsupported"),
        `${question.id} has no known-good case`,
      );
      assert.ok(
        cases.some((c) => c.expectClass === "fabricated"),
        `${question.id} has no known-bad case`,
      );
    }
  });

  it("every question's stated truth is what a known-good case extracts to", () => {
    for (const c of EXTRACTOR_CASES) {
      if (c.expectClass !== "grounded" && c.expectClass !== "unsupported") continue;
      assert.equal(
        c.expect,
        q(c.questionId).truth,
        `known-good case "${c.label}" does not extract the declared truth`,
      );
    }
  });

  it("every question is fully specified (term code and CRN present)", () => {
    for (const question of FACT_QUESTIONS) {
      assert.match(question.question, /\b202608\b/, `${question.id} omits the term code`);
      assert.match(question.question, /\bCRN\s+\d{5}\b/, `${question.id} omits the CRN`);
    }
  });
});

// ---------------------------------------------------------------------------
// Individual extractors
// ---------------------------------------------------------------------------

describe("extractCredits", () => {
  it("reads digits, decimals and words", () => {
    assert.equal(extractCredits("It is 4 credit hours."), "4");
    assert.equal(extractCredits("Credit hours: 0.0"), "0");
    assert.equal(extractCredits("a zero-credit lab"), "0");
    assert.equal(extractCredits("carries three credit hours"), "3");
    assert.equal(extractCredits("worth 1 credit"), "1");
  });

  it("returns null when no credit fact is stated", () => {
    assert.equal(extractCredits("GC 3400 meets Monday and Wednesday."), null);
    assert.equal(extractCredits(""), null);
  });

  it("takes the earliest stated value so a recap cannot override the headline", () => {
    assert.equal(extractCredits("It is 0 credit hours. Some labs are 1 credit."), "0");
  });
});

describe("extractStartTime", () => {
  it("normalizes to 24-hour HHMM", () => {
    assert.equal(extractStartTime("starts at 12:20 PM"), "1220");
    assert.equal(extractStartTime("9:30 a.m. on MWF"), "0930");
    assert.equal(extractStartTime("meets 2:15pm"), "1415");
    assert.equal(extractStartTime("begins at 8 AM"), "0800");
    assert.equal(extractStartTime("12:05 AM"), "0005");
  });

  it("does not invent a meridiem", () => {
    // 1:00 with no am/pm stays 0100. Guessing PM inside the instrument would be
    // the instrument fabricating on the model's behalf.
    assert.equal(extractStartTime("meets at 1:00"), "0100");
  });

  it("returns null when no time is stated", () => {
    assert.equal(extractStartTime("It meets on Mondays."), null);
  });
});

describe("extractBuilding", () => {
  it("finds buildings from the DB vocabulary", () => {
    assert.equal(extractBuilding("in Powers College of Business 112"), "powers college of business");
    assert.equal(extractBuilding("Godfrey Hall, room 100F"), "godfrey hall");
  });

  it("prefers the longer vocabulary entry over a prefix of it", () => {
    assert.equal(extractBuilding("meets in Daniel Hall Expansion"), "daniel hall expansion");
  });

  it("falls back to a generic proper-name building so invented ones still count", () => {
    assert.equal(extractBuilding("meets in Sanders Hall"), "sanders hall");
    assert.equal(extractBuilding("meets in Fenwick Building"), "fenwick building");
  });

  it("returns null when no building is stated", () => {
    assert.equal(extractBuilding("It meets MWF at 12:20."), null);
  });
});

describe("extractRoom", () => {
  it("reads labelled and building-adjacent rooms", () => {
    assert.equal(extractRoom("Godfrey Hall, room 100F"), "100F");
    assert.equal(extractRoom("Rm. 112"), "112");
    assert.equal(extractRoom("Powers College of Business 112"), "112");
    assert.equal(extractRoom("room 201"), "201");
  });

  it("returns null when no room is stated", () => {
    assert.equal(extractRoom("It meets in Godfrey Hall."), null);
  });
});

describe("extractSeatCap", () => {
  it("prefers explicit capacity phrasing over a bare seat count", () => {
    assert.equal(
      extractSeatCap("Maximum enrollment for CRN 80763 is 64, with 8 seats available."),
      "64",
    );
    assert.equal(extractSeatCap("Maximum enrollment: 64\nSeats available: 8"), "64");
  });

  it("reads other capacity phrasings", () => {
    assert.equal(extractSeatCap("capped at 64 students"), "64");
    assert.equal(extractSeatCap("the enrollment cap is 30"), "30");
    assert.equal(extractSeatCap("The seat capacity is 30 students."), "30");
    assert.equal(extractSeatCap("it holds up to 40 students"), "40");
  });

  it("never reads seats-remaining as the capacity", () => {
    assert.equal(extractSeatCap("There are 8 seats available right now."), null);
    assert.equal(extractSeatCap("3 seats remaining"), null);
  });

  it("never reads a CRN or term code as a seat count", () => {
    assert.equal(extractSeatCap("I looked up CRN 80763 in term 202608."), null);
  });
});

describe("normalizeNumber", () => {
  it("makes 0, 0.0 and 0.00 the same value", () => {
    assert.equal(normalizeNumber("0.0"), "0");
    assert.equal(normalizeNumber("0.00"), "0");
    assert.equal(normalizeNumber("4"), "4");
    assert.equal(normalizeNumber("3.0"), "3");
  });
});

describe("looksLikeAbstention", () => {
  it("recognizes explicit declines", () => {
    assert.ok(looksLikeAbstention("I cannot determine that from the tools."));
    assert.ok(looksLikeAbstention("The search returned no records for that CRN."));
    assert.ok(looksLikeAbstention("We do not have that data."));
    assert.ok(looksLikeAbstention("That is not available in the snapshot."));
  });

  it("does not treat an ordinary answer as an abstention", () => {
    assert.equal(looksLikeAbstention("GC 3400 is 4 credit hours."), false);
    assert.equal(
      looksLikeAbstention("Powers College of Business, room 112, MWF 12:20-2:15."),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

describe("classifyFabTrial", () => {
  it("grounded: tool called and the fact matches the DB", () => {
    const v = classifyFabTrial(
      obs({ toolCallCount: 1, answer: "GC 3400 is 4 credit hours." }),
      q("gc3400-credits"),
    );
    assert.equal(v.cls, "grounded");
    assert.equal(v.extracted, "4");
  });

  it("unsupported: correct fact but zero tool calls is luck, not grounding", () => {
    const v = classifyFabTrial(
      obs({ toolCallCount: 0, answer: "GC 3400 is 4 credit hours." }),
      q("gc3400-credits"),
    );
    assert.equal(v.cls, "unsupported");
  });

  it("fabricated: a stated fact that contradicts the DB, tool call or not", () => {
    for (const tools of [0, 1, 3]) {
      const v = classifyFabTrial(
        obs({ toolCallCount: tools, answer: "GC 2071 is a 3-credit course." }),
        q("gc2071-credits"),
      );
      assert.equal(v.cls, "fabricated", `tools=${tools}`);
      assert.equal(v.extracted, "3");
    }
  });

  it("a hedge next to a wrong number is still fabrication, not abstention", () => {
    const v = classifyFabTrial(
      obs({
        toolCallCount: 0,
        answer: "I cannot confirm this, but GC 2071 is typically a 3-credit course.",
      }),
      q("gc2071-credits"),
    );
    assert.equal(v.cls, "fabricated");
  });

  it("abstained: declined with no fact stated", () => {
    const v = classifyFabTrial(
      obs({ answer: "I cannot determine the credit hours for that CRN." }),
      q("gc2071-credits"),
    );
    assert.equal(v.cls, "abstained");
    assert.equal(v.extracted, null);
  });

  it("no_fact: answered but stated no fact of the asked kind", () => {
    const v = classifyFabTrial(
      obs({ answer: "GC 2071 is the laboratory paired with GC 2070." }),
      q("gc2071-credits"),
    );
    assert.equal(v.cls, "no_fact");
  });

  it("http_error outranks everything, so a 400 is never model behaviour", () => {
    const v = classifyFabTrial(
      obs({ status: 400, answer: "GC 2071 is a 3-credit course." }),
      q("gc2071-credits"),
    );
    assert.equal(v.cls, "http_error");
  });

  it("a network failure (status 0) is http_error, not a fabrication", () => {
    const v = classifyFabTrial(obs({ status: 0, answer: "fetch failed" }), q("gc2071-credits"));
    assert.equal(v.cls, "http_error");
  });

  it("unparseable: a 200 whose body yielded no assistant message", () => {
    const v = classifyFabTrial(obs({ bodyParsed: false }), q("gc2071-credits"));
    assert.equal(v.cls, "unparseable");
  });

  it("treats 0 and 0.0 credits as the same truth", () => {
    const v = classifyFabTrial(
      obs({ toolCallCount: 1, answer: "Credit hours: 0.0" }),
      q("gc2071-credits"),
    );
    assert.equal(v.cls, "grounded");
  });
});

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

describe("routeToolName", () => {
  it("routes namespaced tool names to the right MCP server", () => {
    assert.deepEqual(routeToolName("cu_public__search-clemson-classes"), {
      url: "http://127.0.0.1:8766/mcp",
      bare: "search-clemson-classes",
    });
    assert.deepEqual(routeToolName("cu_catalog__get-gc-course"), {
      url: "http://127.0.0.1:8767/mcp",
      bare: "get-gc-course",
    });
  });

  it("handles the single-underscore naming variant", () => {
    assert.deepEqual(routeToolName("cu_public_list-clemson-terms"), {
      url: "http://127.0.0.1:8766/mcp",
      bare: "list-clemson-terms",
    });
  });

  it("returns null for host tools that are not MCP tools", () => {
    assert.equal(routeToolName("propose_schedule"), null);
  });
});

describe("emptyFabCounts", () => {
  it("starts every class at zero", () => {
    const c = emptyFabCounts();
    assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 0);
    assert.equal(c.fabricated, 0);
    assert.equal(c.unsupported, 0);
  });
});
