import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBackendAuthorizedIn,
  isAgentBackendAuthorized,
  type AgentBackend,
} from "../src/policy.ts";

const backends: AgentBackend[] = [
  { provider: "chatgpt_edu", scope: "external", basis: "x", authorized: true },
  { provider: "openai_api", scope: "external", basis: "x", authorized: true },
  { provider: "anthropic", scope: "external", basis: "x", authorized: false },
];

test("agentBackendAuthorizedIn: authorized providers are true", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "chatgpt_edu"), true);
  assert.equal(agentBackendAuthorizedIn(backends, "openai_api"), true);
});

test("agentBackendAuthorizedIn: unauthorized provider is false", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "anthropic"), false);
});

test("agentBackendAuthorizedIn: fail closed on unknown/empty provider", () => {
  assert.equal(agentBackendAuthorizedIn(backends, "mistral"), false);
  assert.equal(agentBackendAuthorizedIn(backends, ""), false);
});

test("real policy authorizes chatgpt_edu + openai_api, not anthropic", () => {
  assert.equal(isAgentBackendAuthorized("chatgpt_edu"), true);
  assert.equal(isAgentBackendAuthorized("openai_api"), true);
  assert.equal(isAgentBackendAuthorized("anthropic"), false);
});
