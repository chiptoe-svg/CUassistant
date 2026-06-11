import assert from "node:assert/strict";
import test from "node:test";

import {
  attestConsumer,
  authenticateBearer,
  authenticateConsumer,
  generateToken,
  hashToken,
  parseConsumers,
  staleConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.ts";

test("hashToken is a stable sha256 hex digest", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.match(hashToken("abc"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken("abc"), hashToken("abd"));
});

test("generateToken yields a high-entropy, prefixed, unique token", () => {
  const t1 = generateToken();
  const t2 = generateToken();
  assert.match(t1, /^cma_[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(t1, t2);
});

test("authenticateBearer returns the matching consumer id", () => {
  const token = "cma_secret-value";
  const consumers: Consumer[] = [
    { id: "nanoclaw-personal", token_hash: hashToken(token), created_at: "x" },
  ];
  assert.equal(
    authenticateBearer(`Bearer ${token}`, consumers),
    "nanoclaw-personal",
  );
});

test("authenticateBearer rejects unknown, missing, and malformed bearers", () => {
  const consumers: Consumer[] = [
    { id: "a", token_hash: hashToken("right"), created_at: "x" },
  ];
  assert.equal(authenticateBearer("Bearer wrong", consumers), null);
  assert.equal(authenticateBearer(undefined, consumers), null);
  assert.equal(authenticateBearer("right", consumers), null); // no "Bearer " prefix
  assert.equal(authenticateBearer("Bearer right", []), null); // empty registry
});

test("parseConsumers reads a registry and drops malformed entries", () => {
  const raw = JSON.stringify({
    consumers: [
      { id: "ok", token_hash: "h", created_at: "t" },
      { id: 123 }, // malformed id
      { token_hash: "x" }, // missing id
    ],
  });
  const list = parseConsumers(raw);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "ok");
});

test("parseConsumers returns [] on garbage or empty input", () => {
  assert.deepEqual(parseConsumers("not json"), []);
  assert.deepEqual(parseConsumers(""), []);
});

test("staleConsumers flags tokens older than maxAgeDays or unused past maxIdleDays", () => {
  const nowMs = Date.parse("2026-06-09T00:00:00.000Z");
  const consumers: Consumer[] = [
    // fresh: created recently, seen today
    {
      id: "fresh",
      token_hash: "h1",
      created_at: "2026-06-01T00:00:00.000Z",
      last_seen_at: "2026-06-09T00:00:00.000Z",
    },
    // old: created over a year ago
    {
      id: "old",
      token_hash: "h2",
      created_at: "2025-01-01T00:00:00.000Z",
      last_seen_at: "2026-06-08T00:00:00.000Z",
    },
    // idle: never seen, created long ago
    { id: "idle", token_hash: "h3", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const flagged = staleConsumers(consumers, {
    nowMs,
    maxAgeDays: 365,
    maxIdleDays: 90,
  });
  const ids = flagged.map((f) => f.id).sort();
  assert.deepEqual(ids, ["idle", "old"]);
});

test("authenticateConsumer returns the full matched consumer", () => {
  const token = "cma_secret-value";
  const consumers: Consumer[] = [
    {
      id: "a",
      token_hash: hashToken(token),
      created_at: "t",
      provider: "chatgpt_edu",
      scopes: ["mail:read"],
    },
  ];
  const got = authenticateConsumer(`Bearer ${token}`, consumers);
  assert.equal(got?.id, "a");
  assert.equal(got?.provider, "chatgpt_edu");
  assert.deepEqual(got?.scopes, ["mail:read"]);
  assert.equal(authenticateConsumer("Bearer wrong", consumers), null);
});

test("parseConsumers preserves provider and scopes", () => {
  const raw = JSON.stringify({
    consumers: [
      {
        id: "a",
        token_hash: "h",
        created_at: "t",
        provider: "openai_api",
        scopes: ["clemson"],
      },
    ],
  });
  const list = parseConsumers(raw);
  assert.equal(list[0].provider, "openai_api");
  assert.deepEqual(list[0].scopes, ["clemson"]);
});

test("attestConsumer sets provider/scopes without touching the token", () => {
  const list: Consumer[] = [
    { id: "a", token_hash: "HASH", created_at: "t", last_seen_at: "s" },
  ];
  attestConsumer(list, "a", "chatgpt_edu", ["mail:read"]);
  assert.equal(list[0].token_hash, "HASH");
  assert.equal(list[0].last_seen_at, "s");
  assert.equal(list[0].provider, "chatgpt_edu");
  assert.deepEqual(list[0].scopes, ["mail:read"]);
});

test("attestConsumer leaves scopes untouched when omitted, and throws on unknown id", () => {
  const list: Consumer[] = [
    { id: "a", token_hash: "h", created_at: "t", scopes: ["mail:read"] },
  ];
  attestConsumer(list, "a", "openai_api");
  assert.deepEqual(list[0].scopes, ["mail:read"]); // unchanged
  assert.equal(list[0].provider, "openai_api");
  assert.throws(() => attestConsumer([], "nope", "chatgpt_edu"));
});
