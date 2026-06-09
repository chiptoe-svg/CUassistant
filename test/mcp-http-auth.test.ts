import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHttpAuthConfig,
  checkBearer,
  isLoopbackHost,
} from "../src/mcp-tools/server.ts";

test("checkBearer: open when no token configured", () => {
  assert.equal(checkBearer(undefined, ""), true);
  assert.equal(checkBearer("Bearer anything", ""), true);
});
test("checkBearer: enforced when token configured", () => {
  assert.equal(checkBearer("Bearer s3cret", "s3cret"), true);
  assert.equal(checkBearer("Bearer wrong", "s3cret"), false);
  assert.equal(checkBearer(undefined, "s3cret"), false);
  assert.equal(checkBearer("s3cret", "s3cret"), false);
});

test("assertHttpAuthConfig: no token allowed only on loopback", () => {
  assert.doesNotThrow(() => assertHttpAuthConfig("", "127.0.0.1"));
  assert.doesNotThrow(() => assertHttpAuthConfig("", "::1"));
  assert.throws(
    () => assertHttpAuthConfig("", "0.0.0.0"),
    /required when MCP_HTTP_HOST is not loopback/,
  );
  assert.doesNotThrow(() => assertHttpAuthConfig("tok", "0.0.0.0")); // token present -> any host ok
});
test("isLoopbackHost", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
