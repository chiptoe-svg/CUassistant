import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  ADVISOR_MAX_OUTPUT_TOKENS,
  ADVISOR_MAX_REQUEST_TOKENS,
  ADVISOR_MAX_ROUNDS,
  ADVISOR_TEMPERATURE,
} from "../src/config.ts";
import {
  __resolveProviderForTest,
  __runWithProviderForTest,
  assertAdvisorChainAuthorized,
  detectMalformedToolCall,
  enforceContextBudget,
  loadSystemPrompt,
  reconcileToolChoiceWithThinking,
  setAdvisorBridgeForTest,
} from "../src/advisor-agent.ts";
import type { AdvisorSession } from "../src/advisor-session.ts";

test("the persona carries the rules that keep answers grounded", () => {
  const p = loadSystemPrompt();
  assert.match(p, /catalog year/i, "catalog-year discipline");
  assert.match(p, /petitions/i, "the exceptions boundary");
  assert.match(p, /empty/i, "the empty-result rule");
  assert.match(p, /list-skills/, "skills are retrieved, not inlined");
});

// The three skills total ~6,500 tokens. Inlining them would spend a tenth of a
// 64k window on every turn — the budget the 2026-07-21 payload work reclaimed.
test("skill bodies are NOT inlined into the system prompt", () => {
  const p = loadSystemPrompt();
  assert.ok(p.length < 8000, `system prompt is ${p.length} chars — skills inlined?`);
  assert.doesNotMatch(p, /### `search-clemson-classes`/, "skill body leaked in");
});

// --- egress gate ------------------------------------------------------------
//
// ADVISOR_PROVIDER_CHAIN is env-settable and every entry it reaches receives
// student context. The gate is the only thing that keeps a typo from becoming
// an undeclared destination.

test("the egress gate rejects a chain entry with no policy destination", () => {
  assert.throws(
    () => assertAdvisorChainAuthorized(["spark", "gemini"]),
    /"gemini" has no destination declared/,
    "an unmapped chain entry must fail closed",
  );
});

test("the egress gate rejects a chain entry whose policy record is unauthorized", () => {
  // "openai" maps to openai_api; deny it and the gate must refuse, proving the
  // gate reads the policy record instead of just checking the name is known.
  assert.throws(
    () => assertAdvisorChainAuthorized(["openai"], () => false),
    /not authorized in policy/,
  );
});

test("the shipped chain names destinations that policy authorizes", () => {
  assert.doesNotThrow(() => assertAdvisorChainAuthorized(["spark", "openai"]));
});

// The gate must check the destination bytes actually go to. Both real chain
// entries send off-box, so neither may resolve to a `local` policy record.
test("the gate checks the provider that is actually dialled, not a stand-in", () => {
  const seen: string[] = [];
  assertAdvisorChainAuthorized(["spark", "openai"], (p) => {
    seen.push(p);
    return true;
  });
  assert.deepEqual(seen, ["clemson_spark_vllm", "openai_api"]);
});

// --- harness behaviour ------------------------------------------------------

/** A fake vLLM speaking OpenAI chat-completions SSE. */
function startFakeProvider(opts: {
  /** Return a tool call for this many requests, then a plain answer. */
  toolCallsBeforeAnswer: number;
  onRequest?: (n: number) => void;
  /**
   * Name the model asks for. Defaults to "echo", the tool that exists. Naming a
   * tool that does NOT exist drives agent-loop.js's `immediate` path
   * (:361-367), which never reaches afterToolCall.
   */
  toolName?: string;
  /**
   * Raw arguments JSON. Defaults to a schema-valid object. Supplying arguments
   * that fail validation drives the other `immediate` path (:406-412).
   */
  toolArguments?: string;
  /** Content for the final (non-tool-call) message. */
  answer?: string;
  /**
   * finish_reason for the final message. "length" is what a real endpoint sends
   * when the output budget ran out mid-generation — the case that must NOT be
   * reported as the endpoint's malformed-tool-call degradation.
   */
  finishReason?: "stop" | "length";
  /** Delay before responding, to exercise the wall-clock ceiling. */
  delayMs?: number;
}): Promise<{
  url: string;
  count: () => number;
  bodies: () => unknown[];
  close: () => Promise<void>;
}> {
  let n = 0;
  const bodies: unknown[] = [];
  const server: Server = createServer((req, res) => {
    n += 1;
    const mine = n;
    opts.onRequest?.(mine);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push(null);
      }
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
        if (res.writableEnded) return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const base = {
        id: `chatcmpl-${mine}`,
        object: "chat.completion.chunk",
        created: 0,
        model: "fake",
      };
      const send = (choice: unknown) =>
        res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);

      if (mine <= opts.toolCallsBeforeAnswer) {
        send({
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${mine}`,
                type: "function",
                function: {
                  name: opts.toolName ?? "echo",
                  arguments: opts.toolArguments ?? '{"text":"ping"}',
                },
              },
            ],
          },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: "tool_calls" });
      } else {
        send({
          index: 0,
          delta: {
            role: "assistant",
            content: opts.answer ?? "final answer",
          },
          finish_reason: null,
        });
        send({
          index: 0,
          delta: {},
          finish_reason: opts.finishReason ?? "stop",
        });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        count: () => n,
        bodies: () => bodies,
        close: () =>
          new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function fakeEchoTool(onExecute?: () => void): AgentTool {
  return {
    name: "echo",
    label: "echo",
    description: "echo text back",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id: string, params: { text: string }) {
      onExecute?.();
      return {
        content: [{ type: "text", text: String(params.text) }],
        details: {},
      };
    },
  } as unknown as AgentTool;
}

/** A tool that exists only so its NAME is in the bridge's tool list. */
function fakeNamedTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "a tool that exists",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  } as unknown as AgentTool;
}

function fakeSession(): AdvisorSession {
  return {
    id: "test-session",
    advisorId: "shared",
    workDir: mkdtempSync(path.join(tmpdir(), "advisor-test-work-")),
    piSessionRoot: mkdtempSync(path.join(tmpdir(), "advisor-test-pi-")),
    history: [],
    lastTouched: Date.now(),
  };
}

function sparkTarget(baseUrl: string) {
  return {
    name: "spark",
    apiKey: "local",
    model: {
      id: "fake",
      name: "fake",
      api: "openai-completions",
      provider: "openai",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 65536,
      maxTokens: 8192,
    },
  };
}

// REGRESSION: the round cap must BOUND the loop, not merely decline tool calls.
// Blocking from the `tool_call` hook produces an error tool result that is fed
// straight back to the model (agent-loop.js:386), so the loop keeps requesting
// — unbounded spend against a metered provider. Only `terminate` on
// ToolResultPatch ends it. The fake provider offers far more tool calls than
// the cap; if the bound were advisory the request count would run away.
test("the round cap terminates the loop instead of looping on blocked calls", async () => {
  const provider = await startFakeProvider({ toolCallsBeforeAnswer: 40 });
  const session = fakeSession();
  const tool = fakeEchoTool();
  setAdvisorBridgeForTest({ tools: [tool], close: async () => {} });

  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "how many credits do I need?",
    );

    assert.equal(result.outcome, "round_cap", "the cap must be surfaced");
    assert.ok(
      provider.count() <= ADVISOR_MAX_ROUNDS,
      `provider was asked ${provider.count()} times for a cap of ${ADVISOR_MAX_ROUNDS} — the loop is not bounded`,
    );
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// temperature is injected into the provider payload only for chat-completions.
// The openai fallback is `openai-responses` with a reasoning model, whose API
// rejects `temperature` — injecting it there would 400 the fallback every time.
// This pins the completions side so the gate cannot silently drop it.
test("temperature is injected for the chat-completions provider", async () => {
  const provider = await startFakeProvider({ toolCallsBeforeAnswer: 0 });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  try {
    await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "hello",
    );
    const first = provider.bodies()[0] as Record<string, unknown>;
    // 0.6 is the endpoint docs' canonical value for qwen3.6-35b-a3b. 0 was our
    // own invention.
    assert.equal(
      first.temperature,
      ADVISOR_TEMPERATURE,
      "spark must get the configured temperature",
    );
    assert.equal(ADVISOR_TEMPERATURE, 0.6, "the default must be the documented 0.6");
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// REGRESSION: the OUTPUT budget must actually reach the wire.
//
// The model object declares `maxTokens: 8192` and that value was never sent.
// pi-agent-core's createStreamFn hands pi-ai an explicit allowlist of stream
// options that omits maxTokens, and pi-ai emits max_tokens only when
// `options.maxTokens` is set — so generation was bounded solely by the server's
// default. Confirmed against the real endpoint with a capturing proxy: neither
// max_tokens nor max_completion_tokens appeared on any request.
//
// This asserts on the BODY the provider received, not on the model config,
// because the model config is exactly the thing that lied.
test("the output token budget is on the wire, not just declared on the model", async () => {
  const provider = await startFakeProvider({ toolCallsBeforeAnswer: 0 });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  try {
    await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "hello",
    );
    const first = provider.bodies()[0] as Record<string, unknown>;
    assert.equal(
      first.max_tokens,
      ADVISOR_MAX_OUTPUT_TOKENS,
      "max_tokens never reached the request — the server default is bounding generation",
    );
    // Input cap and output cap are two different limits against ONE window.
    // Fixing either must not starve the other: the endpoint's guidance is a 64K
    // window with requests near 45K, leaving room for the answer plus thinking.
    assert.ok(
      ADVISOR_MAX_REQUEST_TOKENS + ADVISOR_MAX_OUTPUT_TOKENS <= 65536,
      `input ${ADVISOR_MAX_REQUEST_TOKENS} + output ${ADVISOR_MAX_OUTPUT_TOKENS} overruns the 64K window`,
    );
    // With enable_thinking on, reasoning is spent from the output budget before
    // any content or tool call appears. Live turns were observed spending
    // 291-1114 tokens on reasoning alone, so a budget in the hundreds truncates
    // routinely.
    assert.ok(
      ADVISOR_MAX_OUTPUT_TOKENS >= 4096,
      "the output budget must leave room for thinking plus an answer",
    );
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// The gate is on model.api, so a non-completions model must not receive it.
test("temperature is NOT injected for openai-responses reasoning models", async () => {
  const provider = await startFakeProvider({ toolCallsBeforeAnswer: 0 });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });
  const target = sparkTarget(provider.url);
  // Same fake endpoint, but declared as the fallback's API shape.
  (target.model as { api: string }).api = "openai-responses";

  try {
    await __runWithProviderForTest(target as never, session, "hello").catch(
      () => {},
    );
    const sent = provider.bodies() as Record<string, unknown>[];
    assert.ok(sent.length > 0, "no request reached the fake provider");
    for (const b of sent) {
      // `temperature: 0` is falsy — this must be a key-presence check, not a
      // truthiness check, or the assertion passes on the very bug it guards.
      assert.ok(
        !("temperature" in b),
        "temperature reached a responses-API request — the fallback would 400",
      );
    }
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// REGRESSION: an aborted turn must not read as a finished one. prompt()
// RESOLVES on abort with partial text, so a success-shaped return would let the
// UI render a truncated answer as the final answer.
test("an aborted turn is reported as aborted, not as a complete answer", async () => {
  const controller = new AbortController();
  const provider = await startFakeProvider({ toolCallsBeforeAnswer: 40 });
  const session = fakeSession();
  // Stop the turn from inside the first tool call, the way the UI's stop
  // control does mid-flight.
  const tool = fakeEchoTool(() => controller.abort());
  setAdvisorBridgeForTest({ tools: [tool], close: async () => {} });

  // Record the outcome, then assert OUTSIDE the try. Asserting inside a
  // try/catch that tolerates a throw would swallow the assertion failure and
  // make this test vacuous.
  let outcome: string;
  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "how many credits do I need?",
      controller.signal,
    );
    outcome = result.outcome;
  } catch {
    // Throwing is also an acceptable refusal to report success.
    outcome = "threw";
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }

  assert.notEqual(
    outcome,
    "complete",
    "a stopped turn was reported as a finished answer",
  );
  assert.equal(outcome, "aborted", "a stopped turn must say so");
});

// REGRESSION: a failed attempt must not leave a duplicate user turn and an
// orphaned assistant turn in the reused JSONL session.
test("a failed provider attempt leaves the reusable session untouched", async () => {
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  try {
    await assert.rejects(
      __runWithProviderForTest(
        // Nothing is listening on this port, so the attempt fails mid-turn.
        sparkTarget("http://127.0.0.1:1/v1") as never,
        session,
        "how many credits do I need?",
      ),
    );
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(
      readdirSync(session.piSessionRoot),
      [],
      "a failed attempt wrote conversation state into the reusable session",
    );
  } finally {
    setAdvisorBridgeForTest(null);
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// --- item 1: the round cap must bound EVERY tool-call resolution path --------
//
// The original cap was set from the `tool_result` hook, which is Pi's
// `afterToolCall`. afterToolCall runs only inside finalizeExecutedToolCall
// (agent-loop.js:439), so a call whose preparation resolves as
// `kind: "immediate"` skips it entirely and never carries `terminate`. Since
// shouldTerminateToolBatch (:344-345) needs terminate on EVERY call in the
// batch, one such call per batch is enough to make the cap unreachable — a
// reviewer measured 63 provider requests against a cap of 8.
//
// Both immediate conditions are MODEL-controlled, and the malformed generations
// that produce them are a server-side degradation we cannot prevent, so this is
// the only containment there is.

test("the round cap bounds the loop when the model names a tool that does not exist", async () => {
  // agent-loop.js:361-367 — `Tool ... not found` returns kind:"immediate".
  const provider = await startFakeProvider({
    toolCallsBeforeAnswer: 100,
    toolName: "no_such_tool",
  });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "how many credits do I need?",
    );
    assert.ok(
      provider.count() <= ADVISOR_MAX_ROUNDS + 1,
      `provider was asked ${provider.count()} times for a cap of ${ADVISOR_MAX_ROUNDS} — an unknown tool name escapes the bound`,
    );
    assert.notEqual(
      result.outcome,
      "complete",
      "a run stopped by the cap must not report a finished answer",
    );
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

test("the round cap bounds the loop when the model sends schema-invalid arguments", async () => {
  // agent-loop.js:406-412 — validateToolArguments throws, caught into
  // kind:"immediate". The required `text` property is MISSING: a wrong-typed
  // value would not do, because pi-ai runs Value.Convert first
  // (utils/validation.js:255) and a number coerces to a string, i.e. validates
  // cleanly and never reaches the immediate path this test exists to cover.
  const provider = await startFakeProvider({
    toolCallsBeforeAnswer: 100,
    toolArguments: "{}",
  });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "how many credits do I need?",
    );
    assert.ok(
      provider.count() <= ADVISOR_MAX_ROUNDS + 1,
      `provider was asked ${provider.count()} times for a cap of ${ADVISOR_MAX_ROUNDS} — invalid arguments escape the bound`,
    );
    assert.notEqual(result.outcome, "complete");
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// A turn can be bounded in rounds and still run forever if each round is slow.
test("a turn that outlives the wall-clock ceiling is stopped and reported as timeout", async () => {
  const provider = await startFakeProvider({
    toolCallsBeforeAnswer: 0,
    delayMs: 5000,
  });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  let outcome: string;
  const started = Date.now();
  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "hello",
      undefined,
      50, // ceiling well under the provider's 5s delay
    );
    outcome = result.outcome;
  } catch {
    outcome = "threw";
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }

  assert.notEqual(outcome, "complete", "a timed-out turn must not read as finished");
  assert.equal(outcome, "timeout", "the ceiling must surface as its own outcome");
  assert.ok(
    Date.now() - started < 4500,
    "the turn ran to the provider's delay — the ceiling did not fire",
  );
});

// --- item 5: the wire configuration -----------------------------------------
//
// pi-ai emits chat_template_kwargs itself (openai-completions.js:443-448), but
// only when `compat.thinkingFormat === "qwen-chat-template" && model.reasoning`
// AND `options.reasoningEffort` is truthy. We shipped reasoning:false and no
// thinkingFormat, so the branch was dead and enable_thinking never reached the
// wire. This asserts on the PAYLOAD, not on the config, because the whole point
// is that we once assumed the config implied the payload and were wrong.

test("enable_thinking reaches the wire through pi-ai's own qwen-chat-template branch", async () => {
  const provider = await startFakeProvider({ toolCallsBeforeAnswer: 0 });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  // The REAL shipped target, re-pointed at the fake endpoint, so this cannot
  // pass against a copy of the model config that has drifted.
  const target = __resolveProviderForTest("spark")!;
  (target.model as unknown as { baseUrl: string }).baseUrl = provider.url;

  try {
    await __runWithProviderForTest(target as never, session, "hello");
    const first = provider.bodies()[0] as Record<string, unknown>;
    const kwargs = first.chat_template_kwargs as
      | { enable_thinking?: unknown }
      | undefined;
    assert.ok(kwargs, "chat_template_kwargs never reached the wire");
    assert.equal(
      kwargs!.enable_thinking,
      true,
      "enable_thinking must be true — the endpoint docs' canonical request for this model",
    );
    assert.equal(first.temperature, 0.6, "temperature must be the documented 0.6");
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// HARD CONSTRAINT: tool_choice:"required" with enable_thinking:true is an
// HTTP 400 on this stack. pi-ai forwards options.toolChoice straight through
// (openai-completions.js:435), so the combination has to be unrepresentable.
test("tool_choice=required can never ship alongside enable_thinking", () => {
  const out = reconcileToolChoiceWithThinking({
    tool_choice: "required",
    chat_template_kwargs: { enable_thinking: true },
  });
  assert.notEqual(
    out.tool_choice,
    "required",
    "required + enable_thinking is a 400 on this endpoint",
  );
  assert.equal(out.tool_choice, "auto");
});

test("tool_choice is left alone when thinking is off", () => {
  const out = reconcileToolChoiceWithThinking({
    tool_choice: "required",
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.equal(out.tool_choice, "required", "the guard must be narrow");
});

// --- item 6: the context budget ---------------------------------------------

test("the context budget trims tool results before history", () => {
  const big = "x".repeat(400_000); // ~100K tokens on the 4-chars heuristic
  const payload = {
    messages: [
      { role: "system", content: "persona" },
      { role: "user", content: "first question" },
      { role: "tool", content: big },
      { role: "user", content: "current question" },
    ],
  };
  const out = enforceContextBudget(payload, ADVISOR_MAX_REQUEST_TOKENS);
  const msgs = out.messages as { role: string; content: string }[];

  assert.ok(
    JSON.stringify(out).length / 4 <= ADVISOR_MAX_REQUEST_TOKENS,
    "the payload is still over budget",
  );
  assert.ok(
    !msgs.some((m) => m.content === big),
    "the oversized tool result survived",
  );
  assert.equal(msgs[0]!.role, "system", "the persona must never be trimmed");
  assert.equal(
    msgs[msgs.length - 1]!.content,
    "current question",
    "the turn's own input must never be trimmed",
  );
});

// A per-result floor is what makes a budget grow with the tool count. Eight
// results each entitled to a slice is a bigger request than one — the opposite
// of a cap.
test("the budget holds when MANY tool results each want a share", () => {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: "persona" },
  ];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "tool", content: "y".repeat(80_000) });
  }
  messages.push({ role: "user", content: "current question" });

  const out = enforceContextBudget({ messages }, ADVISOR_MAX_REQUEST_TOKENS);
  assert.ok(
    JSON.stringify(out).length / 4 <= ADVISOR_MAX_REQUEST_TOKENS,
    "30 tool results blew the budget — a per-result floor is growing the request",
  );
});

// Failing loudly beats a silently degraded request that gets a confidently
// wrong answer.
test("the budget throws rather than send an unshrinkable oversized request", () => {
  assert.throws(
    () =>
      enforceContextBudget(
        {
          messages: [
            { role: "system", content: "s" },
            { role: "user", content: "z".repeat(400_000) },
          ],
        },
        1000,
      ),
    /refusing to send/,
    "an unshrinkable request must fail loudly, not quietly degrade",
  );
});

// REGRESSION: the persona arrives as role "developer", not "system".
//
// Verified on the wire: the captured payload's first message was
// `developer:3701`. The trim loop protected only role "system", so the persona
// fell through to the splice and — being the oldest message — was the FIRST
// thing deleted. The request then came in under budget with the advisor's
// entire persona and sourcing rules gone, which is precisely the silent
// degradation enforceContextBudget documents itself as refusing to do.
test("the persona is never trimmed, under either role spelling", () => {
  for (const role of ["system", "developer"]) {
    const messages: { role: string; content: string }[] = [
      { role, content: "PERSONA: source every claim from a tool result." },
    ];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: "assistant", content: "z".repeat(20_000) });
    }
    messages.push({ role: "user", content: "current question" });

    const out = enforceContextBudget({ messages }, 5000);
    const kept = out.messages as { role: string; content: string }[];
    assert.ok(
      kept.some((m) => m.content.startsWith("PERSONA:")),
      `the persona was trimmed away when sent as role "${role}"`,
    );
    assert.equal(
      kept[kept.length - 1]!.content,
      "current question",
      "the turn's own input must survive too",
    );
  }
});

test("a payload already inside the budget is passed through untouched", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(enforceContextBudget(payload, 45000), payload);
});

// --- item 7: the malformed-tool-call generation -----------------------------
//
// Observed live: finish_reason "stop", zero tool calls, and a raw
// <cu_public__search-clemson-classes> block in the content. A known server-side
// degradation cleared by a server restart. It was silent — outcome "complete",
// prose rendered as a finished answer — which is the worst case, because the
// persona tells the model to source every claim from a tool result, so a turn
// where no tool ran is the turn most likely to be invented.

test("a tool call emitted as prose is reported as a failure, not as an answer", async () => {
  const provider = await startFakeProvider({
    toolCallsBeforeAnswer: 0,
    answer:
      "<cu_public__search-clemson-classes>\n{\"subject\":\"CPSC\"}\n</cu_public__search-clemson-classes>",
  });
  const session = fakeSession();
  setAdvisorBridgeForTest({
    tools: [fakeNamedTool("cu_public__search-clemson-classes")],
    close: async () => {},
  });

  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "what CPSC classes are offered?",
    );
    assert.equal(
      result.outcome,
      "malformed_tool_call",
      "the degradation must surface as its own outcome, not as `complete`",
    );
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

test("the <tool_call> XML signature is detected", () => {
  assert.equal(
    detectMalformedToolCall("<tool_call>{\"name\":\"x\"}</tool_call>", 0, [], "stop"),
    true,
  );
});

test("a tool-name block is detected only for tools that exist", () => {
  const text = "<cu_public__search-clemson-classes>{}</cu_public__search-clemson-classes>";
  assert.equal(
    detectMalformedToolCall(text, 0, ["cu_public__search-clemson-classes"], "stop"),
    true,
  );
  assert.equal(
    detectMalformedToolCall(text, 0, ["some_other_tool"], "stop"),
    false,
    "an arbitrary angle-bracket string must not be flagged",
  );
});

// The detector must not fire on a turn that really ran tools — a legitimate
// answer is allowed to mention a tool name.
test("a turn that ran tools is never flagged as malformed", () => {
  assert.equal(
    detectMalformedToolCall("<tool_call> appears in this prose", 3, [], "stop"),
    false,
  );
});

// The endpoint owners asked that this NOT be worked around by parsing the XML
// back into a tool call. This pins the decision so a future editor has to
// delete an explicit test to reverse it, rather than quietly adding a parser.
test("the malformed generation is reported, never parsed back into a tool call", async () => {
  const provider = await startFakeProvider({
    toolCallsBeforeAnswer: 0,
    answer: "<echo>\n{\"text\":\"ping\"}\n</echo>",
  });
  const session = fakeSession();
  let executed = 0;
  setAdvisorBridgeForTest({
    tools: [fakeEchoTool(() => executed++)],
    close: async () => {},
  });

  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "hello",
    );
    assert.equal(result.outcome, "malformed_tool_call");
    assert.equal(
      executed,
      0,
      "the XML was parsed and the tool was run — the endpoint owners explicitly asked that this not be worked around",
    );
    assert.equal(result.toolCalls, 0);
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }
});

// --- item 4: the egress gate must check the DESTINATION ---------------------
//
// The gate mapped a chain NAME to a policy provider and did a string lookup.
// ADVISOR_BASE_URL — the URL actually dialled — was never inspected, so
// `ADVISOR_BASE_URL=https://anything/v1` passed cleanly while the comment
// claimed the gate was all that stood between a typo in a unit file and student
// context going somewhere undeclared.

test("the egress gate rejects a chain entry that would dial an undeclared host", () => {
  assert.throws(
    () =>
      assertAdvisorChainAuthorized(
        ["spark"],
        () => true,
        () => "evil.example.com",
      ),
    /not covered by egress provider/,
    "a redirected base URL must fail closed",
  );
});

test("the egress gate rejects a chain entry whose host cannot be resolved", () => {
  assert.throws(
    () =>
      assertAdvisorChainAuthorized(
        ["spark"],
        () => true,
        () => undefined,
      ),
    /no resolvable endpoint host/,
  );
});

test("the egress gate accepts the declared spark host", () => {
  assert.doesNotThrow(() =>
    assertAdvisorChainAuthorized(
      ["spark"],
      () => true,
      () => "gcspark.clemson.edu",
    ),
  );
});

// The shipped default must pass its own gate, host check included.
test("the shipped chain passes the host check with the shipped base URL", () => {
  assert.doesNotThrow(() => assertAdvisorChainAuthorized(["spark", "openai"]));
});

// Captured LIVE from the spark endpoint on 2026-07-22 while it was in the
// degraded state. The model varies the wrapper it invents from generation to
// generation, so a detector matching only `<tool_call>` missed real cases —
// two of these six. Pinning the real shapes keeps that from regressing.
const LIVE_MALFORMED = [
  '\n\n<tool_call>\n{"name": "cu_public__search-clemson-classes", "parameters": {"term": "202608"}}\n',
  '\n\n<tool_call>\n{"type": "function", "name": "cu_public__list-clemson-terms", "parameters": {"max": 10}}\n</tool_call>',
  '\n\n<parameter name="cu_public__list-clemson-terms">\n<parameter name="max">5</parameter>\n</parameter>\n</function>',
  'Let me look up the terms first.\n\n<tool_code>\n```json\n{"name": "cu_public__list-clemson-terms"}\n```',
  "I'll list terms.\n\n<cu_public__list-clemson-terms>\n{\"max\": 20}\n</cu_public__list-clemson-terms>",
  // Captured live 2026-07-22: the ENTIRE content was the bare tool name, with
  // no invocation punctuation at all. An earlier detector required a `{` or `<`
  // nearby and missed this outright.
  "cu_public__list-clemson-terms",
];

test("every malformed shape captured live is detected", () => {
  for (const [i, sample] of LIVE_MALFORMED.entries()) {
    assert.equal(
      detectMalformedToolCall(
        sample,
        0,
        ["cu_public__list-clemson-terms", "cu_public__search-clemson-classes"],
        "stop",
      ),
      true,
      `live sample ${i + 1} slipped through the detector`,
    );
  }
});

// --- truncation is NOT the endpoint's degradation ---------------------------
//
// A previous wave reported this endpoint degraded in 100% of 11 trials and
// asked for a server restart. Independent testing showed the detector was
// firing on generations cut off by a small max_tokens: the partial output left
// tool-call XML in `content` with zero tool calls, which is byte-for-byte what
// the real degradation looks like. The ONLY thing that tells them apart is the
// stop reason — "stop" for the endpoint's fault, "length" for ours — so the
// detector has to check it. These tests pin both directions.

test("a TRUNCATED generation is not reported as the endpoint's degradation", () => {
  // Byte-for-byte the shape the detector fires on, differing only in stop
  // reason. If this ever returns true, the detector is back to asking an
  // operator to restart a shared server because WE set the budget too low.
  const partial = "<tool_call>\n{\"name\": \"cu_public__list-clemson-te";
  assert.equal(
    detectMalformedToolCall(partial, 0, ["cu_public__list-clemson-terms"], "length"),
    false,
    "truncated output must never be attributed to the endpoint",
  );
  assert.equal(
    detectMalformedToolCall(partial, 0, ["cu_public__list-clemson-terms"], "stop"),
    true,
    "the same text at finish_reason stop IS the endpoint's degradation",
  );
});

test("every live malformed shape is rejected when the stop reason is length", () => {
  const names = [
    "cu_public__list-clemson-terms",
    "cu_public__search-clemson-classes",
  ];
  for (const [i, sample] of LIVE_MALFORMED.entries()) {
    assert.equal(
      detectMalformedToolCall(sample, 0, names, "length"),
      false,
      `live sample ${i + 1} was attributed to the endpoint despite being truncated`,
    );
  }
});

// End-to-end: the two failures must reach the caller as DIFFERENT outcomes, and
// neither may reach it as `complete`.
test("a length-stopped turn yields `truncated`, and a stop-stopped one `malformed_tool_call`", async () => {
  const xml =
    "<cu_public__search-clemson-classes>\n{\"subject\":\"CPSC\"}\n</cu_public__search-clemson-classes>";

  async function outcomeFor(finishReason: "stop" | "length") {
    const provider = await startFakeProvider({
      toolCallsBeforeAnswer: 0,
      answer: xml,
      finishReason,
    });
    const session = fakeSession();
    setAdvisorBridgeForTest({
      tools: [fakeNamedTool("cu_public__search-clemson-classes")],
      close: async () => {},
    });
    try {
      const result = await __runWithProviderForTest(
        sparkTarget(provider.url) as never,
        session,
        "what CPSC classes are offered?",
      );
      return result;
    } finally {
      setAdvisorBridgeForTest(null);
      await provider.close();
      rmSync(session.workDir, { recursive: true, force: true });
      rmSync(session.piSessionRoot, { recursive: true, force: true });
    }
  }

  const truncated = await outcomeFor("length");
  const malformed = await outcomeFor("stop");

  assert.equal(
    truncated.outcome,
    "truncated",
    "a budget-exhausted turn must be reported as ours to fix",
  );
  assert.equal(
    malformed.outcome,
    "malformed_tool_call",
    "an endpoint-degraded turn must still be reported as the endpoint's",
  );
  assert.notEqual(
    truncated.outcome,
    malformed.outcome,
    "identical text must not collapse to one outcome — the remedies differ",
  );
  for (const r of [truncated, malformed]) {
    assert.notEqual(r.outcome, "complete", "neither may render as a finished answer");
  }
});

// The detector must not fire on a real answer. A grounded reply talks about
// "the class search", not about the wire name of a tool.
test("a genuine answer is never flagged as malformed", () => {
  const names = ["cu_public__list-clemson-terms", "cu_public__search-clemson-classes"];
  for (const answer of [
    "Fall 2026 has three CPSC 3000-level classes: CPSC 3300, CPSC 3600, and CPSC 3720.",
    "I looked this up with the class search tool and found nothing for that term.",
    "You need 12 more credits. Your catalog year is 2024-2025.",
  ]) {
    assert.equal(
      detectMalformedToolCall(answer, 0, names, "stop"),
      false,
      `a genuine answer was flagged: ${answer}`,
    );
  }
});

// REGRESSION: with enable_thinking on, the endpoint can spend its whole
// completion budget in `reasoning` deltas and stop with finish_reason "stop",
// no content and no tool calls. Reasoning is not an answer and is filtered out
// of `text`, so the turn used to arrive at outcome `complete` with an empty
// string — a blank answer rendered as a finished one. Observed live 2026-07-22.
test("a thinking-only turn with no answer text fails instead of returning blank", async () => {
  const provider = await startFakeProvider({
    toolCallsBeforeAnswer: 0,
    answer: "",
  });
  const session = fakeSession();
  setAdvisorBridgeForTest({ tools: [fakeEchoTool()], close: async () => {} });

  let outcome = "";
  let threw = false;
  try {
    const result = await __runWithProviderForTest(
      sparkTarget(provider.url) as never,
      session,
      "hello",
    );
    outcome = result.outcome;
  } catch {
    threw = true;
  } finally {
    setAdvisorBridgeForTest(null);
    await provider.close();
    rmSync(session.workDir, { recursive: true, force: true });
    rmSync(session.piSessionRoot, { recursive: true, force: true });
  }

  assert.ok(threw, `an empty answer was returned as outcome "${outcome}" instead of failing`);
});
