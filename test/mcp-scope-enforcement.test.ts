import assert from "node:assert/strict";
import test from "node:test";

import {
  isToolInScope,
  registerTools,
  toolsForScope,
} from "../src/mcp-tools/server.ts";

// Register two fake tools whose operations are real, exposed operations so
// shouldRegisterMcpTool accepts them.
registerTools([
  {
    operation: "clemson.list_terms",
    tool: {
      name: "x-terms",
      description: "fake",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  },
  {
    operation: "mail.list_messages",
    tool: {
      name: "x-mail",
      description: "fake",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  },
]);

test("toolsForScope returns only tools whose operation is in scope", () => {
  const names = toolsForScope(new Set(["clemson.list_terms"])).map(
    (t) => t.name,
  );
  assert.ok(names.includes("x-terms"));
  assert.ok(!names.includes("x-mail"));
});

test("isToolInScope reflects the operation membership", () => {
  assert.equal(isToolInScope("x-mail", new Set(["mail.list_messages"])), true);
  assert.equal(isToolInScope("x-mail", new Set(["clemson.list_terms"])), false);
  assert.equal(isToolInScope("nonexistent", new Set(["anything"])), false);
});
