import assert from "node:assert/strict";
import test from "node:test";

import { FORBIDDEN_CHILD_ENV_KEYS, buildChildEnv } from "../src/child-env.ts";

const SECRET_SOURCE: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/test",
  LC_ALL: "en_US.UTF-8",
  CODEX_HOME: "/Users/test/.codex",
  GWS_CONFIG_DIR: "/Users/test/.gws",
  HTTPS_PROXY: "http://proxy:8080",
  MS365_REFRESH_TOKEN: "secret-ms-token",
  OPENAI_API_KEY: "sk-secret",
  MS365_CLIENT_ID: "client-id",
};

test("child env forwards safe operational variables", () => {
  const env = buildChildEnv({}, SECRET_SOURCE);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/Users/test");
  assert.equal(env.LC_ALL, "en_US.UTF-8");
  assert.equal(env.CODEX_HOME, "/Users/test/.codex");
  assert.equal(env.GWS_CONFIG_DIR, "/Users/test/.gws");
  assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
});

test("child env never forwards host secrets", () => {
  const env = buildChildEnv({}, SECRET_SOURCE);
  for (const key of FORBIDDEN_CHILD_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must not reach the child`);
  }
});

test("child env is fail-closed: unknown variables are dropped", () => {
  const env = buildChildEnv({}, { ...SECRET_SOURCE, SOME_FUTURE_SECRET: "x" });
  assert.equal(env.SOME_FUTURE_SECRET, undefined);
  // Client id is not a secret but is unrelated to the child, so it is dropped.
  assert.equal(env.MS365_CLIENT_ID, undefined);
});

test("explicit extras are merged and win over the source env", () => {
  const env = buildChildEnv(
    { GWS_CREDENTIAL_STORE: "plaintext" },
    SECRET_SOURCE,
  );
  assert.equal(env.GWS_CREDENTIAL_STORE, "plaintext");
  // ...without dragging secrets along.
  assert.equal(env.OPENAI_API_KEY, undefined);
});
