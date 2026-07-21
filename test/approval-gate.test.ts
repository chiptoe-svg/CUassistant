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

test("approve from authorized user sends exactly the frozen artifact", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  await gate.approve(request_id, "user-1");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], artifact);
  assert.equal(gate.getStatus(request_id)?.status, "sent");
});

test("approve from an unknown user is ignored (no send)", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  await gate.approve(request_id, "intruder");
  assert.equal(f.sent.length, 0);
  assert.equal(gate.getStatus(request_id)?.status, "pending");
});

test("approve when the sender throws => failed, no retry", async () => {
  const f = fakes();
  f.setThrowOnSend(true);
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  await gate.approve(request_id, "user-1");
  const s = gate.getStatus(request_id);
  assert.equal(s?.status, "failed");
  assert.equal(f.sent.length, 0);
});

test("approve with an unknown/forged request_id is a no-op", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  await gate.submit(artifact, "a");
  await gate.approve("forged-id", "user-1");
  assert.equal(f.sent.length, 0);
  assert.equal(gate.getStatus("forged-id"), null);
});

test("a fresh gate has no pending requests (restart = fail-closed)", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  assert.equal(gate.getStatus("req1"), null);
});

test("double-approve sends at most once", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  await gate.approve(request_id, "user-1");
  await gate.approve(request_id, "user-1");
  assert.equal(f.sent.length, 1);
});

test("reject records feedback and never sends", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  gate.reject(request_id, "user-1", "too blunt");
  const s = gate.getStatus(request_id);
  assert.equal(s?.status, "rejected");
  assert.equal((s as { feedback?: string }).feedback, "too blunt");
  assert.equal(f.sent.length, 0);
});

test("reject from an unknown user is ignored", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  gate.reject(request_id, "intruder", "no");
  assert.equal(gate.getStatus(request_id)?.status, "pending");
});

test("expired requests cannot be approved", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  f.advance(cfg.ttlMs + 1);
  assert.equal(gate.getStatus(request_id)?.status, "expired");
  await gate.approve(request_id, "user-1");
  assert.equal(f.sent.length, 0);
  assert.equal(gate.getStatus(request_id)?.status, "expired");
});

test("rejecting an already-expired request yields expired, not rejected", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, cfg);
  const { request_id } = await gate.submit(artifact, "a");
  f.advance(cfg.ttlMs + 1);
  gate.reject(request_id, "user-1", "late");
  assert.equal(gate.getStatus(request_id)?.status, "expired");
});

test("rate limit is enforced before the outstanding cap when both would fire", async () => {
  const f = fakes();
  const gate = new ApprovalGate(f, {
    ...cfg,
    maxOutstanding: 3,
    rateLimitPerHour: 3,
  });
  await gate.submit(artifact, "a");
  await gate.submit(artifact, "a");
  await gate.submit(artifact, "a");
  await assert.rejects(() => gate.submit(artifact, "a"), /rate_limited/);
});

test("gate emits an audit intent row on submit and a terminal row on send", async () => {
  const events: Array<{ status: string }> = [];
  const f = fakes();
  const gate = new ApprovalGate(
    { ...f, audit: { record: (r) => events.push({ status: r.status }) } },
    cfg,
  );
  const { request_id } = await gate.submit(artifact, "a");
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "pending");
  await gate.approve(request_id, "user-1");
  assert.equal(events.length, 2);
  assert.equal(events[1].status, "sent");
});

test("unauthorized approve/reject taps are audited as security events", async () => {
  const security: Array<{ action: string; user_id: string }> = [];
  const f = fakes();
  const gate = new ApprovalGate(
    {
      ...f,
      audit: {
        record: () => {},
        recordSecurity: (e) =>
          security.push({ action: e.action, user_id: e.user_id }),
      },
    },
    cfg,
  );
  const { request_id } = await gate.submit(artifact, "a");
  await gate.approve(request_id, "intruder");
  gate.reject(request_id, "intruder", "no");
  assert.equal(f.sent.length, 0);
  assert.deepEqual(security, [
    { action: "approve", user_id: "intruder" },
    { action: "reject", user_id: "intruder" },
  ]);
  // The legitimate request is untouched by the rejected taps.
  assert.equal(gate.getStatus(request_id)?.status, "pending");
});

test("a throwing audit sink does not propagate out of approve/reject and both still complete", async () => {
  // Same failure class persist() was built to absorb, but via the audit
  // channel: appendDecision() does fs.appendFileSync on the same disk as
  // approvals.db, so ENOSPC/EROFS there must not escape approve()/reject()
  // and be mistaken for a transport error by the Telegram poll loop.
  const f = fakes();
  const gate = new ApprovalGate(
    {
      ...f,
      audit: {
        record: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      },
    },
    cfg,
  );
  const a = await gate.submit(artifact, "agent-1");
  const b = await gate.submit(artifact, "agent-1");

  await assert.doesNotReject(() => gate.approve(a.request_id, "user-1"));
  assert.doesNotThrow(() => gate.reject(b.request_id, "user-1", "no"));

  // The gate's own state transitions still completed despite the audit sink
  // throwing on every call.
  assert.equal(gate.getStatus(a.request_id)?.status, "sent");
  assert.equal(gate.getStatus(b.request_id)?.status, "rejected");
  assert.equal(f.sent.length, 1, "the send itself still happened");
});

test("a throwing recordSecurity does not propagate, and the loud failure log names the lost event", async () => {
  const f = fakes();
  const capture = { lines: [] as string[] };
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    capture.lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const gate = new ApprovalGate(
      {
        ...f,
        audit: {
          record: () => {},
          recordSecurity: () => {
            throw new Error("EROFS: read-only file system");
          },
        },
      },
      cfg,
    );
    const { request_id } = await gate.submit(artifact, "a");

    await assert.doesNotReject(() => gate.approve(request_id, "intruder"));
    assert.doesNotThrow(() => gate.reject(request_id, "intruder", "no"));
  } finally {
    process.stderr.write = orig;
  }

  assert.equal(f.sent.length, 0, "the intruder's tap still did nothing");
  assert.ok(
    capture.lines.some(
      (l) => l.includes("SECURITY AUDIT WRITE FAILED") && l.includes("EROFS"),
    ),
    "a lost security event must be logged loudly, naming what failed",
  );
});

test("gate audits a terminal row on reject and on expiry", async () => {
  const rejected: Array<{ status: string }> = [];
  const f1 = fakes();
  const g1 = new ApprovalGate(
    { ...f1, audit: { record: (r) => rejected.push({ status: r.status }) } },
    cfg,
  );
  const r1 = await g1.submit(artifact, "a");
  g1.reject(r1.request_id, "user-1", "no");
  assert.equal(rejected.at(-1)?.status, "rejected");

  const expired: Array<{ status: string }> = [];
  const f2 = fakes();
  const g2 = new ApprovalGate(
    { ...f2, audit: { record: (r) => expired.push({ status: r.status }) } },
    cfg,
  );
  await g2.submit(artifact, "a");
  f2.advance(cfg.ttlMs + 1);
  g2.getStatus("anything"); // triggers sweepExpired
  assert.equal(expired.at(-1)?.status, "expired");
});
