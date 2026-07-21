import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalGate } from "../src/approval/gate.ts";
import type {
  ApprovalChannel,
  ApprovalStore,
  GateConfig,
  PendingSend,
  SendArtifact,
  Sender,
  SentResult,
} from "../src/approval/types.ts";

/** In-memory ApprovalStore double that survives being handed to a new gate. */
function memStore(): ApprovalStore & { rows: Map<string, PendingSend> } {
  const rows = new Map<string, PendingSend>();
  const submits: number[] = [];
  let lastExit: number | null = null;
  return {
    rows,
    loadAll: () => [...rows.values()].map((r) => ({ ...r })),
    upsert: (req) => void rows.set(req.request_id, { ...req }),
    loadSubmitTimes: (sinceMs) => submits.filter((t) => t >= sinceMs),
    recordSubmitTime: (ts) => void submits.push(ts),
    getLastWatchdogExit: () => lastExit,
    recordWatchdogExit: (ts) => void (lastExit = ts),
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
  account: "ms365",
  to: ["someone@example.com"],
  subject: "hi",
  body: "body",
};

function ports(store: ApprovalStore, t = { now: 1_000_000 }) {
  const sent: SendArtifact[] = [];
  let ids = 0;
  const sender: Sender = {
    async send(a): Promise<SentResult> {
      sent.push(a);
      return { id: `m${sent.length}` };
    },
  };
  const channel: ApprovalChannel = { async post() {} };
  return {
    sent,
    ports: {
      sender,
      channel,
      clock: { now: () => t.now },
      idGen: { generate: () => `req${++ids}` },
      store,
    },
  };
}

test("submit persists the pending send through the store", async () => {
  const store = memStore();
  const { ports: p } = ports(store);
  const gate = new ApprovalGate(p, cfg);
  const { request_id } = await gate.submit(artifact, "agent-1");
  assert.equal(store.rows.get(request_id)?.status, "pending");
});

test("a fresh gate hydrates pending sends and can approve them", async () => {
  const store = memStore();
  const t = { now: 1_000_000 };
  const first = ports(store, t);
  const gate1 = new ApprovalGate(first.ports, cfg);
  const { request_id } = await gate1.submit(artifact, "agent-1");

  // Simulate a restart: brand-new gate, same store.
  const second = ports(store, t);
  const gate2 = new ApprovalGate(second.ports, cfg);
  assert.equal(gate2.getStatus(request_id)?.status, "pending");

  await gate2.approve(request_id, "user-1");
  assert.equal(gate2.getStatus(request_id)?.status, "sent");
  assert.equal(second.sent.length, 1);
  assert.equal(store.rows.get(request_id)?.status, "sent");
});

test("a send that expired while the process was down hydrates as expired", async () => {
  const store = memStore();
  const t = { now: 1_000_000 };
  const first = ports(store, t);
  const gate1 = new ApprovalGate(first.ports, cfg);
  const { request_id } = await gate1.submit(artifact, "agent-1");

  t.now += cfg.ttlMs + 1; // downtime longer than the TTL
  const second = ports(store, t);
  const gate2 = new ApprovalGate(second.ports, cfg);
  assert.equal(gate2.getStatus(request_id)?.status, "expired");

  await gate2.approve(request_id, "user-1");
  assert.equal(second.sent.length, 0, "an expired request must not send");
});

test("approve persists `sending` BEFORE awaiting the sender", async () => {
  // The crash window: if the process dies between "handed to the provider" and
  // "provider answered", the DB must NOT still say `pending` — a pending row
  // hydrates with live Approve buttons and a second tap re-sends the email.
  const store = memStore();
  let statusDuringSend: string | undefined;
  const sender: Sender = {
    async send(): Promise<SentResult> {
      statusDuringSend = store.rows.get("req1")?.status;
      return { id: "m1" };
    },
  };
  const gate = new ApprovalGate(
    {
      sender,
      channel: { async post() {} } as ApprovalChannel,
      clock: { now: () => 1_000_000 },
      idGen: { generate: () => "req1" },
      store,
    },
    cfg,
  );
  const { request_id } = await gate.submit(artifact, "agent-1");
  await gate.approve(request_id, "user-1");

  assert.equal(
    statusDuringSend,
    "sending",
    "the in-flight state must already be durable while the send is running",
  );
  assert.equal(gate.getStatus(request_id)?.status, "sent");
});

test("a send interrupted mid-flight hydrates to failed/unknown and never resends", async () => {
  const store = memStore();
  const t = { now: 1_000_000 };
  const first = ports(store, t);
  const gate1 = new ApprovalGate(first.ports, cfg);
  const { request_id } = await gate1.submit(artifact, "agent-1");

  // Simulate a crash inside approve()'s send window: the durable record is
  // `sending`, and delivery genuinely never got confirmed either way.
  const row = store.rows.get(request_id);
  assert.ok(row);
  store.rows.set(request_id, { ...row, status: "sending" });

  const second = ports(store, t);
  const gate2 = new ApprovalGate(second.ports, cfg);

  const view = gate2.getStatus(request_id);
  assert.equal(view?.status, "failed", "must not hydrate as pending or sent");
  assert.match(
    (view as { error?: string }).error ?? "",
    /unknown/i,
    "the error must say delivery status is unknown and needs manual verification",
  );
  assert.equal(
    second.sent.length,
    0,
    "hydration must never auto-resend an interrupted send",
  );
  assert.equal(store.rows.get(request_id)?.status, "failed");

  // And the resolution is terminal: a stale button tap cannot revive it.
  await gate2.approve(request_id, "user-1");
  assert.equal(second.sent.length, 0, "a second tap must not re-send");
  assert.equal(gate2.getStatus(request_id)?.status, "failed");
});

test("a gate with no store still works (store is optional)", async () => {
  const { ports: p } = ports(undefined as unknown as ApprovalStore);
  const noStore = { ...p, store: undefined };
  const gate = new ApprovalGate(noStore, cfg);
  const { status } = await gate.submit(artifact, "agent-1");
  assert.equal(status, "pending");
});

test("a store write failure does not propagate out of approve/reject", async () => {
  // A DB failure (disk full, SQLITE_BUSY) is a durability failure, not a
  // transport failure. If it escaped the gate it would land in the Telegram
  // poll loop's catch, inflate consecutiveErrors, and can drive a watchdog
  // restart that cannot possibly fix a broken disk.
  const store = memStore();
  const t = { now: 1_000_000 };
  const first = ports(store, t);
  const gate = new ApprovalGate(first.ports, cfg);
  const a = await gate.submit(artifact, "agent-1");
  const b = await gate.submit(artifact, "agent-1");

  const orig = store.upsert;
  store.upsert = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  try {
    await gate.approve(a.request_id, "user-1");
    gate.reject(b.request_id, "user-1", "no thanks");
  } finally {
    store.upsert = orig;
  }

  // In-memory state stays authoritative even though nothing was persisted.
  assert.equal(gate.getStatus(a.request_id)?.status, "sent");
  assert.equal(gate.getStatus(b.request_id)?.status, "rejected");
  assert.equal(first.sent.length, 1, "the send itself still happened");
});
