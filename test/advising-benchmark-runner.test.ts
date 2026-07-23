// test/advising-benchmark-runner.test.ts
//
// Offline unit tests for scripts/advising-benchmark/runner.ts (Task 2 of
// docs/superpowers/specs/2026-07-23-advising-model-benchmark.md). The live
// agentic loop cannot be tested without network per the task brief, so this
// exercises only the PURE classification/extraction pieces the loop is built
// from, with mock inputs — mirroring test/tool-ceiling-probe.test.ts and
// test/fabrication-probe.test.ts's own split between pure logic and network.
//
// No network, no live model calls here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accumulateUsage,
  agentToolsToWireTools,
  applyRequestShape,
  classifyFailureClass,
  computeMalformed,
  extractUsage,
  MODEL_PANEL,
  parseArgs,
  type ClassifyInput,
  type UsageTotals,
} from "../scripts/advising-benchmark/runner.ts";

function classifyInput(patch: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    status: 200,
    bodyParsed: true,
    answer: "It has 4 credit hours.",
    toolCallCount: 1,
    malformed: false,
    ...patch,
  };
}

// --- failureClass precedence (the brief's 5 required cases) ----------------

describe("classifyFailureClass", () => {
  it("a 400 is http_error, regardless of anything else in the observation", () => {
    assert.equal(
      classifyFailureClass(
        classifyInput({
          status: 400,
          bodyParsed: false,
          answer: "",
          toolCallCount: 0,
        }),
      ),
      "http_error",
    );
  });

  it("status 0 (network failure / timeout) is also http_error", () => {
    assert.equal(
      classifyFailureClass(
        classifyInput({ status: 0, bodyParsed: false, answer: "ETIMEDOUT" }),
      ),
      "http_error",
    );
  });

  it("an unparseable body (bodyParsed false, 2xx) is unparseable, not ok or no_tool_call", () => {
    assert.equal(
      classifyFailureClass(
        classifyInput({ status: 200, bodyParsed: false, answer: "" }),
      ),
      "unparseable",
    );
  });

  it("a body that parsed every turn but never produced a final answer is also unparseable", () => {
    // The loop ran out of MAX_TURNS while still mid tool-call: bodyParsed
    // stayed true (every JSON.parse succeeded) but `answer` never got set to
    // anything but "". This must not be misread as "ok with a blank answer".
    assert.equal(
      classifyFailureClass(
        classifyInput({ bodyParsed: true, answer: "", toolCallCount: 6 }),
      ),
      "unparseable",
    );
  });

  it("the malformed signature (finish_reason stop + tool_call XML, zero structured calls) is malformed", () => {
    const malformed = computeMalformed(
      '<tool_call>{"name":"search-clemson-classes","arguments":{}}</tool_call>',
      0,
      ["search-clemson-classes"],
      "stop",
    );
    assert.equal(malformed, true);
    assert.equal(
      classifyFailureClass(
        classifyInput({
          toolCallCount: 0,
          malformed,
          answer: "<tool_call>...",
        }),
      ),
      "malformed",
    );
  });

  it("a clean tool-call-then-answer transcript is ok", () => {
    assert.equal(
      classifyFailureClass(
        classifyInput({
          status: 200,
          bodyParsed: true,
          toolCallCount: 2,
          malformed: false,
        }),
      ),
      "ok",
    );
  });

  it("a parsed answer with zero tool calls is no_tool_call, not malformed", () => {
    assert.equal(
      classifyFailureClass(
        classifyInput({
          bodyParsed: true,
          toolCallCount: 0,
          malformed: false,
          answer: "GC 3400 is 4 credit hours.",
        }),
      ),
      "no_tool_call",
    );
  });

  it("malformed takes precedence over no_tool_call: both have toolCallCount 0", () => {
    // These two classes are distinguished ONLY by the `malformed` flag the
    // detector computed — the classifier itself must respect that precedence.
    assert.equal(
      classifyFailureClass(
        classifyInput({ toolCallCount: 0, malformed: true }),
      ),
      "malformed",
    );
    assert.equal(
      classifyFailureClass(
        classifyInput({ toolCallCount: 0, malformed: false }),
      ),
      "no_tool_call",
    );
  });

  it("http_error wins even over a body that otherwise looks malformed", () => {
    assert.equal(
      classifyFailureClass(
        classifyInput({
          status: 503,
          bodyParsed: false,
          toolCallCount: 0,
          malformed: true,
        }),
      ),
      "http_error",
    );
  });
});

// --- computeMalformed: the finish_reason -> StopReason glue -----------------

describe("computeMalformed", () => {
  it("does not fire when real structured tool calls were made", () => {
    assert.equal(
      computeMalformed(
        "cu_public and friends",
        1,
        ["search-clemson-classes"],
        "stop",
      ),
      false,
    );
  });

  it("does not fire on finish_reason length even with tool-call-shaped text", () => {
    // A truncated generation can leave the same partial XML in content; that is
    // OUR budget problem, not the endpoint degradation this detector reports.
    assert.equal(
      computeMalformed('<tool_call>{"name":"x"', 0, ["x"], "length"),
      false,
    );
  });

  it("fires on finish_reason stop + tool_call XML + zero tool calls", () => {
    assert.equal(
      computeMalformed(
        '<tool_call>{"name":"list-clemson-terms"}</tool_call>',
        0,
        [],
        "stop",
      ),
      true,
    );
  });
});

// --- token extraction --------------------------------------------------------

describe("extractUsage / accumulateUsage", () => {
  it("extracts prompt/completion tokens from a usage block", () => {
    assert.deepEqual(
      extractUsage({ prompt_tokens: 120, completion_tokens: 45 }),
      {
        promptTokens: 120,
        completionTokens: 45,
      },
    );
  });

  it("returns null fields when usage is absent or fields are non-numeric", () => {
    assert.deepEqual(extractUsage(undefined), {
      promptTokens: null,
      completionTokens: null,
    });
    assert.deepEqual(
      extractUsage({ prompt_tokens: "120" as unknown as number }),
      {
        promptTokens: null,
        completionTokens: null,
      },
    );
  });

  it("accumulates across turns, summing rather than overwriting", () => {
    let acc: UsageTotals = { promptTokens: null, completionTokens: null };
    acc = accumulateUsage(
      acc,
      extractUsage({ prompt_tokens: 100, completion_tokens: 20 }),
    );
    acc = accumulateUsage(
      acc,
      extractUsage({ prompt_tokens: 140, completion_tokens: 30 }),
    );
    assert.deepEqual(acc, { promptTokens: 240, completionTokens: 50 });
  });

  it("a turn with no usage reported does not zero out an already-accumulated total", () => {
    let acc: UsageTotals = { promptTokens: 100, completionTokens: 20 };
    acc = accumulateUsage(acc, extractUsage(undefined));
    assert.deepEqual(acc, { promptTokens: 100, completionTokens: 20 });
  });
});

// --- request shape: the http_error/malformed trap this task exists to avoid -

describe("applyRequestShape", () => {
  it("qwen-thinking family sends chat_template_kwargs.enable_thinking:true and temperature", () => {
    const body = applyRequestShape(
      { model: "x", messages: [] },
      "qwen-thinking",
    );
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(typeof body.temperature, "number");
  });

  it("plain family (gptoss) sends temperature only, no chat_template_kwargs", () => {
    const body = applyRequestShape({ model: "x", messages: [] }, "plain");
    assert.equal("chat_template_kwargs" in body, false);
    assert.equal(typeof body.temperature, "number");
  });

  it("never sets tool_choice, for either family — the documented 400 trap has no input here", () => {
    const thinking = applyRequestShape(
      { model: "x", messages: [] },
      "qwen-thinking",
    );
    const plain = applyRequestShape({ model: "x", messages: [] }, "plain");
    assert.equal("tool_choice" in thinking, false);
    assert.equal("tool_choice" in plain, false);
  });

  it("openai-reasoning family (Task 3's gpt-5.4/gpt-5.5-pro) sends NO temperature and no chat_template_kwargs", () => {
    // Reasoning-family OpenAI models reject a non-default temperature (see
    // advisor-agent.ts's Responses-API note and openai-classifier.ts's
    // working gpt-5.4-mini call, which omits temperature entirely) — this
    // family must not inject ADVISOR_TEMPERATURE the way "plain" does.
    const body = applyRequestShape(
      { model: "gpt-5.4", messages: [], max_completion_tokens: 800 },
      "openai-reasoning",
    );
    assert.equal("temperature" in body, false);
    assert.equal("chat_template_kwargs" in body, false);
    assert.equal("tool_choice" in body, false);
    assert.equal(body.max_completion_tokens, 800);
  });
});

// --- tool array conversion ---------------------------------------------------

describe("agentToolsToWireTools", () => {
  it("converts bare-named AgentTool-shaped entries to chat-completions function tools", () => {
    const wire = agentToolsToWireTools([
      {
        name: "search-clemson-classes",
        description: "search",
        parameters: { type: "object" },
      },
      {
        name: "list-clemson-terms",
        description: "list terms",
        parameters: { type: "object" },
      },
    ]);
    assert.equal(wire.length, 2);
    assert.deepEqual(wire[0], {
      type: "function",
      function: {
        name: "search-clemson-classes",
        description: "search",
        parameters: { type: "object" },
      },
    });
  });
});

// --- MODEL_PANEL well-formedness ---------------------------------------------

describe("MODEL_PANEL", () => {
  it("has exactly the 4 candidates the spec names", () => {
    assert.equal(MODEL_PANEL.length, 4);
    assert.deepEqual(
      MODEL_PANEL.map((c) => c.label).sort(),
      [
        "gptoss-120b",
        "qwen-agentworld-35b-a3b",
        "qwen3.6-35b-a3b-fp8",
        "spark-qwen3.6-35b-a3b",
      ].sort(),
    );
  });

  it("every candidate resolves a non-empty label, baseUrl and model id", () => {
    for (const c of MODEL_PANEL) {
      assert.ok(
        c.label.length > 0,
        `candidate missing label: ${JSON.stringify(c)}`,
      );
      assert.ok(c.baseUrl.length > 0, `${c.label} missing baseUrl`);
      assert.ok(c.model.length > 0, `${c.label} missing model id`);
      assert.equal(
        typeof c.apiKey,
        "string",
        `${c.label} apiKey must be a string (may be empty)`,
      );
      assert.ok(
        c.family === "qwen-thinking" || c.family === "plain",
        `${c.label} has an unknown family: ${c.family}`,
      );
    }
  });

  it("the three RCD-hosted candidates share one base URL; Spark is a distinct endpoint", () => {
    const rcd = MODEL_PANEL.filter((c) => c.label !== "spark-qwen3.6-35b-a3b");
    const spark = MODEL_PANEL.find((c) => c.label === "spark-qwen3.6-35b-a3b")!;
    assert.equal(new Set(rcd.map((c) => c.baseUrl)).size, 1);
    assert.notEqual(spark.baseUrl, rcd[0]!.baseUrl);
  });
});

// --- CLI parsing --------------------------------------------------------------

describe("parseArgs", () => {
  it("defaults to model=all, scenario=all, trials=MIN_TRIALS", () => {
    const args = parseArgs([]);
    assert.equal(args.model, "all");
    assert.equal(args.scenario, "all");
    assert.equal(args.allowUnderpowered, false);
  });

  it("reads --model, --scenario, --trials, --out, --allow-underpowered", () => {
    const args = parseArgs([
      "--model",
      "qwen-agentworld-35b-a3b",
      "--scenario",
      "S1",
      "--trials",
      "1",
      "--out",
      "/tmp/out.json",
      "--allow-underpowered",
    ]);
    assert.equal(args.model, "qwen-agentworld-35b-a3b");
    assert.equal(args.scenario, "S1");
    assert.equal(args.trials, 1);
    assert.equal(args.out, "/tmp/out.json");
    assert.equal(args.allowUnderpowered, true);
  });

  it("rejects a non-numeric or non-positive --trials rather than silently defaulting", () => {
    assert.throws(() => parseArgs(["--trials", "nope"]));
    assert.throws(() => parseArgs(["--trials", "0"]));
  });
});
