import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openApprovalStore } from "../src/approval/store.ts";
import type { PendingSend } from "../src/approval/types.ts";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approvals-"));
  return path.join(dir, "approvals.db");
}

function row(overrides: Partial<PendingSend> = {}): PendingSend {
  return {
    request_id: "req1",
    artifact: {
      account: "ms365",
      to: ["a@example.com"],
      cc: ["b@example.com"],
      subject: "s",
      body: "b",
    },
    content_hash: "hash1",
    proposer: "agent-1",
    status: "pending",
    created_at: 1_000,
    expires_at: 2_000,
    ...overrides,
  };
}

test("a persisted send round-trips through a reopened store", () => {
  const p = tmpDb();
  const s1 = openApprovalStore(p);
  s1.upsert(row());
  const s2 = openApprovalStore(p);
  const all = s2.loadAll();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], row());
});

test("upsert replaces rather than duplicating", () => {
  const s = openApprovalStore(tmpDb());
  s.upsert(row());
  s.upsert(row({ status: "sent", sent_message_id: "m1" }));
  const all = s.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "sent");
  assert.equal(all[0].sent_message_id, "m1");
});

test("optional fields survive as undefined, not null", () => {
  const s = openApprovalStore(tmpDb());
  s.upsert(row());
  const [r] = s.loadAll();
  assert.equal(r.sent_message_id, undefined);
  assert.equal(r.error, undefined);
  assert.equal(r.feedback, undefined);
});

test("submit times persist and filter by since", () => {
  const p = tmpDb();
  const s1 = openApprovalStore(p);
  s1.recordSubmitTime(1_000);
  s1.recordSubmitTime(5_000);
  const s2 = openApprovalStore(p);
  assert.deepEqual(s2.loadSubmitTimes(0), [1_000, 5_000]);
  assert.deepEqual(s2.loadSubmitTimes(2_000), [5_000]);
});

test("watchdog exit timestamp survives reopen", () => {
  const p = tmpDb();
  const s1 = openApprovalStore(p);
  assert.equal(s1.getLastWatchdogExit(), null);
  s1.recordWatchdogExit(42_000);
  const s2 = openApprovalStore(p);
  assert.equal(s2.getLastWatchdogExit(), 42_000);
});
