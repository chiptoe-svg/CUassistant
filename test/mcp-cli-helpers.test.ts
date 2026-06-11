import assert from "node:assert/strict";
import test from "node:test";

import {
  approvedProviders,
  invalidScopeTokens,
  providerIsApproved,
  validScopeTokens,
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

test("approvedProviders + validScopeTokens expose the help-text lists", () => {
  assert.ok(approvedProviders().includes("chatgpt_edu"));
  assert.ok(!approvedProviders().includes("anthropic")); // unauthorized excluded
  assert.ok(validScopeTokens().includes("mail:send"));
  assert.ok(validScopeTokens().includes("clemson"));
});
