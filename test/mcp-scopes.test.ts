import assert from "node:assert/strict";
import test from "node:test";

import {
  SCOPE_OPERATIONS,
  allExposedOperations,
  expandScopes,
  isValidScopeToken,
} from "../src/mcp-tools/permissions.ts";

test("isValidScopeToken accepts known tokens and rejects unknown", () => {
  assert.equal(isValidScopeToken("mail:read"), true);
  assert.equal(isValidScopeToken("mail:send"), true);
  assert.equal(isValidScopeToken("clemson"), true);
  assert.equal(isValidScopeToken("bogus"), false);
});

test("expandScopes(undefined) returns the full exposed set", () => {
  assert.deepEqual(expandScopes(undefined), allExposedOperations());
  assert.deepEqual(expandScopes([]), allExposedOperations());
});

test("expandScopes narrows to the named surfaces only", () => {
  const s = expandScopes(["mail:read", "clemson"]);
  assert.equal(s.has("mail.list_messages"), true);
  assert.equal(s.has("clemson.search_classes"), true);
  assert.equal(s.has("mail.move_message"), false);
  assert.equal(s.has("sheets.read"), false);
});

test("mail:send is a separate scope from mail:write", () => {
  const w = expandScopes(["mail:write"]);
  assert.equal(w.has("mail.move_message"), true);
  assert.equal(w.has("mail.send_with_approval"), false);
  const s = expandScopes(["mail:send"]);
  assert.equal(s.has("mail.send_with_approval"), true);
  assert.equal(s.has("mail.move_message"), false);
});

test("every operation named in SCOPE_OPERATIONS is a real, exposed operation", () => {
  const exposed = allExposedOperations();
  for (const [token, ops] of Object.entries(SCOPE_OPERATIONS)) {
    for (const op of ops) {
      assert.ok(exposed.has(op), `${token} -> ${op} should be exposed`);
    }
  }
});

test("unknown scope tokens contribute nothing (no silent widening)", () => {
  assert.equal(expandScopes(["bogus:write"]).size, 0);
  assert.equal(
    expandScopes(["mail:read", "bogus"]).has("mail.list_messages"),
    true,
  );
  assert.equal(expandScopes(["mail:read", "bogus"]).size, 4);
});
