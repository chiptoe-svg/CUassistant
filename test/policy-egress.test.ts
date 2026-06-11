import assert from "node:assert/strict";
import test from "node:test";

import {
  egressAuthorizedIn,
  getEgressClassifiers,
  isEgressAuthorized,
  type EgressClassifier,
} from "../src/policy.ts";

const SAMPLE: EgressClassifier[] = [
  {
    provider: "codex_chatgpt_edu",
    scope: "external",
    sends: ["subject", "body"],
    basis: "Edu",
    authorized: true,
  },
  {
    provider: "openai_api",
    scope: "external",
    sends: ["subject", "body"],
    basis: "no DPA",
    authorized: false,
  },
  {
    provider: "local_omlx",
    scope: "local",
    sends: ["subject", "body"],
    basis: "on-host",
    authorized: true,
  },
];

test("egressAuthorizedIn is fail-closed: only authorized:true admits", () => {
  assert.equal(egressAuthorizedIn(SAMPLE, "codex_chatgpt_edu"), true);
  assert.equal(egressAuthorizedIn(SAMPLE, "local_omlx"), true);
  assert.equal(egressAuthorizedIn(SAMPLE, "openai_api"), false);
  assert.equal(egressAuthorizedIn(SAMPLE, "unknown_provider"), false);
  assert.equal(egressAuthorizedIn([], "codex_chatgpt_edu"), false);
});

test("the shipped policy authorizes Codex, OpenAI, and local backends", () => {
  // Reflects policy/action-policy.yaml data_egress as shipped. openai_api was
  // flipped to authorized:true once OpenAI was confirmed contract-covered.
  assert.equal(isEgressAuthorized("codex_chatgpt_edu"), true);
  assert.equal(isEgressAuthorized("openai_api"), true);
  assert.equal(isEgressAuthorized("local_omlx"), true);
  assert.equal(isEgressAuthorized("local_ollama"), true);
  assert.equal(isEgressAuthorized("not_listed"), false);
});

test("the policy can declare multiple providers including local LLMs", () => {
  const providers = getEgressClassifiers().map((c) => c.provider);
  assert.ok(providers.length >= 3, "expected several declared providers");
  assert.ok(providers.includes("local_omlx"));
  const local = getEgressClassifiers().filter((c) => c.scope === "local");
  assert.ok(local.length >= 1, "expected at least one local-scope provider");
});
