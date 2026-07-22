import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { ADVISOR_MAX_ROUNDS } from "../src/config.ts";
import {
  __runWithProviderForTest,
  assertAdvisorChainAuthorized,
  loadSystemPrompt,
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
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push(null);
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
                function: { name: "echo", arguments: '{"text":"ping"}' },
              },
            ],
          },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: "tool_calls" });
      } else {
        send({
          index: 0,
          delta: { role: "assistant", content: "final answer" },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: "stop" });
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
    assert.equal(first.temperature, 0, "spark must still get temperature 0");
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
