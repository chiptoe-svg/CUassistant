import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalGate } from "../src/approval/gate.ts";
import type {
  ApprovalChannel,
  GateConfig,
  PendingSend,
  SendArtifact,
  Sender,
  SentResult,
} from "../src/approval/types.ts";

function fakes() {
  let t = 1_000_000;
  const posted: PendingSend[] = [];
  const sent: SendArtifact[] = [];
  let throwOnPost = false;
  let throwOnSend = false;
  let ids = 0;
  const sender: Sender = {
    async send(a): Promise<SentResult> {
      if (throwOnSend) throw new Error("graph 500");
      sent.push(a);
      return { id: `m${sent.length}` };
    },
  };
  const channel: ApprovalChannel = {
    async post(req) {
      if (throwOnPost) throw new Error("telegram down");
      posted.push(req);
    },
  };
  return {
    sender,
    channel,
    clock: { now: () => t },
    idGen: { generate: () => `req${++ids}` },
    posted,
    sent,
    advance: (ms: number) => (t += ms),
    setThrowOnPost: (v: boolean) => (throwOnPost = v),
    setThrowOnSend: (v: boolean) => (throwOnSend = v),
  };
}

const cfg: GateConfig = {
  ttlMs: 3_600_000,
  maxOutstanding: 2,
  rateLimitPerHour: 3,
  internalDomains: ["clemson.edu"],
  authorizedUserId: "user-1",
};

const artifact: SendArtifact = {
  account: "gmail",
  to: ["x@clemson.edu"],
  subject: "s",
  body: "b",
};

test("submit returns pending, stores it, and posts to the channel", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const r = await gate.submit(artifact, "agent:test");
  assert.equal(r.status, "pending");
  assert.equal(r.request_id, "req1");
  assert.equal(f.posted.length, 1);
  assert.equal(gate.getStatus("req1")?.status, "pending");
});

test("submit fails closed when the channel can't reach the approver", async () => {
  const f = fakes();
  f.setThrowOnPost(true);
  const gate = new ApprovalGate(f, cfg);
  const r = await gate.submit(artifact, "agent:test");
  assert.equal(r.status, "failed");
  assert.equal(f.sent.length, 0);
});

test("submit refuses beyond the outstanding cap", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  await gate.submit(artifact, "a");
  await gate.submit(artifact, "a");
  await assert.rejects(() => gate.submit(artifact, "a"), /too_many_pending/);
});

test("submit refuses beyond the hourly rate limit", async () => {
  const f = fakes();
  const gate = new ApprovalGate({ ...f }, { ...cfg, maxOutstanding: 99 });
  await gate.submit(artifact, "a");
  await gate.submit(artifact, "a");
  await gate.submit(artifact, "a");
  await assert.rejects(() => gate.submit(artifact, "a"), /rate_limited/);
});
