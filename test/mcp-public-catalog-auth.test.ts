// Regression tests for the campus-reachable public (8766) and catalog (8767)
// MCP servers.
//
// These servers moved off a loopback-only "open" bind onto 0.0.0.0 with a
// bearer each. Two properties have to hold or that change is a hole:
//
//   1. FAIL CLOSED — with no key configured the server must refuse to start,
//      not fall back to serving open. Their consumer source is empty by
//      construction, so the env key is the only thing standing between campus
//      and an unauthenticated server.
//   2. PER-SERVER KEY SEPARATION — the public key must not open the catalog
//      server or vice versa, and neither may inherit 8765's per-agent registry
//      tokens. Otherwise "revoke one" silently means "revoke none".

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHttpAuthConfig,
  resolveCredentialedAuth,
  startMcpServer,
} from "../src/mcp-tools/server.ts";
import { hashToken, type Consumer } from "../src/mcp-tools/consumers.ts";

/** How mcp-public.ts / mcp-catalog.ts build their authenticator. */
function publicStyleAuth(envToken: string) {
  return resolveCredentialedAuth({
    envToken,
    envTokenProvider: "openai_api",
    load: () => [], // empty consumer source — the env key is the ONLY credential
  });
}

test("fail closed: no key configured means the server refuses to start", () => {
  // This is the startup path: startMcpServer calls resolveCredentialedAuth
  // eagerly, so a throw here is a process that never binds the port.
  assert.throws(
    () => publicStyleAuth(""),
    /no authorized consumers|Refusing to start open/,
    "an unset MCP_PUBLIC_AUTH_TOKEN must abort startup, never serve open",
  );
  // Whitespace is not a key either — resolveCredentialedAuth trims.
  assert.throws(() => publicStyleAuth("   "), /Refusing to start open/);
});

test("fail closed: an empty consumer source is not rescued by the on-disk registry", () => {
  // The credentialed server's registry has real consumers on this host. If the
  // public/catalog servers used the DEFAULT loader, those tokens would satisfy
  // the fail-closed check and a keyless server would happily start.
  const registryTokens: Consumer[] = [
    {
      id: "linda",
      token_hash: hashToken("registry-token"),
      created_at: "x",
      provider: "openai_api",
    },
  ];
  assert.doesNotThrow(() =>
    resolveCredentialedAuth({ load: () => registryTokens }),
  );
  assert.throws(
    () => resolveCredentialedAuth({ load: () => [], envToken: "" }),
    /Refusing to start open/,
  );
});

test("per-server separation: each key opens only its own server", () => {
  const authPublic = publicStyleAuth("public-key");
  const authCatalog = publicStyleAuth("catalog-key");

  assert.equal(authPublic("Bearer public-key")?.id, "env-token");
  assert.equal(authCatalog("Bearer catalog-key")?.id, "env-token");

  // The cross pairings are what "revoking one must not revoke the other"
  // reduces to: neither key is accepted by the other server.
  assert.equal(
    authPublic("Bearer catalog-key"),
    null,
    "the catalog key must not authenticate against the public server",
  );
  assert.equal(
    authCatalog("Bearer public-key"),
    null,
    "the public key must not authenticate against the catalog server",
  );
});

test("per-server separation: 8765 registry tokens do not open 8766/8767", () => {
  const registryTokens: Consumer[] = [
    {
      id: "linda",
      token_hash: hashToken("registry-token"),
      created_at: "x",
      provider: "openai_api",
    },
  ];
  // Sanity: that token IS valid against a credentialed-style authenticator.
  const credentialed = resolveCredentialedAuth({ load: () => registryTokens });
  assert.equal(credentialed("Bearer registry-token")?.id, "linda");

  // But not against the public server, whose consumer source is empty.
  const authPublic = publicStyleAuth("public-key");
  assert.equal(authPublic("Bearer registry-token"), null);
});

test("missing and malformed credentials are rejected", () => {
  const authPublic = publicStyleAuth("public-key");
  assert.equal(authPublic(undefined), null, "no Authorization header");
  assert.equal(authPublic(""), null, "empty Authorization header");
  assert.equal(authPublic("Bearer "), null, "empty bearer");
  assert.equal(authPublic("Bearer wrong-key"), null, "wrong key");
  assert.equal(authPublic("public-key"), null, "missing Bearer prefix");
  assert.equal(authPublic("Basic public-key"), null, "wrong scheme");
  // A prefix of the real key must not pass — the comparison is over
  // fixed-length hashes, so length never leaks and truncation never matches.
  assert.equal(authPublic("Bearer public-ke"), null, "truncated key");
});

test("an unauthorized attested provider is rejected even with the right key", () => {
  // policy/action-policy.yaml lists anthropic with authorized: false.
  const auth = resolveCredentialedAuth({
    envToken: "public-key",
    envTokenProvider: "anthropic",
    load: () => [],
  });
  assert.equal(
    auth("Bearer public-key"),
    null,
    "a correct key with an unauthorized provider must still be refused",
  );
});

// The tests above exercise resolveCredentialedAuth directly. This one goes
// through startMcpServer, which is what mcp-public.ts / mcp-catalog.ts
// actually call — it covers the `load` plumbing in the registry branch, so
// dropping the override there (falling back to the shared on-disk registry)
// is caught rather than passing on the unit tests alone.
test("startMcpServer refuses to bind a keyless server with an empty consumer source", async () => {
  let started: import("node:http").Server | undefined;
  let error: unknown;
  try {
    started = await startMcpServer({
      name: "test-public",
      transport: "http",
      httpHost: "0.0.0.0",
      httpPort: 0, // ephemeral — must never actually get bound
      auth: {
        kind: "registry",
        envToken: "",
        envTokenProvider: "openai_api",
        load: () => [],
      },
    });
  } catch (err) {
    error = err;
  }
  // Close first, assert second: if the fail-closed check regresses, the server
  // really is listening, and leaving it open would hang the test run instead
  // of failing it.
  if (started) await new Promise((r) => started!.close(r));
  assert.ok(
    error instanceof Error && /Refusing to start open/.test(error.message),
    "startMcpServer must reject before listen() when no key is configured",
  );
  assert.equal(started, undefined, "no socket may be bound without a key");
});

test("a non-loopback bind is refused when auth is open", () => {
  // The other half of the guarantee: if either server were ever reverted to
  // `auth: { kind: "open" }` while bound to 0.0.0.0, startup must abort.
  assert.throws(
    () => assertHttpAuthConfig("", "0.0.0.0"),
    /required when MCP_HTTP_HOST is not loopback/,
  );
  assert.doesNotThrow(() => assertHttpAuthConfig("", "127.0.0.1"));
});
