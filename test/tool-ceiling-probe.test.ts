import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_TRIALS,
  applyDescriptionOverrides,
  applyNaming,
  blockValidity,
  buildToolSurface,
  classifyTrial,
  formatInterval,
  looksLikeToolCallXml,
  readModelsResponse,
  wilsonInterval,
  PROBE_MESSAGES,
  type RealTool,
  type TrialObservation,
} from "../scripts/tool-ceiling-probe.ts";

function obs(patch: Partial<TrialObservation> = {}): TrialObservation {
  return {
    status: 200,
    parsedFrames: 5,
    bodyParsed: true,
    toolCallCount: 0,
    finishReason: "stop",
    content: "",
    ...patch,
  };
}

// --- classification -------------------------------------------------------

test("classifyTrial: structured tool calls are the success class", () => {
  assert.equal(classifyTrial(obs({ toolCallCount: 1, finishReason: "tool_calls" })), "tool_calls");
});

test("classifyTrial: finish_reason length with no tool calls is truncated, not no_tool_call", () => {
  assert.equal(classifyTrial(obs({ finishReason: "length" })), "truncated");
});

test("classifyTrial: tool-call XML in content is malformed, not a plain answer", () => {
  const c = classifyTrial(
    obs({ finishReason: "stop", content: '<tool_call>{"name":"list-clemson-terms"}</tool_call>' }),
  );
  assert.equal(c, "malformed");
});

test("classifyTrial: prose with no XML is no_tool_call", () => {
  assert.equal(
    classifyTrial(obs({ content: "I would need the catalog year to answer that." })),
    "no_tool_call",
  );
});

test("classifyTrial: a 400 is http_error, never 'the model made zero tool calls'", () => {
  // This exact collapse was made twice on this project. A 4xx carries no
  // generation, so it must never land in a behavioural class.
  const c = classifyTrial(obs({ status: 400, bodyParsed: false, parsedFrames: 0 }));
  assert.equal(c, "http_error");
});

test("classifyTrial: 5xx is http_error", () => {
  assert.equal(classifyTrial(obs({ status: 503, parsedFrames: 0, bodyParsed: false })), "http_error");
});

test("classifyTrial: network failure (status 0) is http_error", () => {
  assert.equal(classifyTrial(obs({ status: 0, parsedFrames: 0, bodyParsed: false })), "http_error");
});

test("classifyTrial: a 200 with zero stream frames is unparseable, not no_tool_call", () => {
  assert.equal(classifyTrial(obs({ status: 200, parsedFrames: 0, bodyParsed: false })), "unparseable");
});

test("classifyTrial: a 200 whose body never parsed is unparseable", () => {
  assert.equal(classifyTrial(obs({ status: 200, parsedFrames: 3, bodyParsed: false })), "unparseable");
});

test("classifyTrial: http_error outranks a body that also looks malformed", () => {
  const c = classifyTrial(obs({ status: 500, content: "<tool_call>", parsedFrames: 0, bodyParsed: false }));
  assert.equal(c, "http_error");
});

test("classifyTrial: every class is reachable and distinct", () => {
  const seen = new Set([
    classifyTrial(obs({ toolCallCount: 2 })),
    classifyTrial(obs({ finishReason: "length" })),
    classifyTrial(obs({ content: "<function=foo>" })),
    classifyTrial(obs({ content: "plain prose" })),
    classifyTrial(obs({ status: 404, bodyParsed: false, parsedFrames: 0 })),
    classifyTrial(obs({ parsedFrames: 0, bodyParsed: false })),
  ]);
  assert.equal(seen.size, 6);
});

test("looksLikeToolCallXml recognises the leaking dialects", () => {
  for (const s of [
    "<tool_call>",
    "</tool_call>",
    "<function=search>",
    "<function_call>",
    "<|tool_call_begin|>",
    "<invoke name='x'>",
  ]) {
    assert.equal(looksLikeToolCallXml(s), true, s);
  }
  assert.equal(looksLikeToolCallXml("Here are the Fall 2026 sections."), false);
});

// --- Wilson interval ------------------------------------------------------

test("wilsonInterval: 18/20 and 180/200 have the same point but different width", () => {
  const small = wilsonInterval(18, 20);
  const large = wilsonInterval(180, 200);
  assert.equal(small.point, large.point);
  const smallWidth = small.high - small.low;
  const largeWidth = large.high - large.low;
  assert.ok(
    largeWidth < smallWidth / 2,
    `expected n=200 to be far tighter: ${largeWidth} vs ${smallWidth}`,
  );
});

test("wilsonInterval: 20/20 does not claim certainty", () => {
  const iv = wilsonInterval(20, 20);
  assert.equal(iv.point, 1);
  assert.ok(iv.low < 0.9, `lower bound should admit doubt, got ${iv.low}`);
  assert.equal(iv.high, 1);
});

test("wilsonInterval: 0/20 does not claim impossibility", () => {
  const iv = wilsonInterval(0, 20);
  assert.equal(iv.point, 0);
  assert.equal(iv.low, 0);
  assert.ok(iv.high > 0.1, `upper bound should admit doubt, got ${iv.high}`);
});

test("wilsonInterval: matches known values for 1/2 at n=100", () => {
  const iv = wilsonInterval(50, 100);
  // Textbook Wilson 95% interval for 50/100 is approximately [0.404, 0.596].
  assert.ok(Math.abs(iv.low - 0.4038) < 0.002, `low=${iv.low}`);
  assert.ok(Math.abs(iv.high - 0.5962) < 0.002, `high=${iv.high}`);
});

test("wilsonInterval: bounds stay inside [0,1] and bracket the point", () => {
  for (const n of [1, 3, 20, 57, 200]) {
    for (let s = 0; s <= n; s++) {
      const iv = wilsonInterval(s, n);
      assert.ok(iv.low >= 0 && iv.high <= 1, `n=${n} s=${s}`);
      assert.ok(iv.low <= iv.point + 1e-9 && iv.high >= iv.point - 1e-9, `n=${n} s=${s}`);
    }
  }
});

test("wilsonInterval: n=0 is total ignorance, not a divide-by-zero", () => {
  const iv = wilsonInterval(0, 0);
  assert.equal(iv.low, 0);
  assert.equal(iv.high, 1);
  assert.ok(Number.isFinite(iv.point));
});

test("formatInterval renders a percentage with bounds", () => {
  assert.equal(formatInterval(wilsonInterval(20, 20)).includes("100%"), true);
});

// --- endpoint state -------------------------------------------------------

const MODELS_BODY = {
  data: [
    { id: "qwen3.6-35b-a3b", state: "resident" },
    { id: "gemma-4-12b", state: "stopped" },
  ],
};

test("readModelsResponse finds the target state and ignores stopped peers", () => {
  const s = readModelsResponse(MODELS_BODY, "qwen3.6-35b-a3b");
  assert.equal(s.target, "resident");
  assert.deepEqual(s.othersLoading, []);
  assert.equal(s.stateless, false);
});

test("readModelsResponse flags another model loading", () => {
  const s = readModelsResponse(
    { data: [{ id: "qwen3.6-35b-a3b", state: "resident" }, { id: "other", state: "loading" }] },
    "qwen3.6-35b-a3b",
  );
  assert.deepEqual(s.othersLoading, ["other=loading"]);
});

test("readModelsResponse marks a stateless endpoint (OpenAI has no state field)", () => {
  const s = readModelsResponse({ data: [{ id: "gpt-5.4" }] }, "gpt-5.4");
  assert.equal(s.stateless, true);
});

test("blockValidity: resident before and after with nothing loading is valid", () => {
  const st = readModelsResponse(MODELS_BODY, "qwen3.6-35b-a3b");
  assert.equal(blockValidity(st, st).valid, true);
});

test("blockValidity: a model that started loading mid-block invalidates it", () => {
  const before = readModelsResponse(MODELS_BODY, "qwen3.6-35b-a3b");
  const after = readModelsResponse(
    { data: [{ id: "qwen3.6-35b-a3b", state: "resident" }, { id: "gemma-4-12b", state: "loading" }] },
    "qwen3.6-35b-a3b",
  );
  const v = blockValidity(before, after);
  assert.equal(v.valid, false);
  assert.match(v.reason, /loading/);
});

test("blockValidity: target evicted mid-block invalidates it", () => {
  const before = readModelsResponse(MODELS_BODY, "qwen3.6-35b-a3b");
  const after = readModelsResponse({ data: [{ id: "qwen3.6-35b-a3b", state: "stopped" }] }, "qwen3.6-35b-a3b");
  assert.equal(blockValidity(before, after).valid, false);
});

test("blockValidity: target not resident up front invalidates it", () => {
  const cold = readModelsResponse({ data: [{ id: "qwen3.6-35b-a3b", state: "stopped" }] }, "qwen3.6-35b-a3b");
  assert.equal(blockValidity(cold, cold).valid, false);
});

test("blockValidity: a failed state check invalidates rather than silently passing", () => {
  const err = { target: null, othersLoading: [], stateless: false, error: "HTTP 502" };
  const ok = readModelsResponse(MODELS_BODY, "qwen3.6-35b-a3b");
  assert.equal(blockValidity(err, ok).valid, false);
  assert.equal(blockValidity(ok, err).valid, false);
});

test("blockValidity: a stateless endpoint is valid but says it was not checked", () => {
  const s = readModelsResponse({ data: [{ id: "gpt-5.4" }] }, "gpt-5.4");
  const v = blockValidity(s, s);
  assert.equal(v.valid, true);
  assert.match(v.reason, /no model state/);
});

// --- tool surface ---------------------------------------------------------

const REAL: RealTool[] = [
  { namespace: "cu_public", bareName: "list-clemson-terms", description: "d", parameters: {} },
  { namespace: "cu_public", bareName: "search-clemson-classes", description: "d", parameters: {} },
  { namespace: "cu_catalog", bareName: "get-gc-course", description: "d", parameters: {} },
  { namespace: null, bareName: "propose_schedule", description: "d", parameters: {} },
];

test("applyNaming produces the three distinct variants", () => {
  assert.equal(applyNaming("cu_public", "list-clemson-terms", "bare"), "list-clemson-terms");
  assert.equal(applyNaming("cu_public", "list-clemson-terms", "single"), "cu_public_list-clemson-terms");
  assert.equal(applyNaming("cu_public", "list-clemson-terms", "double"), "cu_public__list-clemson-terms");
});

test("applyNaming leaves host tools without a namespace untouched", () => {
  for (const v of ["bare", "single", "double"] as const) {
    assert.equal(applyNaming(null, "propose_schedule", v), "propose_schedule");
  }
});

test("buildToolSurface slices without cloning when count fits the real tools", () => {
  const { tools, cloned } = buildToolSurface(REAL, 3, "double");
  assert.equal(tools.length, 3);
  assert.equal(cloned, 0);
});

test("buildToolSurface keeps the answering tools in the smallest slice", () => {
  const { tools } = buildToolSurface(REAL, 2, "bare");
  const names = (tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
  assert.deepEqual(names, ["list-clemson-terms", "search-clemson-classes"]);
});

test("buildToolSurface clones above the real count and reports how many", () => {
  const { tools, cloned } = buildToolSurface(REAL, 10, "double");
  assert.equal(tools.length, 10);
  assert.equal(cloned, 6);
});

test("buildToolSurface emits unique names even when cloning", () => {
  const { tools } = buildToolSurface(REAL, 35, "single");
  const names = (tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
  assert.equal(new Set(names).size, 35);
});

// --- guardrails -----------------------------------------------------------

test("the minimum trial count is 20", () => {
  assert.equal(MIN_TRIALS, 20);
});

test("at least six distinct probe messages are cycled", () => {
  assert.ok(PROBE_MESSAGES.length >= 6);
  assert.equal(new Set(PROBE_MESSAGES).size, PROBE_MESSAGES.length);
});

// --- description overrides (controlled-cell apparatus) ---------------------

test("applyDescriptionOverrides replaces only the targeted tool", () => {
  const out = applyDescriptionOverrides(REAL, {
    "search-clemson-classes": "REWRITTEN",
  });
  const byName = new Map(out.map((t) => [t.bareName, t.description]));
  assert.equal(byName.get("search-clemson-classes"), "REWRITTEN");
  assert.equal(
    byName.get("list-clemson-terms"),
    REAL.find((t) => t.bareName === "list-clemson-terms")!.description,
  );
  assert.equal(out.length, REAL.length);
});

test("applyDescriptionOverrides does not mutate its input", () => {
  const before = REAL.map((t) => t.description);
  applyDescriptionOverrides(REAL, { "search-clemson-classes": "REWRITTEN" });
  assert.deepEqual(REAL.map((t) => t.description), before);
});

test("applyDescriptionOverrides throws on an unknown tool name", () => {
  // A silently-ignored override would make a "no effect" cell indistinguishable
  // from a cell where the manipulation never happened.
  assert.throws(
    () => applyDescriptionOverrides(REAL, { "no-such-tool": "x" }),
    /unknown tool "no-such-tool"/,
  );
});
