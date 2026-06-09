import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  assertHttpAuthConfig,
  createHttpHandler,
  isLoopbackHost,
  openAuthenticator,
  resolveCredentialedAuth,
} from "../src/mcp-tools/server.ts";
import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";

test("assertHttpAuthConfig: open mode allowed only on loopback", () => {
  assert.doesNotThrow(() => assertHttpAuthConfig("", "127.0.0.1"));
  assert.doesNotThrow(() => assertHttpAuthConfig("", "::1"));
  assert.throws(
    () => assertHttpAuthConfig("", "0.0.0.0"),
    /required when MCP_HTTP_HOST is not loopback/,
  );
  assert.doesNotThrow(() => assertHttpAuthConfig("tok", "0.0.0.0"));
});

test("isLoopbackHost", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("openAuthenticator always admits", () => {
  assert.equal(openAuthenticator(undefined), "public");
  assert.equal(openAuthenticator("Bearer whatever"), "public");
});

test("resolveCredentialedAuth fails closed with no consumers", () => {
  assert.throws(
    () => resolveCredentialedAuth({ load: () => [] }),
    /no authorized consumers|Refusing to start open/,
  );
});

test("resolveCredentialedAuth authenticates a registered token and reports it", () => {
  const seen: string[] = [];
  const consumers: Consumer[] = [
    { id: "agent-1", token_hash: hashToken("cma_tok"), created_at: "x" },
  ];
  const authenticate = resolveCredentialedAuth({
    load: () => consumers,
    onSeen: (id) => seen.push(id),
  });
  assert.equal(authenticate("Bearer cma_tok"), "agent-1");
  assert.equal(authenticate("Bearer nope"), null);
  assert.deepEqual(seen, ["agent-1"]); // onSeen fires only on success
});

test("resolveCredentialedAuth accepts the env token as a consumer", () => {
  const authenticate = resolveCredentialedAuth({
    load: () => [],
    envToken: "env-secret",
  });
  assert.equal(authenticate("Bearer env-secret"), "env-token");
});

test("createHttpHandler rejects an oversized body with 413", () => {
  const handler = createHttpHandler("t", () => "agent");
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    socket: { remoteAddress: string };
    destroy: () => void;
  };
  req.headers = { authorization: "Bearer x" };
  req.method = "POST";
  req.socket = { remoteAddress: "127.0.0.1" };
  let destroyed = false;
  req.destroy = () => {
    destroyed = true;
  };
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: () => {},
    on: () => {},
  };
  handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
  );
  // Emit a chunk larger than the 1 MiB cap.
  req.emit("data", Buffer.alloc(1_048_577));
  assert.equal(status, 413);
  assert.equal(destroyed, true);
});

test("createHttpHandler rejects an unauthenticated request with 401", () => {
  const handler = createHttpHandler("t", () => null);
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    socket: { remoteAddress: string };
  };
  req.headers = {};
  req.method = "POST";
  req.socket = { remoteAddress: "127.0.0.1" };
  let status = 0;
  let ended = false;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: () => {
      ended = true;
    },
    on: () => {},
  };
  handler(
    req as unknown as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
  );
  assert.equal(status, 401);
  assert.equal(ended, true);
});
