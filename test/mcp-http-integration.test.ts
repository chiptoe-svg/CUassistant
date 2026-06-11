import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "../src/mcp-tools/index.ts"; // side-effect: register credentialed tools
import { createHttpHandler } from "../src/mcp-tools/server.ts";
import {
  allExposedOperations,
  expandScopes,
} from "../src/mcp-tools/permissions.ts";

test("http transport completes the MCP handshake and lists tools", async () => {
  const server = http.createServer(
    createHttpHandler("test-credentialed", () => ({
      id: "test-agent",
      scopes: allExposedOperations(),
    })),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/`),
  );
  try {
    await client.connect(transport); // performs initialize + notifications/initialized
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, "expected tools");
    assert.ok(
      tools.some((t) => t.name === "list-mail-messages"),
      "expected list-mail-messages",
    );
  } finally {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a mail:read-scoped token lists only its in-scope tools over HTTP", async () => {
  const server = http.createServer(
    createHttpHandler("test-credentialed", () => ({
      id: "scoped-agent",
      scopes: expandScopes(["mail:read"]),
    })),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/`),
  );
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // mail:read expands to exactly the three read-only mail tools; every tool
    // the scoped agent can see must be a mail tool — calendar/tasks/sheets/docs
    // are out of scope and therefore hidden.
    assert.ok(names.length > 0, "expected at least one in-scope tool");
    assert.ok(
      names.every((n) => n.includes("mail")),
      `mail:read scope should yield only mail tools, got: ${names.join(", ")}`,
    );
    assert.ok(
      names.includes("list-mail-messages"),
      "expected list-mail-messages",
    );
  } finally {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
