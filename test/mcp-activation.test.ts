import assert from "node:assert/strict";
import test from "node:test";

import {
  McpPermissionDeniedError,
  assertMcpOperation,
  isMcpOperationExposed,
} from "../src/mcp-tools/permissions.ts";

// After repointing the MCP server onto the GCassistant Graph app, the
// mail/calendar write operations whose policy action is approval=none become
// exposed, while destructive/affects-others ones stay policy-blocked.

test("activated writes are exposed", () => {
  for (const op of [
    "mail.list_messages",
    "mail.get_message",
    "mail.move_message",
    "mail.update_message",
    "mail.create_draft",
    "calendar.list_events",
    "calendar.create_event",
    "calendar.update_event",
    "todo.create_task",
    "todo.update_task",
  ]) {
    assert.equal(isMcpOperationExposed(op), true, `${op} should be exposed`);
  }
});

test("destructive / affects-others ops stay policy-blocked", () => {
  for (const op of [
    "todo.delete_task",
    "calendar.delete_event",
    "calendar.accept_event",
    "calendar.decline_event",
    "calendar.tentatively_accept_event",
  ]) {
    assert.equal(isMcpOperationExposed(op), false, `${op} must stay blocked`);
  }
});

test("move requires the destination allow-list", () => {
  const prev = process.env.MCP_ALLOWED_MAIL_DESTINATIONS;
  delete process.env.MCP_ALLOWED_MAIL_DESTINATIONS;
  try {
    assert.throws(
      () =>
        assertMcpOperation("mail.move_message", {
          input: { id: "x", destinationId: "archive" },
        }),
      (err) =>
        err instanceof McpPermissionDeniedError &&
        /destination_folder_allow_list/.test(err.message),
    );
    // With the folder allow-listed, the constraint passes.
    process.env.MCP_ALLOWED_MAIL_DESTINATIONS = "archive";
    assert.doesNotThrow(() =>
      assertMcpOperation("mail.move_message", {
        input: { id: "x", destinationId: "archive" },
      }),
    );
  } finally {
    if (prev === undefined) delete process.env.MCP_ALLOWED_MAIL_DESTINATIONS;
    else process.env.MCP_ALLOWED_MAIL_DESTINATIONS = prev;
  }
});

test("update is metadata-only (rejects body rewrites)", () => {
  assert.throws(
    () =>
      assertMcpOperation("mail.update_message", {
        input: { id: "x", body: "rewrite" },
      }),
    (err) =>
      err instanceof McpPermissionDeniedError &&
      /metadata_only/.test(err.message),
  );
});

test("draft creation forbids sending", () => {
  assert.throws(
    () =>
      assertMcpOperation("mail.create_draft", {
        input: { subject: "x", send: true },
      }),
    (err) =>
      err instanceof McpPermissionDeniedError && /draft_only/.test(err.message),
  );
});
