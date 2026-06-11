import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "../src/mcp-tools/index.ts"; // side-effect: register credentialed tools
import { createHttpHandler } from "../src/mcp-tools/server.ts";
import { allExposedOperations } from "../src/mcp-tools/permissions.ts";

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
