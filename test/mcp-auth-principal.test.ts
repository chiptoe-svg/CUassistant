import assert from "node:assert/strict";
import test from "node:test";

import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";
import { resolveCredentialedAuth } from "../src/mcp-tools/server.ts";

const TOKEN = "cma_principal-test";
const loadWith = (c: Partial<Consumer>) => (): Consumer[] => [
  { id: "a", token_hash: hashToken(TOKEN), created_at: "t", ...c },
];

test("Principal returned for an attested, authorized, scoped consumer", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "chatgpt_edu", scopes: ["mail:read"] }),
  });
  const p = auth(`Bearer ${TOKEN}`);
  assert.equal(p?.id, "a");
  assert.equal(p?.provider, "chatgpt_edu");
  assert.equal(p?.scopes.has("mail.list_messages"), true);
  assert.equal(p?.scopes.has("mail.move_message"), false);
});

test("unscoped attested consumer gets the full exposed scope", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "openai_api" }),
  });
  const p = auth(`Bearer ${TOKEN}`);
  assert.equal(p?.scopes.has("mail.move_message"), true);
  assert.equal(p?.scopes.has("sheets.read"), true);
});

test("unattested consumer (no provider) is rejected", () => {
  const auth = resolveCredentialedAuth({ load: loadWith({}) });
  assert.equal(auth(`Bearer ${TOKEN}`), null);
});

test("consumer with an unauthorized provider is rejected", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "anthropic" }),
  });
  assert.equal(auth(`Bearer ${TOKEN}`), null);
});

test("wrong token is rejected", () => {
  const auth = resolveCredentialedAuth({
    load: loadWith({ provider: "chatgpt_edu" }),
  });
  assert.equal(auth("Bearer nope"), null);
});

test("env-token uses its configured provider", () => {
  const auth = resolveCredentialedAuth({
    load: (): Consumer[] => [],
    envToken: "cma_env",
    envTokenProvider: "chatgpt_edu",
  });
  assert.equal(auth(`Bearer cma_env`)?.id, "env-token");
  const authBad = resolveCredentialedAuth({
    load: (): Consumer[] => [],
    envToken: "cma_env2",
    envTokenProvider: "anthropic",
  });
  assert.equal(authBad(`Bearer cma_env2`), null);
});
