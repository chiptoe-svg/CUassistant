import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidScopeTokens,
  providerIsApproved,
} from "../scripts/mcp-consumers-helpers.ts";

test("invalidScopeTokens returns the unrecognized tokens only", () => {
  assert.deepEqual(invalidScopeTokens(["mail:read", "clemson"]), []);
  assert.deepEqual(invalidScopeTokens(["mail:read", "bogus", "nope"]), [
    "bogus",
    "nope",
  ]);
});

test("providerIsApproved reflects the real policy", () => {
  assert.equal(providerIsApproved("chatgpt_edu"), true);
  assert.equal(providerIsApproved("openai_api"), true);
  assert.equal(providerIsApproved("anthropic"), false);
  assert.equal(providerIsApproved(""), false);
});
