# Send-Mail Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents request that an email be sent, with the host freezing the message and requiring an out-of-band Telegram tap from the user before anything is actually sent.

**Architecture:** A deterministic host-side `ApprovalGate` state machine with four injected ports (sender, approval channel, clock, id-gen). Agents call two MCP tools (`request_send_mail`, `get_send_status`); the gate posts to Telegram, and on the user's ✅ tap it executes the send via an account-aware sender (Gmail→`gws` in v1, MS365→Graph later). Fail-closed everywhere.

**Tech Stack:** TypeScript/Node ESM, `node:test` + `node:assert/strict`, `tsx`, MCP SDK, existing CUassistant `mcp-tools`/notifier/policy patterns.

**Spec:** `docs/superpowers/specs/2026-06-04-send-mail-approval-gate-design.md`

**Scope (v1):** gate core + Gmail/`gws` sender + Telegram channel + MCP tools + policy/wiring. The MS365 Graph sender is a clearly-marked disabled backend (added in a follow-on once `Mail.Send` consent lands). Persistence, autonomous proposer, and the general agent↔Telegram channel are out of scope.

**Policy note:** Per the codebase's binary exposure model (`isMcpOperationExposed` requires `approval: "none"`), the `mail.send_with_approval` policy action uses `approval: none` to mean "the agent may *submit* a request." The human-required control is the runtime Telegram gate, recorded with a `requires_runtime_human_approval` constraint for reviewability.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/approval/types.ts` | Shared types + port interfaces (`SendArtifact`, `PendingSend`, `Sender`, `ApprovalChannel`, `Clock`, `IdGen`, `GateConfig`). |
| `src/approval/freeze.ts` | Pure helpers: `hashArtifact`, `externalRecipients`. |
| `src/approval/gate.ts` | `ApprovalGate` state machine (submit/getStatus/approve/reject/sweep). No I/O; ports injected. |
| `src/approval/sender.ts` | Account-aware `Sender` dispatcher: `gmail`→gws, `ms365`→disabled error (v1). |
| `src/approval/gws-sender.ts` | Real Gmail send via `gws`. |
| `src/notifiers/telegram-approval.ts` | Telegram `ApprovalChannel`: post message + receiver loop mapping taps→gate. |
| `src/mcp-tools/mail-send.ts` | MCP tools `request_send_mail` + `get_send_status`, wired to a gate singleton. |
| `src/mcp-tools/permissions.ts` | +1 `MCP_ALLOWED_OPERATIONS` entry. |
| `policy/action-policy.yaml` | +1 action `mail.send_with_approval`. |
| `src/mcp-server.ts` | Composition root: build gate with real ports; register the approval channel. |
| `test/approval-*.test.ts` | Unit tests for freeze + gate state machine + sender dispatch. |

---

## Task 1: Core types and pure helpers

**Files:**
- Create: `src/approval/types.ts`
- Create: `src/approval/freeze.ts`
- Test: `test/approval-freeze.test.ts`

- [ ] **Step 1: Write `src/approval/types.ts`**

```ts
export type SendAccount = "ms365" | "gmail";
export type SendStatus = "pending" | "sent" | "rejected" | "expired" | "failed";

export interface SendArtifact {
  account: SendAccount;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface PendingSend {
  request_id: string;
  artifact: SendArtifact;
  content_hash: string;
  proposer: string;
  status: SendStatus;
  feedback?: string;
  created_at: number;
  expires_at: number;
  sent_message_id?: string;
  error?: string;
}

export interface SentResult {
  id: string;
}

/** Sends a frozen artifact. Throws on failure. */
export interface Sender {
  send(artifact: SendArtifact): Promise<SentResult>;
}

/** Posts an approval request out-of-band. Throws if the approver can't be reached. */
export interface ApprovalChannel {
  post(req: PendingSend, externalRecipients: string[]): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface IdGen {
  generate(): string;
}

export interface GateConfig {
  ttlMs: number;
  maxOutstanding: number;
  rateLimitPerHour: number;
  internalDomains: string[];
  authorizedUserId: string;
}
```

- [ ] **Step 2: Write the failing test** in `test/approval-freeze.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { hashArtifact, externalRecipients } from "../src/approval/freeze.ts";
import type { SendArtifact } from "../src/approval/types.ts";

const base: SendArtifact = {
  account: "gmail",
  to: ["alice@clemson.edu"],
  subject: "Hi",
  body: "Hello",
};

test("hashArtifact is stable for identical artifacts and changes with content", () => {
  assert.equal(hashArtifact(base), hashArtifact({ ...base }));
  assert.notEqual(hashArtifact(base), hashArtifact({ ...base, body: "Changed" }));
});

test("externalRecipients flags only non-internal domains", () => {
  const a: SendArtifact = {
    ...base,
    to: ["alice@clemson.edu", "bob@gmail.com"],
    cc: ["carol@CLEMSON.EDU", "dave@evil.com"],
  };
  assert.deepEqual(externalRecipients(a, ["clemson.edu"]).sort(), [
    "bob@gmail.com",
    "dave@evil.com",
  ]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/approval-freeze.test.ts`
Expected: FAIL — `Cannot find module '../src/approval/freeze.ts'`.

- [ ] **Step 4: Write `src/approval/freeze.ts`**

```ts
import { createHash } from "crypto";

import type { SendArtifact } from "./types.js";

export function hashArtifact(a: SendArtifact): string {
  const canonical = JSON.stringify([
    a.account,
    a.to,
    a.cc ?? [],
    a.subject,
    a.body,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function externalRecipients(
  a: SendArtifact,
  internalDomains: string[],
): string[] {
  const internal = internalDomains.map((d) => d.toLowerCase());
  const all = [...a.to, ...(a.cc ?? [])];
  return all.filter((addr) => {
    const domain = addr.split("@")[1]?.toLowerCase() ?? "";
    return !internal.includes(domain);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/approval-freeze.test.ts` and `npm run typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/approval/types.ts src/approval/freeze.ts test/approval-freeze.test.ts
git commit -m "feat(approval): core types + freeze/external-recipient helpers"
```

---

## Task 2: ApprovalGate.submit (caps, rate limit, notify)

**Files:**
- Create: `src/approval/gate.ts`
- Test: `test/approval-gate.test.ts`

- [ ] **Step 1: Write the failing test** in `test/approval-gate.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/approval-gate.test.ts`
Expected: FAIL — `Cannot find module '../src/approval/gate.ts'`.

- [ ] **Step 3: Write `src/approval/gate.ts`**

```ts
import { hashArtifact, externalRecipients } from "./freeze.js";
import type {
  ApprovalChannel,
  Clock,
  GateConfig,
  IdGen,
  PendingSend,
  SendArtifact,
  Sender,
  SendStatus,
} from "./types.js";

export interface SubmitResult {
  request_id: string;
  status: SendStatus;
}

export type StatusView =
  | { status: "pending" | "expired" }
  | { status: "sent"; sent_message_id?: string }
  | { status: "rejected"; feedback?: string }
  | { status: "failed"; error?: string };

interface Ports {
  sender: Sender;
  channel: ApprovalChannel;
  clock: Clock;
  idGen: IdGen;
}

const HOUR_MS = 3_600_000;

export class ApprovalGate {
  private readonly pending = new Map<string, PendingSend>();
  private submitTimes: number[] = [];

  constructor(
    private readonly ports: Ports,
    private readonly config: GateConfig,
  ) {}

  // The gate posts to the channel and the channel's receiver calls back into
  // the gate — a cycle. Construct the gate with a no-op channel, build the real
  // channel with the gate, then inject it here. `ports.channel` is a mutable
  // field, so this compiles even though `ports` itself is readonly.
  setChannel(channel: ApprovalChannel): void {
    this.ports.channel = channel;
  }

  async submit(artifact: SendArtifact, proposer: string): Promise<SubmitResult> {
    this.sweepExpired();
    const now = this.ports.clock.now();

    this.submitTimes = this.submitTimes.filter((t) => now - t < HOUR_MS);
    if (this.submitTimes.length >= this.config.rateLimitPerHour) {
      throw new Error("rate_limited");
    }
    const outstanding = [...this.pending.values()].filter(
      (p) => p.status === "pending",
    ).length;
    if (outstanding >= this.config.maxOutstanding) {
      throw new Error("too_many_pending");
    }

    const request_id = this.ports.idGen.generate();
    const req: PendingSend = {
      request_id,
      artifact,
      content_hash: hashArtifact(artifact),
      proposer,
      status: "pending",
      created_at: now,
      expires_at: now + this.config.ttlMs,
    };
    this.pending.set(request_id, req);
    this.submitTimes.push(now);

    const externals = externalRecipients(artifact, this.config.internalDomains);
    try {
      await this.ports.channel.post(req, externals);
    } catch (e) {
      req.status = "failed";
      req.error = `notify_failed: ${String(e)}`;
      return { request_id, status: "failed" };
    }
    return { request_id, status: "pending" };
  }

  getStatus(request_id: string): StatusView | null {
    this.sweepExpired();
    const req = this.pending.get(request_id);
    if (!req) return null;
    switch (req.status) {
      case "sent":
        return { status: "sent", sent_message_id: req.sent_message_id };
      case "rejected":
        return { status: "rejected", feedback: req.feedback };
      case "failed":
        return { status: "failed", error: req.error };
      default:
        return { status: req.status };
    }
  }

  async approve(request_id: string, userId: string): Promise<void> {
    this.sweepExpired();
    if (userId !== this.config.authorizedUserId) return;
    const req = this.pending.get(request_id);
    if (!req || req.status !== "pending") return;
    try {
      const res = await this.ports.sender.send(req.artifact);
      req.status = "sent";
      req.sent_message_id = res.id;
    } catch (e) {
      req.status = "failed";
      req.error = String(e);
    }
  }

  reject(request_id: string, userId: string, feedback?: string): void {
    if (userId !== this.config.authorizedUserId) return;
    const req = this.pending.get(request_id);
    if (!req || req.status !== "pending") return;
    req.status = "rejected";
    if (feedback) req.feedback = feedback;
  }

  private sweepExpired(): void {
    const now = this.ports.clock.now();
    for (const req of this.pending.values()) {
      if (req.status === "pending" && now >= req.expires_at) {
        req.status = "expired";
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/approval-gate.test.ts` and `npm run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/approval/gate.ts test/approval-gate.test.ts
git commit -m "feat(approval): gate.submit with caps, rate limit, fail-closed notify"
```

---

## Task 3: approve / reject / expiry transitions

**Files:**
- Modify: `test/approval-gate.test.ts` (append tests)

- [ ] **Step 1: Append the failing tests** to `test/approval-gate.test.ts`

```ts
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
```

- [ ] **Step 2: Run tests**

Run: `npm test -- test/approval-gate.test.ts`
Expected: PASS — all new transitions covered (the gate from Task 2 already implements them).

- [ ] **Step 3: Commit**

```bash
git add test/approval-gate.test.ts
git commit -m "test(approval): cover approve/reject/expiry/idempotency transitions"
```

---

## Task 4: Account-aware sender dispatcher

**Files:**
- Create: `src/approval/sender.ts`
- Test: `test/approval-sender.test.ts`

- [ ] **Step 1: Write the failing test** in `test/approval-sender.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { makeSender } from "../src/approval/sender.ts";
import type { SendArtifact } from "../src/approval/types.ts";

const gmail: SendArtifact = { account: "gmail", to: ["a@x.com"], subject: "s", body: "b" };
const ms365: SendArtifact = { account: "ms365", to: ["a@x.com"], subject: "s", body: "b" };

test("dispatches gmail to the gws backend", async () => {
  const calls: SendArtifact[] = [];
  const sender = makeSender({
    gmail: async (a) => {
      calls.push(a);
      return { id: "g1" };
    },
  });
  const r = await sender.send(gmail);
  assert.equal(r.id, "g1");
  assert.equal(calls.length, 1);
});

test("ms365 send is disabled in v1 and throws a clear error", async () => {
  const sender = makeSender({ gmail: async () => ({ id: "g1" }) });
  await assert.rejects(() => sender.send(ms365), /ms365 send not enabled/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/approval-sender.test.ts`
Expected: FAIL — `Cannot find module '../src/approval/sender.ts'`.

- [ ] **Step 3: Write `src/approval/sender.ts`**

```ts
import type { SendArtifact, Sender, SentResult } from "./types.js";

export interface Backends {
  gmail: (a: SendArtifact) => Promise<SentResult>;
  ms365?: (a: SendArtifact) => Promise<SentResult>;
}

/** Routes a frozen artifact to the backend for its account. */
export function makeSender(backends: Backends): Sender {
  return {
    async send(a: SendArtifact): Promise<SentResult> {
      if (a.account === "gmail") return backends.gmail(a);
      if (a.account === "ms365") {
        if (!backends.ms365) {
          throw new Error(
            "ms365 send not enabled (pending Mail.Send consent on the GCassistant app)",
          );
        }
        return backends.ms365(a);
      }
      throw new Error(`unknown account: ${String(a.account)}`);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/approval-sender.test.ts` and `npm run typecheck`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approval/sender.ts test/approval-sender.test.ts
git commit -m "feat(approval): account-aware sender dispatch (gmail enabled, ms365 disabled in v1)"
```

---

## Task 5: Gmail send backend via `gws`

**Files:**
- Create: `src/approval/gws-sender.ts`

> Integration code that shells out to `gws`; not unit-tested (no network in CI). Mirrors the env-hardening already used in `src/gmail.ts` (`buildChildEnv`).

- [ ] **Step 1: Write `src/approval/gws-sender.ts`**

```ts
// Gmail send backend via the `gws` CLI. The actual send is host-invoked only —
// the agent never reaches this. Uses buildChildEnv so the subprocess does not
// inherit host secrets (see src/child-env.ts).
import { execFileSync } from "child_process";

import { buildChildEnv } from "../child-env.js";
import { GWS_BIN } from "../config.js";
import type { SendArtifact, SentResult } from "./types.js";

export async function gwsSend(a: SendArtifact): Promise<SentResult> {
  if (!GWS_BIN) throw new Error("gws not configured (GWS_BIN unset)");
  const params = {
    to: a.to.join(","),
    cc: (a.cc ?? []).join(","),
    subject: a.subject,
    body: a.body,
  };
  const out = execFileSync(
    GWS_BIN,
    ["gmail", "messages", "send", "--params", JSON.stringify(params), "--format", "json"],
    {
      encoding: "utf-8",
      env: buildChildEnv({ GWS_CREDENTIAL_STORE: "plaintext" }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(out) as { id?: string };
  return { id: parsed.id ?? "sent" };
}
```

> Note: confirm the exact `gws gmail messages send` argument shape against the installed `gws --help` during execution; adjust `params` keys if the CLI differs. The `gws` auth must include the `gmail.send` scope (re-auth if the token is expired).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/approval/gws-sender.ts
git commit -m "feat(approval): Gmail send backend via gws (hardened child env)"
```

---

## Task 6: Telegram approval channel (post + receiver)

**Files:**
- Create: `src/notifiers/telegram-approval.ts`
- Test: `test/telegram-approval-format.test.ts`

> Splits cleanly into a **pure message formatter** (unit-tested) and an **I/O shell** (Bot API calls; integration, not unit-tested).

- [ ] **Step 1: Write the failing test** in `test/telegram-approval-format.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { formatApprovalMessage } from "../src/notifiers/telegram-approval.ts";
import type { PendingSend } from "../src/approval/types.ts";

const req: PendingSend = {
  request_id: "req1",
  artifact: {
    account: "gmail",
    to: ["a@clemson.edu", "b@gmail.com"],
    subject: "Meeting",
    body: "Body text",
  },
  content_hash: "abc",
  proposer: "agent:x",
  status: "pending",
  created_at: 0,
  expires_at: 0,
};

test("approval message includes recipients, subject, body, and flags externals", () => {
  const msg = formatApprovalMessage(req, ["b@gmail.com"]);
  assert.match(msg, /a@clemson\.edu/);
  assert.match(msg, /Meeting/);
  assert.match(msg, /Body text/);
  assert.match(msg, /⚠️.*b@gmail\.com/s);
});

test("long bodies are truncated with a marker", () => {
  const long = { ...req, artifact: { ...req.artifact, body: "x".repeat(5000) } };
  const msg = formatApprovalMessage(long, []);
  assert.match(msg, /truncated, 5000 chars total/);
  assert.ok(msg.length < 4096);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/telegram-approval-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/notifiers/telegram-approval.ts`**

```ts
import { ApprovalGate } from "../approval/gate.js";
import type { ApprovalChannel, PendingSend } from "../approval/types.js";

const BODY_LIMIT = 1500;

export function formatApprovalMessage(
  req: PendingSend,
  externals: string[],
): string {
  const a = req.artifact;
  const lines: string[] = [];
  lines.push(`✉️ Approve send (${a.account})  [${req.request_id}]`);
  lines.push(`To: ${a.to.join(", ")}`);
  if (a.cc && a.cc.length) lines.push(`Cc: ${a.cc.join(", ")}`);
  if (externals.length) lines.push(`⚠️ External: ${externals.join(", ")}`);
  lines.push(`Subject: ${a.subject}`);
  lines.push("");
  const body =
    a.body.length > BODY_LIMIT
      ? `${a.body.slice(0, BODY_LIMIT)}\n…(truncated, ${a.body.length} chars total)`
      : a.body;
  lines.push(body);
  return lines.join("\n");
}

// --- I/O shell (integration; constructed only when a bot token is configured) ---

interface TelegramConfig {
  botToken: string;
  authorizedUserId: string;
  internalDomains: string[];
}

/**
 * Builds the ApprovalChannel and starts a long-poll receiver that routes
 * inline-button taps to gate.approve / gate.reject. Only host code holds the
 * bot token; the agent has no path here.
 */
export function startTelegramApproval(
  cfg: TelegramConfig,
  gate: ApprovalGate,
): ApprovalChannel {
  const api = (method: string) =>
    `https://api.telegram.org/bot${cfg.botToken}/${method}`;

  const channel: ApprovalChannel = {
    async post(req, externals) {
      const text = formatApprovalMessage(req, externals);
      const reply_markup = {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `ok:${req.request_id}` },
            { text: "❌ Reject", callback_data: `no:${req.request_id}` },
          ],
        ],
      };
      const r = await fetch(api("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.authorizedUserId,
          text,
          reply_markup,
        }),
      });
      if (!r.ok) throw new Error(`telegram sendMessage ${r.status}`);
    },
  };

  void pollLoop(api, cfg, gate);
  return channel;
}

async function pollLoop(
  api: (m: string) => string,
  cfg: TelegramConfig,
  gate: ApprovalGate,
): Promise<void> {
  let offset = 0;
  for (;;) {
    try {
      const r = await fetch(api("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["callback_query"] }),
      });
      const data = (await r.json()) as {
        result?: Array<{
          update_id: number;
          callback_query?: {
            id: string;
            from: { id: number };
            data?: string;
          };
        }>;
      };
      for (const u of data.result ?? []) {
        offset = u.update_id + 1;
        const cq = u.callback_query;
        if (!cq?.data) continue;
        const userId = String(cq.from.id);
        const [verb, requestId] = cq.data.split(":");
        if (verb === "ok") await gate.approve(requestId, userId);
        else if (verb === "no") gate.reject(requestId, userId);
        await fetch(api("answerCallbackQuery"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      }
    } catch (e) {
      process.stderr.write(`[telegram-approval] poll error: ${String(e)}\n`);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- test/telegram-approval-format.test.ts` and `npm run typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/notifiers/telegram-approval.ts test/telegram-approval-format.test.ts
git commit -m "feat(approval): Telegram approval channel (formatter + long-poll receiver)"
```

---

## Task 7: Config knobs for the gate

**Files:**
- Modify: `src/config.ts` (append exports)

- [ ] **Step 1: Append to `src/config.ts`**

```ts
// --- Send-mail approval gate ---
export const SEND_APPROVAL_TTL_MS = Number(
  process.env.SEND_APPROVAL_TTL_MS || 3_600_000,
);
export const SEND_APPROVAL_MAX_OUTSTANDING = Number(
  process.env.SEND_APPROVAL_MAX_OUTSTANDING || 5,
);
export const SEND_APPROVAL_RATE_PER_HOUR = Number(
  process.env.SEND_APPROVAL_RATE_PER_HOUR || 10,
);
export const SEND_INTERNAL_DOMAINS = (
  process.env.SEND_INTERNAL_DOMAINS || "clemson.edu"
)
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_APPROVER_USER_ID =
  process.env.TELEGRAM_APPROVER_USER_ID || "";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(approval): config knobs (TTL, caps, internal domains, telegram)"
```

---

## Task 8: Policy action + MCP operation entry

**Files:**
- Modify: `policy/action-policy.yaml` (add an action)
- Modify: `src/mcp-tools/permissions.ts` (add an operation entry)

- [ ] **Step 1: Add the action to `policy/action-policy.yaml`** (under `actions:`)

```yaml
  - id: mail.send_with_approval
    surface: mail
    risk: high
    reversibility: irreversible
    approval: none          # "none" = the agent may SUBMIT a request; the
                            # human gate is enforced at runtime by the Telegram
                            # approval, not by this static field.
    # NOTE: the runtime human-approval + frozen-artifact controls are enforced
    # in code (ApprovalGate), not as policy constraints, so they are documented
    # here as comments rather than constraint IDs the validator must recognize.
    constraints:
      - own_mailbox_only
```

> Before adding constraints beyond `own_mailbox_only`, read `assertPolicyConstraints` in `src/mcp-tools/permissions.ts`: if it rejects or ignores unknown constraint IDs, only use IDs it recognizes. `own_mailbox_only` is already used by existing actions and is safe.

- [ ] **Step 2: Add the operation to `MCP_ALLOWED_OPERATIONS` in `src/mcp-tools/permissions.ts`** (after the host-orchestration block)

```ts
  "mail.send_with_approval": {
    backend: "host-state",
    status: "active",
    policyActionId: "mail.send_with_approval",
  },
```

- [ ] **Step 3: Verify exposure** with a throwaway check

Run:
```bash
npx tsx -e "import('./src/mcp-tools/permissions.ts').then(m => console.log(m.isMcpOperationExposed('mail.send_with_approval')))"
```
Expected: `true`.

- [ ] **Step 4: Run existing policy tests + typecheck**

Run: `npm test -- test/mcp-policy.test.ts` and `npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add policy/action-policy.yaml src/mcp-tools/permissions.ts
git commit -m "feat(approval): policy action + MCP operation for mail.send_with_approval"
```

---

## Task 9: MCP tools (request_send_mail, get_send_status)

**Files:**
- Create: `src/mcp-tools/mail-send.ts`
- Test: `test/mail-send-tool.test.ts`

> The tool module holds a gate **singleton** set by the composition root (Task 10). Tests inject a fake gate via the exported `__setGate` seam.

- [ ] **Step 1: Write the failing test** in `test/mail-send-tool.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { requestSendMail, getSendStatus, __setGate } from "../src/mcp-tools/mail-send.ts";

function fakeGate() {
  return {
    async submit(artifact: unknown, proposer: string) {
      return { request_id: "req1", status: "pending" as const };
    },
    getStatus(id: string) {
      return id === "req1" ? ({ status: "pending" as const }) : null;
    },
  };
}

test("request_send_mail validates and returns a request_id", async () => {
  __setGate(fakeGate() as never);
  const res = await requestSendMail.handler({
    account: "gmail",
    to: ["a@x.com"],
    subject: "s",
    body: "b",
  });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.request_id, "req1");
  assert.equal(payload.status, "pending");
});

test("request_send_mail rejects missing recipients", async () => {
  __setGate(fakeGate() as never);
  const res = await requestSendMail.handler({ account: "gmail", to: [], subject: "s", body: "b" });
  assert.equal(res.isError, true);
});

test("get_send_status returns the current state", async () => {
  __setGate(fakeGate() as never);
  const res = await getSendStatus.handler({ request_id: "req1" });
  const payload = JSON.parse((res.content[0] as { text: string }).text);
  assert.equal(payload.status, "pending");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/mail-send-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/mcp-tools/mail-send.ts`**

```ts
import type { ApprovalGate } from "../approval/gate.js";
import type { SendAccount, SendArtifact } from "../approval/types.js";
import { assertMcpOperation } from "./permissions.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";
import { registerTools } from "./server.js";

let gate: ApprovalGate | null = null;
export function __setGate(g: ApprovalGate): void {
  gate = g;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v) return [v];
  return [];
}

export const requestSendMail: McpToolDefinition = {
  operation: "mail.send_with_approval",
  tool: {
    name: "request_send_mail",
    description:
      "Request that an email be sent. Returns a request_id immediately; the " +
      "email is NOT sent until the user approves it out-of-band. Poll " +
      "get_send_status for the outcome (pending | sent | rejected+feedback).",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", enum: ["ms365", "gmail"] },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("mail.send_with_approval");
    } catch (e) {
      return permissionErr(e);
    }
    if (!gate) return err("approval gate not initialized");
    const to = asStringArray(args.to);
    if (to.length === 0) return err("at least one recipient (to) is required");
    const account = String(args.account) as SendAccount;
    if (account !== "ms365" && account !== "gmail") {
      return err(`invalid account: ${account}`);
    }
    const artifact: SendArtifact = {
      account,
      to,
      cc: asStringArray(args.cc),
      subject: String(args.subject ?? ""),
      body: String(args.body ?? ""),
    };
    try {
      const r = await gate.submit(artifact, "agent");
      return okJson(r);
    } catch (e) {
      return err(String(e));
    }
  },
};

export const getSendStatus: McpToolDefinition = {
  operation: "mail.send_with_approval",
  tool: {
    name: "get_send_status",
    description:
      "Check the status of a send request by request_id: pending | sent | " +
      "rejected (with feedback) | expired | failed.",
    inputSchema: {
      type: "object" as const,
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("mail.send_with_approval");
    } catch (e) {
      return permissionErr(e);
    }
    if (!gate) return err("approval gate not initialized");
    const view = gate.getStatus(String(args.request_id));
    if (!view) return err("unknown request_id");
    return okJson(view);
  },
};

registerTools([requestSendMail, getSendStatus]);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- test/mail-send-tool.test.ts` and `npm run typecheck`
Expected: PASS (3 tests); clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-tools/mail-send.ts test/mail-send-tool.test.ts
git commit -m "feat(approval): request_send_mail + get_send_status MCP tools"
```

---

## Task 10: Composition root (wire the gate in the MCP server)

**Files:**
- Modify: `src/mcp-server.ts`

> Build the gate with real ports and inject it into the tool module. Import `mail-send` for its registration side effect. Follow the existing import-for-side-effect pattern used for the other tool modules.

- [ ] **Step 1: Read the current `src/mcp-server.ts`** to find where tool modules are imported and `startMcpServer()` is called.

Run: `sed -n '1,60p' src/mcp-server.ts`

- [ ] **Step 2: Add the wiring** near the top of `src/mcp-server.ts`, before `startMcpServer()` is called

```ts
import { ApprovalGate } from "./approval/gate.js";
import { makeSender } from "./approval/sender.js";
import { gwsSend } from "./approval/gws-sender.js";
import { startTelegramApproval } from "./notifiers/telegram-approval.js";
import { __setGate } from "./mcp-tools/mail-send.js";
import {
  SEND_APPROVAL_TTL_MS,
  SEND_APPROVAL_MAX_OUTSTANDING,
  SEND_APPROVAL_RATE_PER_HOUR,
  SEND_INTERNAL_DOMAINS,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_APPROVER_USER_ID,
} from "./config.js";

function initApprovalGate(): void {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_APPROVER_USER_ID) {
    process.stderr.write(
      "[cuassistant-mcp] send-approval disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_APPROVER_USER_ID unset)\n",
    );
    return;
  }
  const sender = makeSender({ gmail: gwsSend });
  const noop: ApprovalChannel = { async post() {} };
  const gate = new ApprovalGate(
    {
      sender,
      channel: noop, // replaced via setChannel below (gate↔channel cycle)
      clock: { now: () => Date.now() },
      idGen: { generate: () => randomUUID() },
    },
    {
      ttlMs: SEND_APPROVAL_TTL_MS,
      maxOutstanding: SEND_APPROVAL_MAX_OUTSTANDING,
      rateLimitPerHour: SEND_APPROVAL_RATE_PER_HOUR,
      internalDomains: SEND_INTERNAL_DOMAINS,
      authorizedUserId: TELEGRAM_APPROVER_USER_ID,
    },
  );
  const channel = startTelegramApproval(
    {
      botToken: TELEGRAM_BOT_TOKEN,
      authorizedUserId: TELEGRAM_APPROVER_USER_ID,
      internalDomains: SEND_INTERNAL_DOMAINS,
    },
    gate,
  );
  gate.setChannel(channel);
  __setGate(gate);
}
```

Imports needed: `import { randomUUID } from "crypto";` and `import type { ApprovalChannel } from "./approval/types.js";` (alongside the others added in Step 2).

- [ ] **Step 3: Call `initApprovalGate()` before `startMcpServer()`** and add `import "./mcp-tools/mail-send.js";` alongside the other tool-module side-effect imports.

- [ ] **Step 4: Typecheck + full test run**

Run: `npm run typecheck` and `npm test`
Expected: clean; all tests pass.

- [ ] **Step 5: Smoke-test registration**

Run:
```bash
npx tsx -e "import('./src/mcp-tools/permissions.ts').then(m=>console.log('exposed:', m.isMcpOperationExposed('mail.send_with_approval')))"
```
Expected: `exposed: true`.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server.ts src/approval/gate.ts
git commit -m "feat(approval): wire approval gate + telegram channel into MCP server"
```

---

## Task 11: Docs + .env.example

**Files:**
- Modify: `.env.example`
- Modify: `src/mcp-server.md` (tool table)

- [ ] **Step 1: Append to `.env.example`**

```bash
# ===== Send-mail approval gate =====
# Telegram bot that delivers send approvals and collects your tap.
TELEGRAM_BOT_TOKEN=
TELEGRAM_APPROVER_USER_ID=
# Optional tuning:
# SEND_APPROVAL_TTL_MS=3600000
# SEND_APPROVAL_MAX_OUTSTANDING=5
# SEND_APPROVAL_RATE_PER_HOUR=10
# SEND_INTERNAL_DOMAINS=clemson.edu
```

- [ ] **Step 2: Add the two tools to the table in `src/mcp-server.md`**

```markdown
| `request_send_mail`                 | `mail.send_with_approval`           | `mail.send_with_approval`        | host gate + gws/Graph  | gmail.send / Mail.Send      | yes: runtime human approval |
| `get_send_status`                   | `mail.send_with_approval`           | `mail.send_with_approval`        | host gate              | —                           | yes |
```

- [ ] **Step 3: Commit**

```bash
git add .env.example src/mcp-server.md
git commit -m "docs(approval): .env.example + MCP tool table entries"
```

---

## Done criteria

- `npm test` and `npm run typecheck` clean.
- `isMcpOperationExposed('mail.send_with_approval')` is `true`.
- Gate state-machine tests cover: send-on-approve, fail-on-sender-error, reject+feedback, expiry, double-tap idempotency, unknown-user ignore, notify-failure fail-closed, caps + rate limit, account dispatch, external-recipient flagging.
- With `TELEGRAM_*` set and a `gws` auth that includes `gmail.send`, a real `request_send_mail` for `account: "gmail"` delivers a Telegram approval and sends only on ✅.

## Follow-on (out of scope here)
- MS365 Graph sender (`ms365.sendMail` → `POST /me/sendMail`) behind the existing `makeSender({ ms365 })` slot, once IT grants `Mail.Send` on the GCassistant app.
- Per-caller auth on the broker (#2) for the HTTP/container transport.
- Optional persistence of pending approvals across restart.
