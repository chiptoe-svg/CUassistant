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

test("list-mail-folders is exposed (read-only, both providers)", () => {
  assert.equal(isMcpOperationExposed("mail.list_folders"), true);
});

test("move is allow-listed by destination subtree prefix", () => {
  process.env.MCP_ALLOWED_MAIL_DESTINATIONS = "sorted";
  assert.doesNotThrow(() =>
    assertMcpOperation("mail.move_message", {
      input: { destination: "sorted/Newsletters" },
    }),
  );
  assert.throws(
    () =>
      assertMcpOperation("mail.move_message", {
        input: { destination: "other/x" },
      }),
    McpPermissionDeniedError,
  );
  // system/destructive folders are rejected even if prefix-allowed
  assert.throws(
    () =>
      assertMcpOperation("mail.move_message", {
        input: { destination: "Deleted Items" },
      }),
    McpPermissionDeniedError,
  );
});

test("move fails closed when no destination subtree is configured", () => {
  delete process.env.MCP_ALLOWED_MAIL_DESTINATIONS;
  assert.throws(
    () =>
      assertMcpOperation("mail.move_message", {
        input: { destination: "sorted/Newsletters" },
      }),
    McpPermissionDeniedError,
  );
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
