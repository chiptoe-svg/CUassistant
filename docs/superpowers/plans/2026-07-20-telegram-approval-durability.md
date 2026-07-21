# Telegram Approval Durability + Poll-Loop Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist send-approval state to SQLite so restarts stop silently voiding pending approvals, and gate the poll-loop watchdog on a reachability probe so it restarts the process only when a restart can actually help.

**Architecture:** A new `ApprovalStore` port joins the existing injected `Ports` on `ApprovalGate`. `better-sqlite3` is synchronous, so the store hydrates in the constructor and writes through on every state transition without changing any method signature. The Telegram poll loop keeps its `process.exit(1)` watchdog but fires it only when a `node:net` TCP probe confirms the network is healthy *and* no exit has happened in the last hour.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `better-sqlite3@^12`, `node:test` + `node:assert/strict`, `tsx`, launchd.

**Spec:** `docs/superpowers/specs/2026-07-20-telegram-approval-durability-design.md`

## Global Constraints

- Imports use `.js` specifiers in `src/` (ESM), `.ts` specifiers in `test/`. Follow the file you are editing.
- The store MUST be synchronous. `getStatus()` and `reject()` are sync; an async store changes their signatures and ripples into every caller.
- `store` is **optional** on `Ports` (`store?: ApprovalStore`), matching the existing optional `audit?` port. Existing tests that construct a gate without a store must keep passing untouched.
- DB path: `state/approvals.db`, via `STATE_DIR` from `src/config.js`. `.gitignore:8` already covers `state/` — no gitignore change.
- `MAX_CONSECUTIVE_POLL_ERRORS` stays at `10`.
- Watchdog cooldown: `3_600_000` ms (1 hour).
- Backoff: base `3_000` ms, doubling, cap `60_000` ms, reset on any successful poll.
- Receiver-down warning threshold: `300_000` ms (5 min), repeated at most every `300_000` ms.
- Probe target: `api.telegram.org:443`, timeout `5_000` ms, via `node:net` — **never** `fetch`.
- Test command: `npm test`. Typecheck: `npm run typecheck`. Both must pass before each commit.

---

### Task 1: `ApprovalStore` port + gate persistence of pending sends

**Files:**
- Modify: `src/approval/types.ts` (append interface; extend nothing existing)
- Modify: `src/approval/gate.ts:26-41` (Ports + constructor), `:79` (submit), `:128-133` (approve), `:148-151` (reject), `:154-162` (sweepExpired)
- Test: `test/approval-store-port.test.ts` (create)

**Interfaces:**
- Consumes: `PendingSend`, `Ports` from `src/approval/types.ts`
- Produces: `ApprovalStore` interface with `loadAll(): PendingSend[]`, `upsert(req: PendingSend): void`, `loadSubmitTimes(sinceMs: number): number[]`, `recordSubmitTime(ts: number): void`, `getLastWatchdogExit(): number | null`, `recordWatchdogExit(ts: number): void`. Task 3 implements it against SQLite; Task 6 calls the watchdog methods.

- [ ] **Step 1: Write the failing test**

Create `test/approval-store-port.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="store"`
Expected: FAIL — `ApprovalStore` is not exported from `types.ts` (typecheck/import error).

- [ ] **Step 3: Add the `ApprovalStore` interface**

Append to `src/approval/types.ts`:

```ts
/**
 * Durable backing for gate state. Synchronous by contract: `getStatus()` and
 * `reject()` are sync, and an async store would change their signatures.
 */
export interface ApprovalStore {
  /** All persisted sends, for hydrating a fresh gate at construction. */
  loadAll(): PendingSend[];
  /** Insert or replace one send after any state transition. */
  upsert(req: PendingSend): void;
  /** Submit timestamps at or after `sinceMs`, for the hourly rate limiter. */
  loadSubmitTimes(sinceMs: number): number[];
  recordSubmitTime(ts: number): void;
  /** Epoch ms of the last watchdog-triggered exit, or null if never. */
  getLastWatchdogExit(): number | null;
  recordWatchdogExit(ts: number): void;
}
```

- [ ] **Step 4: Add the port and hydrate in the constructor**

In `src/approval/gate.ts`, add `ApprovalStore` to the type import from `./types.js`, then extend `Ports`:

```ts
interface Ports {
  sender: Sender;
  channel: ApprovalChannel;
  clock: Clock;
  idGen: IdGen;
  audit?: AuditSink;
  store?: ApprovalStore;
}
```

Replace the constructor:

```ts
  constructor(
    private readonly ports: Ports,
    private readonly config: GateConfig,
  ) {
    // Hydrate from the store so a restart doesn't void in-flight approvals.
    // better-sqlite3 is synchronous, so this is safe in a constructor.
    for (const req of this.ports.store?.loadAll() ?? []) {
      this.pending.set(req.request_id, req);
    }
    const now = this.ports.clock.now();
    this.submitTimes = this.ports.store?.loadSubmitTimes(now - HOUR_MS) ?? [];
    // Anything whose TTL elapsed while the process was down is expired now.
    this.sweepExpired();
  }
```

- [ ] **Step 5: Write through on every transition**

In `submit()`, immediately after `this.pending.set(request_id, req);`:

```ts
    this.ports.store?.upsert(req);
```

and immediately after `this.submitTimes.push(now);`:

```ts
    this.ports.store?.recordSubmitTime(now);
```

and inside the `catch` on channel post, after `req.error = ...` and before the audit call:

```ts
      this.ports.store?.upsert(req);
```

In `approve()` and `reject()`, add immediately before each existing `this.ports.audit?.record(req);`:

```ts
    this.ports.store?.upsert(req);
```

In `sweepExpired()`, inside the `if` block, before the audit call:

```ts
        this.ports.store?.upsert(req);
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — the four new tests plus the existing `approval-gate.test.ts` suite (which passes no store and must be unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/approval/types.ts src/approval/gate.ts test/approval-store-port.test.ts
git commit -m "feat(approval): ApprovalStore port so gate state survives restart"
```

---

### Task 2: SQLite implementation of `ApprovalStore`

**Files:**
- Create: `src/approval/store.ts`
- Test: `test/approval-store-sqlite.test.ts` (create)

**Interfaces:**
- Consumes: `ApprovalStore`, `PendingSend`, `SendStatus` from `src/approval/types.js`; `STATE_DIR` from `src/config.js`
- Produces: `openApprovalStore(dbPath: string): ApprovalStore` and `approvalDbPath(): string`. Task 7 calls both.

- [ ] **Step 1: Write the failing test**

Create `test/approval-store-sqlite.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="persisted send round-trips"`
Expected: FAIL — cannot find module `../src/approval/store.ts`.

- [ ] **Step 3: Implement the store**

Create `src/approval/store.ts`:

```ts
// src/approval/store.ts
// Durable backing for ApprovalGate state.
//
// Synchronous by contract (better-sqlite3): the gate's getStatus()/reject()
// are sync, so an async store would change their signatures.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { STATE_DIR } from "../config.js";
import type { ApprovalStore, PendingSend, SendStatus } from "./types.js";

export function approvalDbPath(): string {
  return path.join(STATE_DIR, "approvals.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pending_sends (
    request_id      TEXT PRIMARY KEY,
    artifact        TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    proposer        TEXT NOT NULL,
    status          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    sent_message_id TEXT,
    error           TEXT,
    feedback        TEXT
  );
  CREATE TABLE IF NOT EXISTS submit_times (
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submit_times_ts ON submit_times(ts);
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

interface SendRow {
  request_id: string;
  artifact: string;
  content_hash: string;
  proposer: string;
  status: string;
  created_at: number;
  expires_at: number;
  sent_message_id: string | null;
  error: string | null;
  feedback: string | null;
}

/** SQLite NULL reads back as null; PendingSend uses optional/undefined. */
function undef<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

export function openApprovalStore(dbPath: string): ApprovalStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const upsertStmt = db.prepare(`
    INSERT INTO pending_sends
      (request_id, artifact, content_hash, proposer, status,
       created_at, expires_at, sent_message_id, error, feedback)
    VALUES
      (@request_id, @artifact, @content_hash, @proposer, @status,
       @created_at, @expires_at, @sent_message_id, @error, @feedback)
    ON CONFLICT(request_id) DO UPDATE SET
      status          = excluded.status,
      sent_message_id = excluded.sent_message_id,
      error           = excluded.error,
      feedback        = excluded.feedback
  `);
  const allStmt = db.prepare(`SELECT * FROM pending_sends`);
  const submitInsert = db.prepare(`INSERT INTO submit_times (ts) VALUES (?)`);
  const submitSelect = db.prepare(
    `SELECT ts FROM submit_times WHERE ts >= ? ORDER BY ts`,
  );
  const submitPrune = db.prepare(`DELETE FROM submit_times WHERE ts < ?`);
  const metaGet = db.prepare(`SELECT value FROM meta WHERE key = ?`);
  const metaSet = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  return {
    loadAll(): PendingSend[] {
      return (allStmt.all() as SendRow[]).map((r) => ({
        request_id: r.request_id,
        artifact: JSON.parse(r.artifact),
        content_hash: r.content_hash,
        proposer: r.proposer,
        status: r.status as SendStatus,
        created_at: r.created_at,
        expires_at: r.expires_at,
        sent_message_id: undef(r.sent_message_id),
        error: undef(r.error),
        feedback: undef(r.feedback),
      }));
    },
    upsert(req: PendingSend): void {
      upsertStmt.run({
        request_id: req.request_id,
        artifact: JSON.stringify(req.artifact),
        content_hash: req.content_hash,
        proposer: req.proposer,
        status: req.status,
        created_at: req.created_at,
        expires_at: req.expires_at,
        sent_message_id: req.sent_message_id ?? null,
        error: req.error ?? null,
        feedback: req.feedback ?? null,
      });
    },
    loadSubmitTimes(sinceMs: number): number[] {
      return (submitSelect.all(sinceMs) as Array<{ ts: number }>).map(
        (r) => r.ts,
      );
    },
    recordSubmitTime(ts: number): void {
      submitInsert.run(ts);
      // The rate limiter only ever looks back one hour; keep a day of slack.
      submitPrune.run(ts - 86_400_000);
    },
    getLastWatchdogExit(): number | null {
      const row = metaGet.get("last_watchdog_exit") as
        | { value: string }
        | undefined;
      return row ? Number(row.value) : null;
    },
    recordWatchdogExit(ts: number): void {
      metaSet.run("last_watchdog_exit", String(ts));
    },
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — all five new tests.

- [ ] **Step 5: Commit**

```bash
git add src/approval/store.ts test/approval-store-sqlite.test.ts
git commit -m "feat(approval): SQLite-backed ApprovalStore at state/approvals.db"
```

---

### Task 3: TCP reachability probe

**Files:**
- Create: `src/notifiers/reachability.ts`
- Test: `test/reachability.test.ts` (create)

**Interfaces:**
- Consumes: `node:net`
- Produces: `Reachability` interface with `check(): Promise<boolean>`; `makeTcpReachability(host: string, port: number, timeoutMs: number): Reachability`; constants `TELEGRAM_PROBE_HOST = "api.telegram.org"`, `TELEGRAM_PROBE_PORT = 443`, `PROBE_TIMEOUT_MS = 5_000`. Task 5 consumes the interface; Task 6 wires the concrete probe.

- [ ] **Step 1: Write the failing test**

Create `test/reachability.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="check\\(\\)"`
Expected: FAIL — cannot find module `../src/notifiers/reachability.ts`.

- [ ] **Step 3: Implement the probe**

Create `src/notifiers/reachability.ts`:

```ts
// src/notifiers/reachability.ts
// Network reachability probe for the Telegram poll-loop watchdog.
//
// Deliberately uses a raw node:net socket, NOT fetch. If the probe went
// through fetch/undici, a wedged connection pool would fail the probe too, we
// would misread that as "network down", and the watchdog would never fire in
// exactly the case it exists for. A raw socket is an independent signal.
//
// A DNS-only probe is not sufficient: resolver caching can make it succeed
// during a real outage.
import net from "node:net";

export const TELEGRAM_PROBE_HOST = "api.telegram.org";
export const TELEGRAM_PROBE_PORT = 443;
export const PROBE_TIMEOUT_MS = 5_000;

export interface Reachability {
  /** True if a TCP connection can be established. Never throws. */
  check(): Promise<boolean>;
}

export function makeTcpReachability(
  host: string,
  port: number,
  timeoutMs: number,
): Reachability {
  return {
    check(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        socket.connect(port, host);
      });
    },
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — all three probe tests.

- [ ] **Step 5: Commit**

```bash
git add src/notifiers/reachability.ts test/reachability.test.ts
git commit -m "feat(telegram): node:net reachability probe for watchdog gating"
```

---

### Task 4: Watchdog predicate, backoff, and health-warning pure functions

**Files:**
- Modify: `src/notifiers/telegram-approval.ts:1-22` (constants and predicate)
- Modify: `test/telegram-poll-watchdog.test.ts` (extend)

**Interfaces:**
- Consumes: nothing
- Produces: `MAX_CONSECUTIVE_POLL_ERRORS = 10`, `WATCHDOG_COOLDOWN_MS = 3_600_000`, `BACKOFF_BASE_MS = 3_000`, `BACKOFF_CAP_MS = 60_000`, `RECEIVER_DOWN_WARN_MS = 300_000`; `shouldRestartAfterPollErrors(consecutiveErrors, networkHealthy, msSinceLastExit, threshold?, cooldownMs?): boolean`; `nextBackoffMs(consecutiveErrors): number`; `shouldWarnReceiverDown(msSinceLastSuccess, msSinceLastWarn): boolean`. Task 5 calls all three.

- [ ] **Step 1: Write the failing test**

Replace the body of `test/telegram-poll-watchdog.test.ts` (keep the file):

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_CONSECUTIVE_POLL_ERRORS,
  RECEIVER_DOWN_WARN_MS,
  WATCHDOG_COOLDOWN_MS,
  nextBackoffMs,
  shouldRestartAfterPollErrors,
  shouldWarnReceiverDown,
} from "../src/notifiers/telegram-approval.ts";

const N = MAX_CONSECUTIVE_POLL_ERRORS;

test("exits when errors hit the threshold, network is healthy, and cooled down", () => {
  assert.equal(shouldRestartAfterPollErrors(N, true, null), true);
  assert.equal(
    shouldRestartAfterPollErrors(N, true, WATCHDOG_COOLDOWN_MS + 1),
    true,
  );
});

test("does NOT exit when the network is unreachable — the churn case", () => {
  // This is the regression the 13-restart outage cluster produced.
  assert.equal(shouldRestartAfterPollErrors(N, false, null), false);
  assert.equal(shouldRestartAfterPollErrors(N * 10, false, null), false);
});

test("does NOT exit twice inside the cooldown window — the rate limit", () => {
  assert.equal(shouldRestartAfterPollErrors(N, true, 60_000), false);
  assert.equal(
    shouldRestartAfterPollErrors(N, true, WATCHDOG_COOLDOWN_MS - 1),
    false,
  );
});

test("does NOT exit below the error threshold", () => {
  assert.equal(shouldRestartAfterPollErrors(N - 1, true, null), false);
  assert.equal(shouldRestartAfterPollErrors(0, true, null), false);
});

test("backoff doubles from the base and saturates at the cap", () => {
  assert.equal(nextBackoffMs(1), BACKOFF_BASE_MS);
  assert.equal(nextBackoffMs(2), BACKOFF_BASE_MS * 2);
  assert.equal(nextBackoffMs(3), BACKOFF_BASE_MS * 4);
  assert.equal(nextBackoffMs(50), BACKOFF_CAP_MS);
  assert.ok(nextBackoffMs(0) >= BACKOFF_BASE_MS);
});

test("receiver-down warning fires when stale and not recently warned", () => {
  assert.equal(
    shouldWarnReceiverDown(RECEIVER_DOWN_WARN_MS + 1, RECEIVER_DOWN_WARN_MS + 1),
    true,
  );
  assert.equal(shouldWarnReceiverDown(1_000, 10 * RECEIVER_DOWN_WARN_MS), false);
  assert.equal(shouldWarnReceiverDown(RECEIVER_DOWN_WARN_MS + 1, 1_000), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="churn case"`
Expected: FAIL — `nextBackoffMs` / `shouldWarnReceiverDown` are not exported, and `shouldRestartAfterPollErrors` has the old two-arg signature.

- [ ] **Step 3: Implement the pure functions**

Replace lines 1-22 of `src/notifiers/telegram-approval.ts` (the constants and old predicate) with:

```ts
/**
 * Consecutive getUpdates failures required before the watchdog will consider
 * restarting. Reaching this alone is NOT sufficient — see
 * shouldRestartAfterPollErrors.
 */
export const MAX_CONSECUTIVE_POLL_ERRORS = 10;

/** Minimum gap between watchdog exits. Bounds churn even if the probe is wrong. */
export const WATCHDOG_COOLDOWN_MS = 3_600_000;

export const BACKOFF_BASE_MS = 3_000;
export const BACKOFF_CAP_MS = 60_000;

/** How stale lastSuccessfulPoll must be before we shout, and the repeat gap. */
export const RECEIVER_DOWN_WARN_MS = 300_000;

/**
 * Whether to exit so launchd restarts the process.
 *
 * A restart only helps when the network is fine and THIS process is broken.
 * During an outage a restart cannot help, and exiting on every outage is what
 * produced 13 restarts in 9 minutes. All three conditions must hold:
 *
 *   1. enough consecutive errors
 *   2. the network is verifiably reachable (probed OUTSIDE fetch)
 *   3. we have not already exited inside the cooldown window
 *
 * (3) is the safety net and does not depend on (2) being correct: worst case
 * is one restart per hour.
 *
 * @param msSinceLastExit null when no watchdog exit has ever been recorded.
 */
export function shouldRestartAfterPollErrors(
  consecutiveErrors: number,
  networkHealthy: boolean,
  msSinceLastExit: number | null,
  threshold: number = MAX_CONSECUTIVE_POLL_ERRORS,
  cooldownMs: number = WATCHDOG_COOLDOWN_MS,
): boolean {
  if (consecutiveErrors < threshold) return false;
  if (!networkHealthy) return false;
  return msSinceLastExit === null || msSinceLastExit >= cooldownMs;
}

/** Exponential backoff: base, doubling, capped. Caller resets on success. */
export function nextBackoffMs(consecutiveErrors: number): number {
  const n = Math.max(1, consecutiveErrors);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** Whether to emit the loud receiver-down line (stale, and not just warned). */
export function shouldWarnReceiverDown(
  msSinceLastSuccess: number,
  msSinceLastWarn: number,
): boolean {
  return (
    msSinceLastSuccess >= RECEIVER_DOWN_WARN_MS &&
    msSinceLastWarn >= RECEIVER_DOWN_WARN_MS
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- --test-name-pattern="watchdog|backoff|receiver-down|exit" && npm run typecheck`
Expected: The six predicate tests PASS. `npm run typecheck` FAILS at the `pollLoop` call site, which still passes the old two-arg form — Task 5 fixes it. Do not commit yet.

- [ ] **Step 5: Commit after Task 5**

This task is intentionally not independently committable: the predicate signature change breaks `pollLoop` until Task 5 rewires it. Proceed directly to Task 5 and commit them together.

---

### Task 5: Rewire the poll loop

**Files:**
- Modify: `src/notifiers/telegram-approval.ts` — `startTelegramApproval` signature and `pollLoop` body
- Test: covered by Task 4's tests plus a new one below

**Interfaces:**
- Consumes: `shouldRestartAfterPollErrors`, `nextBackoffMs`, `shouldWarnReceiverDown` (Task 4); `Reachability` (Task 3); `ApprovalStore` (Task 1)
- Produces: `startTelegramApproval(cfg, gate, deps?: { reachability?: Reachability; store?: ApprovalStore })` — Task 7 passes both.

- [ ] **Step 1: Write the failing test**

Append to `test/telegram-poll-watchdog.test.ts`:

```ts
test("the watchdog reads its cooldown from the store, surviving restarts", () => {
  // The last-exit timestamp lives in ApprovalStore, so the rate limit governs
  // the very restart it triggers. Simulated here: exit recorded 10 minutes ago.
  const now = 10_000_000;
  const lastExit = now - 600_000;
  assert.equal(
    shouldRestartAfterPollErrors(N, true, now - lastExit),
    false,
    "10 minutes since the last exit is inside the 1h cooldown",
  );
  const older = now - (WATCHDOG_COOLDOWN_MS + 1);
  assert.equal(shouldRestartAfterPollErrors(N, true, now - older), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="cooldown from the store"`
Expected: FAIL — typecheck errors from Task 4 still block the suite.

- [ ] **Step 3: Rewire `pollLoop`**

In `src/notifiers/telegram-approval.ts`, add imports:

```ts
import {
  PROBE_TIMEOUT_MS,
  TELEGRAM_PROBE_HOST,
  TELEGRAM_PROBE_PORT,
  makeTcpReachability,
  type Reachability,
} from "./reachability.js";
import type { ApprovalStore } from "../approval/types.js";
```

Replace the `catch` block and loop scaffolding in `pollLoop` so the signature and error path read:

```ts
async function pollLoop(
  api: (m: string) => string,
  cfg: TelegramConfig,
  gate: ApprovalGate,
  reachability: Reachability,
  store: ApprovalStore | undefined,
): Promise<void> {
  let offset = 0;
  let consecutiveErrors = 0;
  let lastSuccess = Date.now();
  let lastWarn = Date.now();
  for (;;) {
    try {
      const r = await fetch(api("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: 25,
          allowed_updates: ["callback_query"],
        }),
        // A hung connection is dropped and retried on a fresh socket rather
        // than wedging the loop. 25s long-poll + 10s slack.
        signal: AbortSignal.timeout(35_000),
      });
      // ... existing body handling is unchanged ...
      consecutiveErrors = 0;
      lastSuccess = Date.now();
      // ... existing callback_query handling is unchanged ...
    } catch (e) {
      consecutiveErrors++;
      const now = Date.now();
      process.stderr.write(
        `[telegram-approval] poll error (${consecutiveErrors}): ${String(e)}\n`,
      );

      if (shouldWarnReceiverDown(now - lastSuccess, now - lastWarn)) {
        lastWarn = now;
        const mins = Math.round((now - lastSuccess) / 60_000);
        process.stderr.write(
          `[telegram-approval] RECEIVER DOWN for ${mins}m — ` +
            `approvals cannot be actioned\n`,
        );
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        // Probe OUTSIDE fetch. If this said "unreachable" because fetch is
        // wedged, the watchdog would never fire in the case it exists for.
        const healthy = await reachability.check();
        const lastExit = store?.getLastWatchdogExit() ?? null;
        const since = lastExit === null ? null : now - lastExit;
        if (shouldRestartAfterPollErrors(consecutiveErrors, healthy, since)) {
          process.stderr.write(
            `[telegram-approval] ${consecutiveErrors} consecutive poll errors ` +
              `with the network reachable — exiting so launchd restarts the ` +
              `process (clears a stuck fetch state).\n`,
          );
          store?.recordWatchdogExit(now);
          process.exit(1);
        }
        if (!healthy) {
          process.stderr.write(
            `[telegram-approval] network unreachable — NOT restarting ` +
              `(a restart cannot fix an outage); backing off\n`,
          );
        }
      }

      await new Promise((res) => setTimeout(res, nextBackoffMs(consecutiveErrors)));
    }
  }
}
```

Then update `startTelegramApproval` to accept and forward the deps:

```ts
export function startTelegramApproval(
  cfg: TelegramConfig,
  gate: ApprovalGate,
  deps: { reachability?: Reachability; store?: ApprovalStore } = {},
): ApprovalChannel {
  const reachability =
    deps.reachability ??
    makeTcpReachability(
      TELEGRAM_PROBE_HOST,
      TELEGRAM_PROBE_PORT,
      PROBE_TIMEOUT_MS,
    );
  // ... existing channel construction unchanged ...
  void pollLoop(api, cfg, gate, reachability, deps.store);
  // ... existing return unchanged ...
}
```

> Preserve every existing line inside the `try` block (body parsing, `offset`
> advance, `gate.approve` / `gate.reject`, `answerCallbackQuery`,
> `editMessageText`). Only the `signal`, the two success-path assignments, and
> the whole `catch` block change.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — full suite green, no remaining references to the old two-arg predicate.

- [ ] **Step 5: Commit Tasks 4 and 5 together**

```bash
git add src/notifiers/telegram-approval.ts test/telegram-poll-watchdog.test.ts
git commit -m "fix(telegram): gate watchdog exit on reachability probe + hourly cooldown

The exit was never the defect — exiting during an outage was, where a
restart cannot help. Probe via node:net (not fetch, which may be the
wedged layer), require the network to be verifiably healthy, and rate
limit exits to one per hour using a timestamp in ApprovalStore so the
limit survives the restart it governs. Also: exponential backoff and an
abort timeout on getUpdates."
```

---

### Task 6: Wire the store into the server

**Files:**
- Modify: `src/mcp-server.ts:57-110` (imports, gate construction, `startTelegramApproval` call)

**Interfaces:**
- Consumes: `openApprovalStore`, `approvalDbPath` (Task 2); `startTelegramApproval` deps param (Task 5)
- Produces: nothing downstream

- [ ] **Step 1: Add the import**

In `src/mcp-server.ts`, alongside the existing `makeGateAuditSink` import:

```ts
import { approvalDbPath, openApprovalStore } from "./approval/store.js";
```

- [ ] **Step 2: Construct the store and pass it to both consumers**

Before the `new ApprovalGate(...)` call:

```ts
  const approvalStore = openApprovalStore(approvalDbPath());
```

Add `store: approvalStore,` to the `Ports` object literal (next to `audit: makeGateAuditSink(),`), and pass it to the channel:

```ts
  const channel = startTelegramApproval(
    {
      botToken: TELEGRAM_BOT_TOKEN,
      authorizedUserId: TELEGRAM_APPROVER_USER_ID,
      // ... existing fields unchanged ...
    },
    gate,
    { store: approvalStore },
  );
```

- [ ] **Step 3: Verify the wiring compiles and the suite is green**

Run: `npm test && npm run typecheck`
Expected: PASS.

> **Note:** an earlier draft ran `npm run mcp:http` here to confirm the DB is
> created. Port 8765 is held by the live `com.cuassistant.mcp-http` daemon, so a
> second instance fails with `EADDRINUSE`. DB creation is verified in Task 7
> instead, after the daemon restart — a more realistic exercise anyway.

- [ ] **Step 4: Confirm it is not tracked by git**

Run: `git check-ignore -v state/approvals.db`
Expected: `.gitignore:8:state/	state/approvals.db`

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat(approval): wire SQLite ApprovalStore into the credentialed server"
```

---

### Task 7: Deploy — restart the daemon and verify

**Files:** none (operational)

Per `CLAUDE.md`, MCP servers load their tool registry and policy once at process
start. This change is not shipped until the daemon restarts. No tools are added
or renamed here, so the tool list should be **identical** before and after — the
probe confirms the restart took, not a registry change.

- [ ] **Step 1: Capture the pre-restart tool count**

```bash
launchctl list | grep com.cuassistant.mcp-http
```

Expected: a PID and last-status `0`. Note the PID.

- [ ] **Step 2: Restart the credentialed server**

```bash
launchctl kickstart -k gui/$(id -u)/com.cuassistant.mcp-http
```

- [ ] **Step 3: Verify it came back with a new PID**

```bash
launchctl list | grep com.cuassistant.mcp-http
```

Expected: a **different** PID, last-status `0`.

- [ ] **Step 4: Verify the server is serving and still auth-gated**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expected: `401` — unauthenticated requests are rejected, which is correct
behavior and confirms the server is up and enforcing auth.

- [ ] **Step 5: Verify the store is live and the loop is quiet**

```bash
ls -la state/approvals.db
tail -20 ~/Library/Logs/cuassistant.mcp.err.log
```

Expected: the DB exists; the log tail shows the startup banner with no
`poll error` lines following it. The `mcp-public-bridge` forwarder does not need
restarting.

---

## Notes for the implementer

- **Do not** add `undici` as a dependency. The spec rejects it explicitly: it is
  not resolvable here, and whether a userland undici's global dispatcher affects
  Node's built-in `fetch` is version-dependent and unverified.
- **Do not** split the poll loop into a separate process. Out of scope; the
  bounded residual risk is accepted and documented in the spec.
- The `store` port stays optional so existing gate tests keep constructing gates
  without one. If you find yourself editing `test/approval-gate.test.ts`, stop —
  that is a signal the port was made required by mistake.
- The probe must never be routed through `fetch`. This is the single assumption
  the whole design rests on: if `fetch` and raw TCP fail together, the probe
  reads "outage" and the watchdog stays quiet.
