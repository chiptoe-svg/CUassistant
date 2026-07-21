import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { makeTcpReachability } from "../src/notifiers/reachability.ts";

test("check() resolves true against a listening socket", async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  const probe = makeTcpReachability("127.0.0.1", port, 2_000);
  assert.equal(await probe.check(), true);
  await new Promise<void>((r) => server.close(() => r()));
});

test("check() resolves false against a closed port", async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  const probe = makeTcpReachability("127.0.0.1", port, 2_000);
  assert.equal(await probe.check(), false);
});

test("check() resolves false rather than hanging on timeout", async () => {
  // 203.0.113.0/24 is TEST-NET-3 (RFC 5737) — reserved, never routed.
  const probe = makeTcpReachability("203.0.113.1", 443, 300);
  const started = Date.now();
  assert.equal(await probe.check(), false);
  assert.ok(Date.now() - started < 3_000, "must give up at the timeout");
});
