import assert from "node:assert/strict";
import test from "node:test";

import { verifyAuditLines } from "../src/audit-verify.ts";

test("clean append-only log verifies ok", () => {
  const lines = [
    JSON.stringify({ ts: "2026-06-01T00:00:00.000Z", decision: "a" }),
    JSON.stringify({ ts: "2026-06-02T00:00:00.000Z", decision: "b" }),
    "", // trailing blank tolerated
  ];
  const r = verifyAuditLines(lines);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.parseErrors.length, 0);
  assert.equal(r.tsRegressions, 0);
  assert.equal(r.firstTs, "2026-06-01T00:00:00.000Z");
  assert.equal(r.lastTs, "2026-06-02T00:00:00.000Z");
});

test("unparseable lines are flagged with their line number", () => {
  const lines = [
    JSON.stringify({ ts: "2026-06-01T00:00:00.000Z" }),
    "{ not json",
  ];
  const r = verifyAuditLines(lines);
  assert.equal(r.ok, false);
  assert.equal(r.parseErrors.length, 1);
  assert.equal(r.parseErrors[0].line, 2);
});

test("a backwards timestamp signals possible tampering/reordering", () => {
  const lines = [
    JSON.stringify({ ts: "2026-06-02T00:00:00.000Z" }),
    JSON.stringify({ ts: "2026-06-01T00:00:00.000Z" }), // earlier than prior
  ];
  const r = verifyAuditLines(lines);
  assert.equal(r.ok, false);
  assert.equal(r.tsRegressions, 1);
});
