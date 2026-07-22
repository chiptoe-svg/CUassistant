import assert from "node:assert/strict";
import test from "node:test";

import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

import {
  advisorMcpServers,
  assertAdvisorMcpUrlSafe,
  createAdvisorMcpBridge,
} from "../src/advisor-mcp.ts";

test("exactly the three intended servers are configured", () => {
  const servers = advisorMcpServers();
  assert.deepEqual(Object.keys(servers).sort(), [
    "cu_catalog",
    "cu_public",
    "gc_curriculum_wiki",
  ]);
});

// 8765 carries send-outlook-mail, send-gmail, and calendar writes. Pi receives
// an explicit tool array, so a server that is not configured contributes no
// tools — but a typo in a URL could still point at it.
test("the credentialed server is never configured", () => {
  const json = JSON.stringify(advisorMcpServers());
  assert.doesNotMatch(json, /8765/, "8765 must never appear");
});

test("the public and catalog servers carry no auth header", () => {
  const servers = advisorMcpServers();
  assert.equal(servers.cu_public!.headers, undefined);
  assert.equal(servers.cu_catalog!.headers, undefined);
});

// The curriculum wiki returns 401 without a token. A missing token must be
// visible as a missing header, not silently sent as "Bearer undefined".
test("the wiki carries a bearer header only when a token is configured", () => {
  const servers = advisorMcpServers();
  const wiki = servers.gc_curriculum_wiki!;
  if (process.env.ADVISOR_MCP_WIKI_TOKEN) {
    assert.match(wiki.headers!.Authorization!, /^Bearer .+/);
  } else {
    assert.equal(wiki.headers, undefined);
  }
});

// --- createAdvisorMcpBridge: exercised with fake injected deps -------------
//
// These fakes stand in for the real StreamableHTTPClientTransport / Client so
// the bridge's per-server orchestration (connect, collect tools, tolerate
// failures, close) can be verified without opening real sockets.

function fakeTool(name: string): McpTool {
  return { name, inputSchema: { type: "object" } } as McpTool;
}

function fakeTransport(): { transport: StreamableHTTPClientTransport; state: { closed: boolean } } {
  const state = { closed: false };
  const transport = {
    close: async () => {
      state.closed = true;
    },
  };
  return { transport: transport as unknown as StreamableHTTPClientTransport, state };
}

interface FakeClientOptions {
  tools?: McpTool[];
  connectError?: Error;
  onClose?: () => void;
}

function fakeClient(opts: FakeClientOptions) {
  return {
    async connect(_transport: unknown) {
      if (opts.connectError) throw opts.connectError;
    },
    async listTools() {
      return { tools: opts.tools ?? [] };
    },
    async callTool(_request: { name: string; arguments: Record<string, unknown> }) {
      return { content: [] };
    },
    async close() {
      opts.onClose?.();
    },
  };
}

// Wires a fixed, ordered list of fake clients to the servers
// advisorMcpServers() produces (Object.entries order: cu_public, cu_catalog,
// gc_curriculum_wiki). createClient() is called once per server with no
// arguments, so the only way to hand back a distinct fake per server is to
// hand them out in call order — which matches iteration order over the same
// object every time.
function makeDeps(clients: ReturnType<typeof fakeClient>[]) {
  let clientIndex = 0;
  const transports: Array<{ closed: boolean }> = [];
  return {
    deps: {
      createTransport: (_url: URL, _init: unknown) => {
        const { transport, state } = fakeTransport();
        transports.push(state);
        return transport;
      },
      createClient: () => clients[clientIndex++]!,
    },
    transports,
  };
}

test("createAdvisorMcpBridge returns the union of tools from each connected server, and nothing else", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  const toolsByServer = serverNames.map((_name, i) => [fakeTool(`tool_${i}_a`), fakeTool(`tool_${i}_b`)]);
  const clients = toolsByServer.map((tools) => fakeClient({ tools }));
  const { deps } = makeDeps(clients);

  const bridge = await createAdvisorMcpBridge(deps);

  const expected = toolsByServer.flat().map((t) => t.name).sort();
  assert.deepEqual(
    bridge.tools.map((t) => t.name).sort(),
    expected,
  );
  assert.equal(bridge.tools.length, expected.length);

  await bridge.close();
});

// --- bare tool names --------------------------------------------------------
//
// The Spark endpoint's quantized qwen3.6-35b-a3b degrades on
// `<server>__<tool>` names: it emits <tool_call> XML into `content` with
// finish_reason "stop" and zero structured tool_calls. Replaying a captured
// payload, prefixes-stripped was the ONLY change that flipped 0/3 to 3/3 —
// and it did so while making the tools block LARGER than a namespaced variant
// that still failed, so size is not the mechanism. Namespacing here is
// therefore a live outage, not a style choice.

test("MCP tools are exposed under their bare names, with no server prefix", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  const clients = serverNames.map((_name, i) => fakeClient({ tools: [fakeTool(`search_thing_${i}`)] }));
  const { deps } = makeDeps(clients);

  const bridge = await createAdvisorMcpBridge(deps);

  assert.deepEqual(
    bridge.tools.map((t) => t.name).sort(),
    serverNames.map((_name, i) => `search_thing_${i}`).sort(),
  );
  for (const tool of bridge.tools) {
    assert.doesNotMatch(
      tool.name,
      /__/,
      `tool "${tool.name}" is namespaced; the endpoint stops emitting structured tool_calls`,
    );
  }

  await bridge.close();
});

// The server qualifier is not lost, just moved off the wire: `label` is
// UI-display metadata in pi-agent-core and is never serialized into the
// request, so it keeps provenance readable without costing the model anything.
test("the server qualifier survives on label, which never reaches the wire", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  const clients = serverNames.map((_name, i) => fakeClient({ tools: [fakeTool(`labelled_${i}`)] }));
  const { deps } = makeDeps(clients);

  const bridge = await createAdvisorMcpBridge(deps);

  assert.deepEqual(
    bridge.tools.map((t) => t.label).sort(),
    serverNames.map((name, i) => `${name}:labelled_${i}`).sort(),
  );

  await bridge.close();
});

// Dropping the prefix reintroduces the collision risk it was preventing. A
// silently shadowed tool is worse than the collision: the agent would call one
// server believing it called the other. It must fail loudly at startup, naming
// both servers and the tool.
test("two servers exposing the same tool name throws at startup, naming both servers", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  assert.ok(serverNames.length >= 2, "test needs at least two configured servers");

  const clients = serverNames.map(() => fakeClient({ tools: [fakeTool("get_courses")] }));
  const { deps } = makeDeps(clients);

  await assert.rejects(
    () => createAdvisorMcpBridge(deps),
    (err: Error) => {
      assert.match(err.message, /collision/i);
      assert.match(err.message, /get_courses/, "the colliding tool must be named");
      assert.match(err.message, new RegExp(serverNames[0]!), "the first server must be named");
      assert.match(err.message, new RegExp(serverNames[1]!), "the second server must be named");
      return true;
    },
  );
});

// A collision must not be swallowed by the per-server skip-and-continue
// handler that tolerates unreachable servers — that handler would turn a fatal
// misconfiguration back into a silent shadow.
test("a collision is fatal, not logged and skipped like an unreachable server", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  const clients = serverNames.map(() => fakeClient({ tools: [fakeTool("get_courses")] }));
  const { deps } = makeDeps(clients);

  const originalConsoleError = console.error;
  const loggedErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };
  try {
    await assert.rejects(() => createAdvisorMcpBridge(deps), /collision/i);
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(
    !loggedErrors.some((args) => String(args[0]).includes("skipping MCP server")),
    "a collision must not be downgraded to a skipped-server log line",
  );
});

// Distinct names across servers must NOT trip the guard, or the collision test
// above would pass against a bridge that simply throws on every startup.
test("distinct tool names across servers do not trip the collision guard", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  const clients = serverNames.map((_name, i) => fakeClient({ tools: [fakeTool(`distinct_${i}`)] }));
  const { deps } = makeDeps(clients);

  const bridge = await createAdvisorMcpBridge(deps);
  assert.equal(bridge.tools.length, serverNames.length);

  await bridge.close();
});

test("a server that fails to connect is skipped, not fatal — the other servers' tools are still returned", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  assert.ok(serverNames.length >= 2, "test needs at least two configured servers");
  const failingIndex = 1;

  const clients = serverNames.map((_name, i) =>
    i === failingIndex
      ? fakeClient({ connectError: new Error("ECONNREFUSED: fake unreachable server") })
      : fakeClient({ tools: [fakeTool(`only_${i}`)] }),
  );
  const { deps } = makeDeps(clients);

  const originalConsoleError = console.error;
  const loggedErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };
  let bridge;
  try {
    bridge = await createAdvisorMcpBridge(deps);
  } finally {
    console.error = originalConsoleError;
  }

  const expected = serverNames
    .map((_name, i) => (i === failingIndex ? null : `only_${i}`))
    .filter((name): name is string => name !== null)
    .sort();
  assert.deepEqual(bridge.tools.map((t) => t.name).sort(), expected);
  assert.ok(
    loggedErrors.some((args) => String(args[0]).includes(serverNames[failingIndex]!)),
    "expected the skip to be logged with the failing server's name",
  );

  await bridge.close();
});

test("close() closes every client (and transport) that was successfully opened", async () => {
  const serverNames = Object.keys(advisorMcpServers());
  let closedClientCount = 0;
  const clients = serverNames.map(() =>
    fakeClient({
      tools: [],
      onClose: () => {
        closedClientCount++;
      },
    }),
  );
  const { deps, transports } = makeDeps(clients);

  const bridge = await createAdvisorMcpBridge(deps);
  assert.equal(transports.length, serverNames.length, "sanity: one transport per server");
  assert.ok(transports.every((t) => !t.closed), "sanity: nothing closed before close() is called");

  await bridge.close();

  assert.equal(closedClientCount, serverNames.length);
  assert.ok(
    transports.every((t) => t.closed),
    "every opened transport should be closed",
  );
});

// --- MCP server identity ----------------------------------------------------
//
// The server array is fixed at three entries, so no FOURTH server can be added
// — but each entry's URL comes from the environment, so a slot can be
// SUBSTITUTED. `ADVISOR_MCP_PUBLIC_URL=http://127.0.0.1:8765/` puts the
// credentialed server into the agent's tool array, and with MCP_AUTH_TOKEN
// unset that server is loopback-open, so the substitution needs no credential.
// send-outlook-mail, send-gmail, and calendar writes would join the tools the
// advisor agent can call.

test("an advisor MCP URL on the credentialed port is rejected", () => {
  assert.throws(
    () => assertAdvisorMcpUrlSafe("cu_public", "http://127.0.0.1:8765/"),
    /credentialed MCP server/,
    "substituting the credentialed server must fail closed",
  );
});

// Matching on port regardless of host: a remote host on 8765 is not our server
// either, and an advisor MCP URL has no business naming that port.
test("the credentialed port is rejected on any host, not just loopback", () => {
  assert.throws(
    () => assertAdvisorMcpUrlSafe("cu_public", "http://example.com:8765/"),
    /credentialed MCP server/,
  );
});

test("the legitimate public and catalog URLs are accepted", () => {
  assert.doesNotThrow(() =>
    assertAdvisorMcpUrlSafe("cu_public", "http://127.0.0.1:8766/"),
  );
  assert.doesNotThrow(() =>
    assertAdvisorMcpUrlSafe("cu_catalog", "http://127.0.0.1:8767/"),
  );
});

test("an unparseable advisor MCP URL is rejected rather than ignored", () => {
  assert.throws(
    () => assertAdvisorMcpUrlSafe("cu_public", "not a url"),
    /unparseable/,
  );
});

// The check has to run when the server list is BUILT, which is what
// createAdvisorMcpBridge does at startup — not lazily at the first tool call.
//
// Run in a CHILD PROCESS: the URLs are module-level constants read from the
// environment at config load, so an in-process test cannot re-read them, and a
// dynamic re-import gets the cached config module and silently tests nothing.
test("a substituted URL fails the process at startup, not at first use", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const result = await run(
    "npx",
    ["tsx", "test/fixtures/advisor-mcp-startup.ts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ADVISOR_MCP_PUBLIC_URL: "http://127.0.0.1:8765/" },
    },
  ).catch((err: { stdout?: string; stderr?: string }) => err);

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(
    output,
    /credentialed MCP server/,
    `the substituted URL was accepted at startup — output was: ${output}`,
  );
});

// The same fixture with the shipped URLs must NOT throw, or the test above
// would pass on a fixture that fails for any reason at all.
test("the fixture starts cleanly with the shipped URLs", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const { stdout } = await run(
    "npx",
    ["tsx", "test/fixtures/advisor-mcp-startup.ts"],
    { cwd: new URL("..", import.meta.url).pathname },
  );
  assert.match(stdout, /servers-ok/);
});
