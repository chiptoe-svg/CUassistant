import assert from "node:assert/strict";
import test from "node:test";

import { shouldRegisterMcpTool } from "../src/mcp-tools/server.ts";
import {
  McpPermissionDeniedError,
  assertMcpOperation,
  isMcpOperationExposed,
} from "../src/mcp-tools/permissions.ts";
import type { McpToolDefinition } from "../src/mcp-tools/types.ts";

function fakeTool(operation?: string): McpToolDefinition {
  return {
    operation,
    tool: {
      name: operation ?? "missing-operation",
      description: "test tool",
      inputSchema: { type: "object" },
    },
    async handler() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

test("MCP registration fails closed when a tool has no operation mapping", () => {
  assert.equal(shouldRegisterMcpTool(fakeTool(undefined)), false);
});

test("policy-blocked operations are not exposed", () => {
  assert.equal(isMcpOperationExposed("todo.delete_task"), false);
});

test("calendar personal event constraints reject attendee invites before activation", () => {
  assert.throws(
    () =>
      assertMcpOperation("calendar.create_event", {
        input: { attendees: ["person@example.edu"] },
      }),
    (err) =>
      err instanceof McpPermissionDeniedError &&
      /no_attendees/.test(err.message),
  );
});
