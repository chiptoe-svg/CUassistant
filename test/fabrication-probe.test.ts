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
  extractionValue,
  MIN_TRIALS,
  looksLikeAbstention,
  normalizeNumber,
  parseArgs,
  routeToolName,
  runExtractorValidation,
  type FabObservation,
  type FactQuestion,
} from "../scripts/fabrication-probe.ts";

// Extractors return a three-way Extraction ({found} | {none} | {ambiguous}).
// These read the value out, mapping BOTH "none" and "ambiguous" to null; the
// ambiguous case is asserted separately via the `amb` helper so the two are
// never conflated in a test either.
const cred = (t: string) => extractionValue(extractCredits(t));
const start = (t: string) => extractionValue(extractStartTime(t));
const bldg = (t: string) => extractionValue(extractBuilding(t));
const room = (t: string) => extractionValue(extractRoom(t));
const seats = (t: string) => extractionValue(extractSeatCap(t));

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
        cases.some((c) => c.expectClass === "tool_backed" || c.expectClass === "unsupported"),
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
      if (c.expectClass !== "tool_backed" && c.expectClass !== "unsupported") continue;
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
    assert.equal(cred("It is 4 credit hours."), "4");
    assert.equal(cred("Credit hours: 0.0"), "0");
    assert.equal(cred("a zero-credit lab"), "0");
    assert.equal(cred("carries three credit hours"), "3");
    assert.equal(cred("worth 1 credit"), "1");
  });

  it("returns null when no credit fact is stated", () => {
    assert.equal(cred("GC 3400 meets Monday and Wednesday."), null);
    assert.equal(cred(""), null);
  });

  it("takes the earliest stated value so a recap cannot override the headline", () => {
    assert.equal(cred("It is 0 credit hours. Some labs are 1 credit."), "0");
  });
});

describe("extractStartTime", () => {
  it("normalizes to 24-hour HHMM", () => {
    assert.equal(start("starts at 12:20 PM"), "1220");
    assert.equal(start("9:30 a.m. on MWF"), "0930");
    assert.equal(start("meets 2:15pm"), "1415");
    assert.equal(start("begins at 8 AM"), "0800");
    assert.equal(start("12:05 AM"), "0005");
  });

  it("does not invent a meridiem", () => {
    // 1:00 with no am/pm stays 0100. Guessing PM inside the instrument would be
    // the instrument fabricating on the model's behalf.
    assert.equal(start("meets at 1:00"), "0100");
  });

  it("returns null when no time is stated", () => {
    assert.equal(start("It meets on Mondays."), null);
  });
});

describe("extractBuilding", () => {
  it("finds buildings from the DB vocabulary", () => {
    assert.equal(bldg("in Powers College of Business 112"), "powers college of business");
    assert.equal(bldg("Godfrey Hall, room 100F"), "godfrey hall");
  });

  it("prefers the longer vocabulary entry over a prefix of it", () => {
    assert.equal(bldg("meets in Daniel Hall Expansion"), "daniel hall expansion");
  });

  it("falls back to a generic proper-name building so invented ones still count", () => {
    assert.equal(bldg("meets in Sanders Hall"), "sanders hall");
    assert.equal(bldg("meets in Fenwick Building"), "fenwick building");
  });

  it("returns null when no building is stated", () => {
    assert.equal(bldg("It meets MWF at 12:20."), null);
  });
});

describe("extractRoom", () => {
  it("reads labelled and building-adjacent rooms", () => {
    assert.equal(room("Godfrey Hall, room 100F"), "100F");
    assert.equal(room("Rm. 112"), "112");
    assert.equal(room("Powers College of Business 112"), "112");
    assert.equal(room("room 201"), "201");
  });

  it("returns null when no room is stated", () => {
    assert.equal(room("It meets in Godfrey Hall."), null);
  });
});

describe("extractSeatCap", () => {
  it("prefers explicit capacity phrasing over a bare seat count", () => {
    assert.equal(
      seats("Maximum enrollment for CRN 80763 is 64, with 8 seats available."),
      "64",
    );
    assert.equal(seats("Maximum enrollment: 64\nSeats available: 8"), "64");
  });

  it("reads other capacity phrasings", () => {
    assert.equal(seats("capped at 64 students"), "64");
    assert.equal(seats("the enrollment cap is 30"), "30");
    assert.equal(seats("The seat capacity is 30 students."), "30");
    assert.equal(seats("it holds up to 40 students"), "40");
  });

  it("never reads seats-remaining as the capacity", () => {
    assert.equal(seats("There are 8 seats available right now."), null);
    assert.equal(seats("3 seats remaining"), null);
  });

  it("never reads a CRN or term code as a seat count", () => {
    assert.equal(seats("I looked up CRN 80763 in term 202608."), null);
  });
});

// ---------------------------------------------------------------------------
// Multi-number prose. The first version of this suite had exactly one number in
// every fixture, passed 23/23, and then misclassified two of the first seven
// real answers — in opposite directions. These are the cases it never covered.
// ---------------------------------------------------------------------------

describe("extraction anchors to the asked-for fact, not its neighbour", () => {
  const jordanHall =
    "The maximum enrollment (seat capacity) for GC 1010 section 001 (CRN 80763) " +
    "in Fall 2026 is **64 students**. The section is currently meeting in Jordan " +
    "Hall G33, which has a physical room capacity of 102, but the enrollment " +
    "limit for the section itself is capped at 64.";

  it("a room's physical capacity is never read as the seat cap", () => {
    // 64 is the true cap; Jordan Hall G33 really does seat 102. Reading 102 here
    // reported a correct model as fabricating.
    assert.equal(seats(jordanHall), "64");
    assert.equal(seats("That section meets in Jordan Hall G33, room capacity 102."), null);
    assert.equal(seats("The room holds up to 102 students, but the section is capped at 64."), "64");
  });

  it("bold markers around the value do not hide it", () => {
    assert.equal(seats("The maximum enrollment (seat capacity) is **64**."), "64");
    assert.equal(cred("It is worth **4** credit hours."), "4");
  });

  it("a raw DB column name still reads as a cue", () => {
    assert.equal(seats("max_enrollment: 64"), "64");
  });

  it("an enrolled count is not the capacity", () => {
    assert.equal(seats("There are currently 56 students enrolled, and the maximum enrollment is 64."), "64");
  });

  it("an end time is never read as the start time", () => {
    assert.equal(start("It meets MWF from 12:20 PM to 2:15 PM."), "1220");
    assert.equal(start("The class ends at 2:15 PM; it starts at 12:20 PM."), "1220");
    assert.equal(start("The class ends at 2:15 PM."), null);
  });

  it("a building number is not a room number", () => {
    assert.equal(room("The lab is in Building 3."), null);
    assert.equal(room("Jordan Hall G33"), "G33");
    assert.equal(room("Godfrey Hall, room 100F, seats 20"), "100F");
  });

  it("a building named beside a room reads as one building", () => {
    assert.equal(bldg("meets in Powers College of Business, room 112, MWF 12:20-2:15 PM"), "powers college of business");
  });
});

// ---------------------------------------------------------------------------
// "I could not tell" must not look like "it was wrong".
// ---------------------------------------------------------------------------

describe("unclassifiable", () => {
  const amb = (e: { kind: string }) => e.kind === "ambiguous";
  const jordanRecap =
    "The maximum enrollment is 64. Note that other GC 1010 sections are capped at 30.";

  it("conflicting readings in one sentence are ambiguous, not a fabrication", () => {
    assert.ok(amb(extractSeatCap("The section capacity is 64 and the maximum enrollment is 72.")));
    assert.ok(amb(extractStartTime("Section 001 starts at 12:20 PM and section 002 starts at 9:30 AM.")));
    assert.ok(amb(extractBuilding("It meets in Godfrey Hall and Powers College of Business.")));
  });

  it("classifies an ambiguous reading as unclassifiable and reports the candidates", () => {
    const v = classifyFabTrial(
      obs({ toolCallCount: 1, answer: "The section capacity is 64 and the maximum enrollment is 72." }),
      q("gc1010-seatcap"),
    );
    assert.equal(v.cls, "unclassifiable");
    assert.equal(v.extracted, null);
    assert.deepEqual(v.candidates, ["64", "72"]);
  });

  it("is never reachable as fabricated or no_fact", () => {
    // The whole point: an answer the instrument cannot read must not be counted
    // as a wrong answer, nor as no answer at all.
    for (const cls of ["fabricated", "no_fact"]) {
      const v = classifyFabTrial(
        obs({ toolCallCount: 1, answer: "The section capacity is 64 and the maximum enrollment is 72." }),
        q("gc1010-seatcap"),
      );
      assert.notEqual(v.cls, cls);
    }
  });

  it("a trailing recap in a LATER sentence does not manufacture ambiguity", () => {
    assert.equal(cred("It is 0 credit hours. Some labs are 1 credit."), "0");
    assert.equal(seats(jordanRecap), "64");
  });

  it("counts unclassifiable as its own class", () => {
    const c = emptyFabCounts();
    assert.equal(c.unclassifiable, 0);
    assert.ok("unclassifiable" in c);
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
    assert.equal(v.cls, "tool_backed");
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
    assert.equal(v.cls, "tool_backed");
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

// ---------------------------------------------------------------------------
// Final review I5: the argv parser had a silent zero-trials path.
//
// `get("--trials")` returned the NEXT argv element whatever it was, so
// `--trials --report x` yielded Number("--report") -> NaN. `NaN < MIN_TRIALS` is
// false, so the underpowered refusal was skipped, the trial loop ran zero times,
// "RUN COMPLETE" printed and the process exited 0 — a report measuring nothing,
// indistinguishable from a real one. `--trials=100` had the mirror-image bug:
// indexOf never matched the equals form, so it silently used the default.
//
// The branch's headline numbers come from this instrument, so both spellings are
// pinned here.
// ---------------------------------------------------------------------------

describe("parseArgs --trials", () => {
  it("reads the space-separated form", () => {
    assert.equal(parseArgs(["--trials", "40"]).trials, 40);
  });

  it("reads the equals form instead of silently defaulting", () => {
    assert.equal(
      parseArgs(["--trials=100"]).trials,
      100,
      "--trials=N must not fall back to the default",
    );
  });

  it("defaults to the minimum when --trials is absent", () => {
    assert.equal(parseArgs([]).trials, MIN_TRIALS);
  });

  it("REFUSES a flag consumed as the trial count instead of yielding NaN", () => {
    assert.throws(
      () => parseArgs(["--trials", "--report", "/tmp/x.md"]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /REFUSED/);
        assert.match(err.message, /--trials/);
        return true;
      },
      "a missing trial count must refuse, not become NaN and run zero trials",
    );
  });

  it("REFUSES a non-numeric trial count", () => {
    assert.throws(
      () => parseArgs(["--trials", "lots"]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /not a positive whole number/);
        return true;
      },
    );
  });

  it("REFUSES zero and negative trial counts", () => {
    for (const bad of ["0", "-5"]) {
      assert.throws(
        () => parseArgs(["--trials", bad]),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /not a positive whole number/);
          return true;
        },
        `--trials ${bad} must refuse rather than run an empty measurement`,
      );
    }
  });

  it("still parses the other flags when --trials uses the equals form", () => {
    const args = parseArgs(["--trials=25", "--report", "/tmp/r.md", "--questions=a,b"]);
    assert.equal(args.trials, 25);
    assert.equal(args.report, "/tmp/r.md");
    assert.deepEqual(args.questions, ["a", "b"]);
  });

  it("does not read a following flag as another flag's value", () => {
    // Same defect class as --trials: --report --questions x would have made the
    // report path the literal string "--questions".
    assert.equal(parseArgs(["--report", "--questions", "a"]).report, undefined);
  });
});
