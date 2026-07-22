import assert from "node:assert/strict";
import test from "node:test";

import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

import { advisorMcpServers, createAdvisorMcpBridge } from "../src/advisor-mcp.ts";

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

  const expected = serverNames
    .flatMap((name, i) => toolsByServer[i]!.map((t) => `${name}__${t.name}`))
    .sort();
  assert.deepEqual(
    bridge.tools.map((t) => t.name).sort(),
    expected,
  );
  assert.equal(bridge.tools.length, expected.length);

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
    .map((name, i) => (i === failingIndex ? null : `${name}__only_${i}`))
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
