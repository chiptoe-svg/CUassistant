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

test("a gate with no store still works (store is optional)", async () => {
  const { ports: p } = ports(undefined as unknown as ApprovalStore);
  const noStore = { ...p, store: undefined };
  const gate = new ApprovalGate(noStore, cfg);
  const { status } = await gate.submit(artifact, "agent-1");
  assert.equal(status, "pending");
});
