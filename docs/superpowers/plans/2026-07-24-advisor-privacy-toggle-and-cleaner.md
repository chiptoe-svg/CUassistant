# Advisor Privacy Toggle + Extensible Cleaner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-track Private/OpenAI toggle to the advisor chat (with a server-enforced PII check on the OpenAI track), and ship a self-contained, client-side extensible "cleaner" tab (starting with Degree Works).

**Architecture:** A browser (cookie) owns a **pair** of sessions — one Private, one OpenAI — plus an `active` mode. Switching swaps which track the UI and the next turn use; nothing is disposed, so each conversation persists and isolation is structural. Private routes `rcd,spark` (FERPA-OK local); OpenAI routes `openai` only (gpt-5.5, no fallback). Sending in the OpenAI track passes a server-enforced, unit-tested `flagLikelyPrivate` gate — flagged text returns `409 needsConsent` and egresses nothing until the advisor consents. Feature 2 serves an auth-gated `/cleaner` page whose PDF/paste input is parsed in-browser (vendored pdf.js) and whitelist-extracted by a pluggable module; only the sanitized `gc-course-ledger-v1` output leaves the tab.

**Tech Stack:** TypeScript + `node:http` (advisor service, hand-rolled routes), `@earendil-works/pi-agent-core` / `pi-ai`, plain browser ES modules + vendored `pdfjs-dist@4.10.38`, `node:test` + `tsx`.

## Global Constraints

- **Repo is PUBLIC.** No secrets in any commit; credentials live only in the gitignored `.env`. Scan diffs before committing.
- **FERPA routing (verbatim intent):** identifiable student data may reach only **local inference** and **RCD campus models at `https://llm.rcd.clemson.edu/v1`**. The `/openai/v1` gateway passthrough is **de-identified only**. **NEVER Anthropic.**
- **Private track chain = `rcd,spark`** (fp8 primary at RCD, SGLang-Spark fallback). **OpenAI track chain = `openai` only, NO fallback.**
- **OpenAI track model = `gpt-5.5`** (tools+reasoning on `/chat/completions`). Do **NOT** use `gpt-5.6-sol` here.
- **RCD model = `qwen3.6-35b-a3b-fp8`**, dialed at `CLEMSON_LLM_BASE_URL`, auth `CLEMSON_LLM_API_KEY`.
- **Egress gate is fail-closed.** Every chain label maps to an authorized `data_egress.classifiers` record AND must dial a host that record covers.
- **Two-track, no reset.** Switching modes never disposes a conversation. `/clear` disposes the **active track only**. Disposal/sweep/shutdown must reap **both** tracks.
- **OpenAI PII gate is server-enforced.** `flagLikelyPrivate` matches structured identifiers only (Clemson C-ID, SSN, email, phone, GPA+number, long digit runs) — **never names**. Flagged OpenAI sends require explicit `consent: true`; the override is audit-logged (categories only, never content).
- **Cleaner is client-side only.** pdf.js is **vendored locally** (no CDN). Only the sanitized ledger leaves the browser. The `gc-course-ledger-v1` output **never** contains name, student ID, GPA, advisor, or grades.
- **Deploy:** the advisor is a long-lived launchd daemon (port 8770). Not done until it is **restarted and verified** (final task). MCP servers unchanged.

---

## File Structure

- `src/config.ts` — add `ADVISOR_OPENAI_MODEL`, `ADVISOR_RCD_MODEL`; change `ADVISOR_PROVIDER_CHAIN` default to the private chain (`rcd,spark`).
- `src/advisor-agent.ts` — add `rcd` provider/egress; `MODE_CHAINS`/`advisorChainForMode`; drive the turn off `session.mode`; log `mode`.
- `policy/action-policy.yaml` — add the `clemson_rcd_vllm` classifier record.
- `src/advisor-session.ts` — add `AdvisorMode` + `mode` field + `createSession` mode param; add the **client two-track layer** (`createClient`, `getActiveSession`, `switchActive`, `clearActive`).
- `src/advisor-pii-detect.ts` — **new**: pure `flagLikelyPrivate(text)`.
- `src/advisor-server.ts` — cookie = client id; `/mode` (swap, no reset); `/chat` OpenAI consent gate; `/clear` active track; `renderChatPage(mode)`; serve `/cleaner`.
- `src/advisor-ui.ts` — `renderChatPage(mode)`: mode banner, toggle, per-track transcript, consent dialog, cleaner link.
- `advisor/cleaner/modules/degree-works.js` (+ `.d.ts`) — Degree Works module (pure, Node-testable).
- `advisor/cleaner/framework.js`, `advisor/cleaner/index.html` — the browser shell + polished page.
- `advisor/cleaner/vendor/pdfjs/pdf.mjs` + `pdf.worker.mjs` — vendored pdf.js (committed).
- Tests: extend `test/advisor-agent.test.ts`, `test/advisor-session.test.ts`, `test/advisor-server.test.ts`, `test/advisor-ui.test.ts`; new `test/advisor-pii-detect.test.ts`, `test/cleaner-degree-works.test.ts`.

---

## Task 1: `rcd` provider + `clemson_rcd_vllm` policy record

**Files:**
- Modify: `policy/action-policy.yaml` (add a classifier under `data_egress.classifiers`, after `clemson_spark_vllm` ~line 631)
- Modify: `src/config.ts:233` (chain default) + add two model constants after `src/config.ts:235`
- Modify: `src/advisor-agent.ts` (`providerModel` ~248, `resolveProvider` ~301, `CHAIN_EGRESS_PROVIDER` ~100, imports ~39-51)
- Test: `test/advisor-agent.test.ts`

**Interfaces:**
- Consumes: `CLEMSON_LLM_API_KEY`, `CLEMSON_LLM_BASE_URL` (config); `isEgressAuthorized` (reads `data_egress.classifiers`).
- Produces: `providerModel("rcd")` dialing `llm.rcd.clemson.edu`; `resolveProvider("rcd")` keyed by `CLEMSON_LLM_API_KEY`; chain label `rcd` authorized. Config: `ADVISOR_RCD_MODEL` (default `qwen3.6-35b-a3b-fp8`), `ADVISOR_OPENAI_MODEL` (default `gpt-5.5`).

- [ ] **Step 1: Write the failing test** — append to `test/advisor-agent.test.ts`:

```ts
test("rcd chain entry is egress-authorized and dials the RCD campus host", () => {
  assert.doesNotThrow(() => assertAdvisorChainAuthorized(["rcd"]));
  const target = __resolveProviderForTest("rcd");
  if (target) {
    assert.equal(new URL(target.model.baseUrl).hostname, "llm.rcd.clemson.edu");
    assert.equal(new URL(target.model.baseUrl).pathname, "/v1");
    assert.equal(target.model.id, process.env.ADVISOR_RCD_MODEL || "qwen3.6-35b-a3b-fp8");
  }
});

test("rcd resolves the RCD campus host", () => {
  assert.equal(__dialledHostForTest("rcd"), "llm.rcd.clemson.edu");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-agent.test.ts`
Expected: FAIL — `assertAdvisorChainAuthorized(["rcd"])` throws `has no destination declared`.

- [ ] **Step 3: Add the policy record.** In `policy/action-policy.yaml`, immediately after the `clemson_spark_vllm` block (~line 631), add:

```yaml
    # Clemson RCD LLM cluster — CAMPUS-HOSTED models at llm.rcd.clemson.edu/v1
    # (the "/v1" path, NOT the "/openai/v1" passthrough). Clemson-operated,
    # open-weight models on Clemson infrastructure; content stays inside Clemson
    # and reaches no third party, so this route is FERPA-cleared for identifiable
    # student data. Same host and credential as clemson_llm_gateway_openai, but a
    # DIFFERENT service on a different path — kept as a separate record precisely
    # because their FERPA status differs.
    - provider: clemson_rcd_vllm
      scope: external
      sends: [subject, body]
      basis: "Clemson-operated RCD LLM cluster, campus-hosted models at llm.rcd.clemson.edu/v1 over TLS with a Clemson-issued key; content stays within Clemson infrastructure and is not forwarded to any third party"
      authorized: true
```

- [ ] **Step 4: Add the config constants.** In `src/config.ts`, change line 233 and add two constants after line 235:

```ts
// Private track's provider chain: fp8 (RCD campus, FERPA-OK) first, SGLang-Spark
// fallback. The OpenAI track chain is fixed in advisor-agent.ts, not env-driven.
export const ADVISOR_PROVIDER_CHAIN = (
  process.env.ADVISOR_PROVIDER_CHAIN || "rcd,spark"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "qwen3.6-35b-a3b";
export const ADVISOR_BASE_URL =
  process.env.ADVISOR_BASE_URL || "http://gcspark.clemson.edu:8080/v1";
/** RCD campus fp8 model (Private track primary), dialed at CLEMSON_LLM_BASE_URL. */
export const ADVISOR_RCD_MODEL =
  process.env.ADVISOR_RCD_MODEL || "qwen3.6-35b-a3b-fp8";
/** OpenAI-track model. gpt-5.5 does tools+reasoning; gpt-5.6-sol must NOT be used here. */
export const ADVISOR_OPENAI_MODEL =
  process.env.ADVISOR_OPENAI_MODEL || "gpt-5.5";
```

- [ ] **Step 5: Add the `rcd` egress destination.** In `src/advisor-agent.ts`, add to `CHAIN_EGRESS_PROVIDER` after the `openai` entry (~line 115):

```ts
  // Clemson RCD campus models at llm.rcd.clemson.edu/v1 — the FERPA-OK local
  // route (distinct from the openai passthrough on /openai/v1, same host). The
  // gate checks only the host; the FERPA distinction between /v1 and /openai/v1
  // is carried by which track uses which label (see MODE_CHAINS).
  rcd: {
    policyProvider: "clemson_rcd_vllm",
    hosts: ["llm.rcd.clemson.edu"],
  },
```

- [ ] **Step 6: Add the `rcd` model + resolution.** In `src/advisor-agent.ts`, add `ADVISOR_RCD_MODEL`, `CLEMSON_LLM_BASE_URL`, `ADVISOR_OPENAI_MODEL` to the `./config.js` import block (~line 39). Add an `rcd` branch at the top of `providerModel` (before `spark`, ~line 249):

```ts
  if (name === "rcd") {
    // Same Qwen thinking shape as spark (identical model family), dialed at the
    // RCD campus /v1 endpoint with the gateway key.
    return {
      id: ADVISOR_RCD_MODEL,
      name: ADVISOR_RCD_MODEL,
      api: "openai-completions",
      provider: "openai",
      baseUrl: CLEMSON_LLM_BASE_URL,
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 65536,
      maxTokens: 8192,
    } as unknown as Model<never>;
  }
```

Change the `openai` branch id (~line 277) to `const id = ADVISOR_OPENAI_MODEL;`. In `resolveProvider` (~line 312) give `rcd` the gateway key:

```ts
  const gatewayKey = CLEMSON_LLM_API_KEY || OPENAI_API_KEY;
  if ((name === "openai" || name === "rcd") && !gatewayKey) return null;
  return {
    name,
    apiKey:
      name === "spark" ? process.env.ADVISOR_API_KEY || "local" : gatewayKey,
    model,
  };
```

- [ ] **Step 7: Run + typecheck + commit**

```bash
node --import tsx --test test/advisor-agent.test.ts
npm run typecheck
git add policy/action-policy.yaml src/config.ts src/advisor-agent.ts test/advisor-agent.test.ts
git commit -m "feat(advisor): add rcd (RCD fp8) provider + clemson_rcd_vllm egress record"
```
Expected: tests + typecheck PASS.

---

## Task 2: Session `mode` field + mode-driven provider chain + audit

**Files:**
- Modify: `src/advisor-session.ts` (`AdvisorMode`, `mode` field, `createSession` param)
- Modify: `src/advisor-agent.ts` (`MODE_CHAINS`, `advisorChainForMode`, `runAdvisorTurn` loop, `initAdvisorTools`, per-turn log)
- Test: `test/advisor-session.test.ts`, `test/advisor-agent.test.ts`

**Interfaces:**
- Consumes: `rcd`/`spark`/`openai` providers (Task 1); `ADVISOR_PROVIDER_CHAIN`.
- Produces: `AdvisorMode = "private" | "openai"` (exported from `advisor-session.ts`); `AdvisorSession.mode`; `createSession(advisorId, mode = "private")`; `advisorChainForMode(mode)`; `runAdvisorTurn` iterates `MODE_CHAINS[session.mode]`.

- [ ] **Step 1: Write the failing test** — append to `test/advisor-session.test.ts`:

```ts
test("createSession defaults to private mode and honors an explicit mode", () => {
  assert.equal(createSession("shared").mode, "private");
  assert.equal(createSession("shared", "openai").mode, "openai");
});
```

Append to `test/advisor-agent.test.ts` (add `advisorChainForMode` to the `../src/advisor-agent.ts` import):

```ts
test("advisorChainForMode: private is rcd,spark and openai is openai-only", () => {
  assert.deepEqual([...advisorChainForMode("private")], ["rcd", "spark"]);
  assert.deepEqual([...advisorChainForMode("openai")], ["openai"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-session.test.ts test/advisor-agent.test.ts`
Expected: FAIL — `mode` undefined; `advisorChainForMode` not exported.

- [ ] **Step 3: Add mode to the session.** In `src/advisor-session.ts`, add near the top:

```ts
export type AdvisorMode = "private" | "openai";
```

Add to the `AdvisorSession` interface (after `advisorId`):

```ts
  /** Private routes to FERPA-OK local models; OpenAI routes de-identified data to gpt-5.5. */
  mode: AdvisorMode;
```

Change `createSession`:

```ts
export function createSession(
  advisorId: string,
  mode: AdvisorMode = "private",
): AdvisorSession {
  const id = crypto.randomBytes(24).toString("base64url");
  const session: AdvisorSession = {
    id,
    advisorId,
    mode,
    workDir: mkdtempSync(path.join(tmpdir(), "advisor-work-")),
    piSessionRoot: mkdtempSync(path.join(tmpdir(), "advisor-pi-")),
    history: [],
    lastTouched: Date.now(),
  };
  sessions.set(id, session);
  return session;
}
```

- [ ] **Step 4: Add `MODE_CHAINS` + `advisorChainForMode`.** In `src/advisor-agent.ts`, add after `CHAIN_EGRESS_PROVIDER` (~line 116):

```ts
import type { AdvisorMode } from "./advisor-session.js";

// The provider chain is a function of the session's mode. Private never lists
// the `openai` label, so a Private turn is structurally unable to dial the OpenAI
// passthrough — that is what makes the "Private" claim honest. OpenAI has no
// fallback: a failure surfaces rather than silently retrying elsewhere.
const MODE_CHAINS: Readonly<Record<AdvisorMode, readonly string[]>> = {
  private: ADVISOR_PROVIDER_CHAIN,
  openai: ["openai"],
};

export function advisorChainForMode(mode: AdvisorMode): readonly string[] {
  return MODE_CHAINS[mode];
}
```

- [ ] **Step 5: Drive startup + the turn off the mode.** In `initAdvisorTools` (~line 216) replace the single assert:

```ts
  for (const chain of Object.values(MODE_CHAINS)) {
    assertAdvisorChainAuthorized(chain);
  }
```

In `runAdvisorTurn` (~line 940) replace the loop header:

```ts
  for (const name of MODE_CHAINS[session.mode]) {
```

- [ ] **Step 6: Log the mode per turn.** In `runWithProvider`, add to the `log.info("advisor turn complete", {...})` object (~line 772, after `advisorId`):

```ts
      mode: session.mode,
```

- [ ] **Step 7: Fix existing tests.** Run `grep -rn '"spark,openai"' test/` and update any assertion of the old chain default to `"rcd,spark"`. Run `grep -rn 'mode:' test/advisor-agent.test.ts` and, for any hand-built `AdvisorSession` object literal used with `runAdvisorTurn`, add `mode: "private"`. (Sessions built via `createSession` need no change.)

- [ ] **Step 8: Run + typecheck + commit**

```bash
node --import tsx --test test/advisor-session.test.ts test/advisor-agent.test.ts
npm run typecheck
git add src/advisor-session.ts src/advisor-agent.ts test/advisor-session.test.ts test/advisor-agent.test.ts
git commit -m "feat(advisor): per-session mode drives the provider chain (Private vs OpenAI)"
```
Expected: PASS.

---

## Task 3: Client two-track layer (a browser owns a Private + OpenAI session)

**Files:**
- Modify: `src/advisor-session.ts` (add the client layer + `resetClientsForTest`)
- Test: `test/advisor-session.test.ts`

**Interfaces:**
- Consumes: `createSession`, `getSession`, `clearSession` (existing/Task 2).
- Produces:
  - `createClient(advisorId, active = "private"): { clientId: string; session: AdvisorSession }` — mints a client (the cookie value) and eagerly creates its active track.
  - `getActiveSession(clientId): { session: AdvisorSession } | undefined` — the active track, lazily (re)created if swept.
  - `switchActive(clientId, mode): AdvisorSession` — set active, lazily create that track; no dispose.
  - `clearActive(clientId): AdvisorSession` — dispose + recreate the active track only.
  - `resetClientsForTest(): void`.

- [ ] **Step 1: Write the failing test** — append to `test/advisor-session.test.ts` (add the new names to the `../src/advisor-session.ts` import; call `resetClientsForTest()` + `resetSessionsForTest()` in the file's existing `beforeEach`/setup if present):

```ts
test("client owns two tracks; switching preserves both", () => {
  const { clientId, session: priv } = createClient("shared", "private");
  assert.equal(priv.mode, "private");
  const oai = switchActive(clientId, "openai");
  assert.equal(oai.mode, "openai");
  assert.notEqual(oai.id, priv.id);
  // switching back returns the SAME private session — not disposed
  assert.equal(switchActive(clientId, "private").id, priv.id);
});

test("clearActive disposes only the active track", () => {
  const { clientId } = createClient("shared", "private");
  const oai = switchActive(clientId, "openai");
  switchActive(clientId, "private");
  const fresh = clearActive(clientId);
  assert.equal(fresh.mode, "private");
  assert.equal(switchActive(clientId, "openai").id, oai.id); // openai track untouched
});

test("getActiveSession returns the active track", () => {
  const { clientId } = createClient("shared", "openai");
  assert.equal(getActiveSession(clientId)?.session.mode, "openai");
  assert.equal(getActiveSession(undefined), undefined);
  assert.equal(getActiveSession("nope"), undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-session.test.ts`
Expected: FAIL — `createClient` etc. not exported.

- [ ] **Step 3: Add the client layer.** In `src/advisor-session.ts`, after the existing exports, add:

```ts
// A client is a browser (identified by the session cookie). It owns up to two
// sessions — one per mode — and an active mode. Switching swaps `active`; the
// non-active track persists. The `sessions` map above remains the source of
// truth for directories, so disposeAllSessions()/sweepExpired() already reap
// both tracks; this map holds only pointers (no directories of its own).
interface ClientTracks {
  advisorId: string;
  active: AdvisorMode;
  ids: Partial<Record<AdvisorMode, string>>;
}
const clients = new Map<string, ClientTracks>();

function resolveTrack(client: ClientTracks, mode: AdvisorMode): AdvisorSession {
  // Lazily (re)create — the target track may never have been visited, or an idle
  // track may have been swept by TTL. Either way the advisor gets a live session.
  let s = getSession(client.ids[mode]);
  if (!s) {
    s = createSession(client.advisorId, mode);
    client.ids[mode] = s.id;
  }
  return s;
}

export function createClient(
  advisorId: string,
  active: AdvisorMode = "private",
): { clientId: string; session: AdvisorSession } {
  const clientId = crypto.randomBytes(24).toString("base64url");
  const session = createSession(advisorId, active);
  clients.set(clientId, { advisorId, active, ids: { [active]: session.id } });
  return { clientId, session };
}

export function getActiveSession(
  clientId: string | undefined,
): { session: AdvisorSession } | undefined {
  if (!clientId) return undefined;
  const client = clients.get(clientId);
  if (!client) return undefined;
  return { session: resolveTrack(client, client.active) };
}

export function switchActive(clientId: string, mode: AdvisorMode): AdvisorSession {
  const client = clients.get(clientId);
  if (!client) throw new Error("unknown advisor client");
  client.active = mode;
  return resolveTrack(client, mode);
}

export function clearActive(clientId: string): AdvisorSession {
  const client = clients.get(clientId);
  if (!client) throw new Error("unknown advisor client");
  const cur = client.ids[client.active];
  if (cur) clearSession(cur);
  const s = createSession(client.advisorId, client.active);
  client.ids[client.active] = s.id;
  return s;
}

/** Test seam: drop all client pointers (does not dispose sessions — use resetSessionsForTest for that). */
export function resetClientsForTest(): void {
  clients.clear();
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
node --import tsx --test test/advisor-session.test.ts
npm run typecheck
git add src/advisor-session.ts test/advisor-session.test.ts
git commit -m "feat(advisor): two-track client layer (Private + OpenAI sessions per browser)"
```
Expected: PASS.

---

## Task 4: PII detector (`flagLikelyPrivate`)

**Files:**
- Create: `src/advisor-pii-detect.ts`
- Test: `test/advisor-pii-detect.test.ts`

**Interfaces:**
- Produces: `interface PrivacyFlag { category: string; sample: string }` and `flagLikelyPrivate(text: string): PrivacyFlag[]` — high-precision structured identifiers only; never names.

- [ ] **Step 1: Write the failing test** — create `test/advisor-pii-detect.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { flagLikelyPrivate } from "../src/advisor-pii-detect.ts";

test("flags structured identifiers", () => {
  const cats = (s: string) => flagLikelyPrivate(s).map((f) => f.category);
  assert.deepEqual(cats("student C12345678"), ["Clemson student ID"]);
  assert.ok(cats("reach me at jdoe@clemson.edu").includes("email address"));
  assert.ok(cats("call 864-555-1212").includes("phone number"));
  assert.ok(cats("SSN 123-45-6789").includes("SSN"));
  assert.ok(cats("her GPA is 3.42").includes("GPA"));
  assert.ok(cats("id 900123456").includes("long digit sequence"));
});

test("does NOT flag ordinary advising prose or public course data", () => {
  assert.deepEqual(flagLikelyPrivate("Can she take GC 3400 and GC 3410 in Fall 2024?"), []);
  assert.deepEqual(flagLikelyPrivate("CRN 12345 meets MWF 9:05"), []); // 5-digit CRN, 4-digit course, time
  assert.deepEqual(flagLikelyPrivate("Prof. Sarah Johnson teaches the lab"), []); // names not gated
});

test("returns the matched sample so the advisor can find it", () => {
  const flags = flagLikelyPrivate("her id is C87654321");
  assert.equal(flags[0].category, "Clemson student ID");
  assert.equal(flags[0].sample, "C87654321");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-pii-detect.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the detector.** Create `src/advisor-pii-detect.ts`:

```ts
// Rudimentary private-information detector for the OpenAI advisor track.
//
// Precision over recall, on purpose. This gate blocks a send and asks a human to
// confirm; a detector that false-fires on ordinary advising prose trains
// advisors to click through, which destroys the value of the true positives. So
// it matches only HIGH-SIGNAL structured identifiers and deliberately does NOT
// attempt name detection — names false-fire on course titles, buildings, and
// instructor names. Names are covered by the standing "de-identified only"
// banner and the switch-to-OpenAI confirm instead.
//
// It is not a security boundary (trusted staff behind auth) — it is a guardrail
// against an accidental paste. The server enforces it as a soft gate: flagged
// text is refused until the advisor explicitly consents.

export interface PrivacyFlag {
  category: string;
  sample: string;
}

const PATTERNS: { category: string; re: RegExp }[] = [
  { category: "Clemson student ID", re: /\bC\d{8}\b/ },
  { category: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { category: "email address", re: /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/ },
  // 10-digit US phone with optional country code and common separators.
  { category: "phone number", re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  // "GPA" adjacent to a number (e.g. "GPA 3.42", "GPA: 3.4").
  { category: "GPA", re: /\bGPA\b[^\d\n]{0,6}\d(?:\.\d{1,3})?/i },
  // A bare run of 7+ digits — student/employee IDs without the C prefix. CRNs
  // (5), course numbers (4), and years (4) are shorter and do not match.
  { category: "long digit sequence", re: /\b\d{7,}\b/ },
];

export function flagLikelyPrivate(text: string): PrivacyFlag[] {
  const flags: PrivacyFlag[] = [];
  for (const { category, re } of PATTERNS) {
    const m = text.match(re);
    if (m) flags.push({ category, sample: m[0].trim() });
  }
  return flags;
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
node --import tsx --test test/advisor-pii-detect.test.ts
npm run typecheck
git add src/advisor-pii-detect.ts test/advisor-pii-detect.test.ts
git commit -m "feat(advisor): flagLikelyPrivate — structured-identifier PII detector"
```
Expected: PASS.

---

## Task 5: Server — cookie=client, `/mode` swap, `/chat` OpenAI consent gate, `/clear` active track

**Files:**
- Modify: `src/advisor-server.ts` (imports; auth gate; `/login`; `GET /`; `/chat`; `/mode`; `/clear`; `lastMode`)
- Test: `test/advisor-server.test.ts`

**Interfaces:**
- Consumes: `createClient`, `getActiveSession`, `switchActive`, `clearActive`, `AdvisorMode` (Task 3); `flagLikelyPrivate` (Task 4); `renderChatPage(mode)` (Task 6 — until then it is called with one arg, which the current 0-arg signature ignores; Task 6 adds the parameter).
- Produces: cookie holds a **client id**; `POST /mode {mode}` swaps the active track (no reset, no new cookie) → `{ mode }`; `POST /chat` on the OpenAI track returns `409 { needsConsent, flags }` for flagged text without `consent:true`, else runs the turn (logging an override when consented); `POST /clear` disposes the active track only, no new cookie.

- [ ] **Step 1: Write the failing tests** — append to `test/advisor-server.test.ts` (reuse/introduce `startTestServer` + `loginCookie` helpers as the file's other tests do; the stub `runTurn` should return a `complete` result):

```ts
test("POST /mode swaps the active track and does not reset", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/mode", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ mode: "openai" }),
    });
    const data = await r.json();
    assert.equal(r.status, 200);
    assert.equal(data.mode, "openai");
    assert.equal(r.headers.get("set-cookie"), null); // cookie (client id) is stable
  } finally { server.close(); }
});

test("POST /chat on the OpenAI track blocks flagged text without consent", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    await fetch(base + "/mode", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ mode: "openai" }) });
    const r = await fetch(base + "/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ message: "look at C12345678" }),
    });
    assert.equal(r.status, 409);
    const data = await r.json();
    assert.equal(data.needsConsent, true);
    assert.ok(data.flags.some((f) => f.category === "Clemson student ID"));
  } finally { server.close(); }
});

test("POST /chat on the OpenAI track proceeds with consent", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    await fetch(base + "/mode", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ mode: "openai" }) });
    const r = await fetch(base + "/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ message: "look at C12345678", consent: true }),
    });
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

test("POST /chat on the Private track never checks for PII", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ message: "student C12345678 wants GC 3400" }),
    });
    assert.equal(r.status, 200); // private is FERPA-OK; no gate
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-server.test.ts`
Expected: FAIL — `/mode` 404; `/chat` does not gate.

- [ ] **Step 3: Update imports.** In `src/advisor-server.ts`, replace the `./advisor-session.js` import block (~lines 33-40) with:

```ts
import {
  createClient,
  getActiveSession,
  switchActive,
  clearActive,
  disposeAllSessions,
  sweepExpired,
  type AdvisorMode,
  type AdvisorSession,
} from "./advisor-session.js";
```

Add to the `./advisor-agent.js` import? No — add the detector import near the other `./` imports:

```ts
import { flagLikelyPrivate } from "./advisor-pii-detect.js";
```

- [ ] **Step 4: Add last-used tracking.** Near the `inFlight` map (~line 220):

```ts
// Last mode each advisor used, so a fresh login opens where they left off.
// In-memory: a restart resets to `private`, the safe default. The server is
// authoritative for routing; the banner is cosmetic and cannot disagree.
const lastMode = new Map<string, AdvisorMode>();
```

- [ ] **Step 5: Resolve the client, not a bare session.** In `GET "/"` (~line 232-240):

```ts
      if (method === "GET" && url.pathname === "/") {
        const cid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const active = getActiveSession(cid);
        return active
          ? html(res, 200, renderChatPage(active.session.mode))
          : html(res, 200, renderLoginPage());
      }
```

In `/login`, replace `const session = createSession("shared");` (~line 259) and its cookie:

```ts
        const { clientId } = createClient("shared", lastMode.get("shared") ?? "private");
        log.info("advisor login", { client: clientId });
        res.writeHead(302, {
          Location: "./",
          "Set-Cookie": sessionCookie(clientId),
        });
        return res.end();
```

Replace the auth-gate resolution (~lines 272-276):

```ts
      const auth = authenticate(req);
      if (!auth) return json(res, 401, { error: "not authenticated" });
      const cid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const active = getActiveSession(cid);
      if (!active) return json(res, 401, { error: "session expired" });
      const session = active.session;
```

(Every handler below already uses `session`; they now operate on the active track. Where a handler needs to switch/clear, it uses `cid`.)

- [ ] **Step 6: Gate `/chat` on the OpenAI track.** In the `/chat` handler, replace the body-parse + validation (~lines 278-281) with:

```ts
        const parsed = JSON.parse(await readBody(req)) as {
          message?: string;
          consent?: boolean;
        };
        const message = parsed.message;
        if (!message) return json(res, 400, { error: "message is required" });

        // OpenAI track: rudimentary PII gate. Refuse to forward flagged text
        // without explicit consent — a 409 runs NO turn, so nothing egresses.
        // Private track is FERPA-OK and never checked.
        if (session.mode === "openai") {
          const flags = flagLikelyPrivate(message);
          if (flags.length > 0 && parsed.consent !== true) {
            return json(res, 409, { needsConsent: true, flags });
          }
          if (flags.length > 0) {
            // Override — metadata only, never the flagged content.
            log.info("advisor OpenAI turn sent with PII-flag override", {
              session: session.id,
              categories: flags.map((f) => f.category),
            });
          }
        }
```

The rest of the `/chat` handler (controller, `inFlight`, `runTurn`, history, response) is unchanged.

- [ ] **Step 7: Add `/mode`; simplify `/clear`.** Replace the `/clear` handler (~lines 356-375) with the two handlers:

```ts
      if (method === "POST" && url.pathname === "/clear") {
        // Dispose the ACTIVE track only; the other track is untouched. Abort +
        // WAIT first, as before, so the turn's commit step cannot recreate
        // piSessionRoot after disposal.
        const entry = inFlight.get(session.id);
        if (entry) {
          entry.controller.abort();
          await entry.done;
          inFlight.delete(session.id);
        }
        clearActive(cid);
        log.info("advisor active track cleared", { client: cid });
        return json(res, 200, { cleared: true }); // client id is stable — no Set-Cookie
      }

      if (method === "POST" && url.pathname === "/mode") {
        const body = JSON.parse(await readBody(req)) as { mode?: string };
        const next = body.mode;
        if (next !== "private" && next !== "openai") {
          return json(res, 400, { error: "mode must be 'private' or 'openai'" });
        }
        lastMode.set(session.advisorId, next);
        const target = switchActive(cid, next); // lazily creates the track; no dispose
        log.info("advisor mode switched", { client: cid, mode: target.mode });
        return json(res, 200, { mode: target.mode });
      }
```

- [ ] **Step 8: Run + typecheck + commit**

```bash
node --import tsx --test test/advisor-server.test.ts
npm run typecheck
git add src/advisor-server.ts test/advisor-server.test.ts
git commit -m "feat(advisor): two-track server (/mode swap, OpenAI PII consent gate, /clear active)"
```
Expected: PASS. (If `renderChatPage` still takes zero args at this point, `renderChatPage(active.session.mode)` compiles because the extra arg is ignored until Task 6; keep the call site as written.)

---

## Task 6: Mode banner + toggle + per-track transcript + consent dialog + cleaner link (UI)

**Files:**
- Modify: `src/advisor-ui.ts` (`renderChatPage(mode)`)
- Test: `test/advisor-ui.test.ts`

**Interfaces:**
- Consumes: `renderChatPage(mode)` is called with `session.mode` (Task 5).
- Produces: `renderChatPage(mode: "private" | "openai" = "private"): string` — banner + toggle reflect `mode` at first paint; the toggle POSTs `/mode` (confirm on switch TO OpenAI, de-identification wording); the answers pane keeps a per-track transcript (switching hides the other track's messages, not wipes them); a 409 from `/chat` shows the consent dialog (Cancel & edit keeps the text; Not private — send re-POSTs with `consent:true`); a "Clean a document" link opens `cleaner` in a new tab.

- [ ] **Step 1: Write the failing test** — append to `test/advisor-ui.test.ts` (update existing `renderChatPage()` calls to pass a mode):

```ts
test("renderChatPage reflects the mode at first paint and links the cleaner", () => {
  const priv = renderChatPage("private");
  assert.match(priv, /data-mode="private"/);
  assert.match(priv, /Private/);
  assert.match(priv, /cleaner/);
  const oai = renderChatPage("openai");
  assert.match(oai, /data-mode="openai"/);
  assert.match(oai, /de-identified/i);
  assert.match(oai, /needsConsent/); // the consent handler is present in the script
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-ui.test.ts`
Expected: FAIL — signature/markers absent.

- [ ] **Step 3: Add styles.** Append to the `STYLE` template (before its closing backtick, ~line 21):

```css
  #modebar { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap;
             padding:.6rem .8rem; border-radius:8px; margin-bottom:1rem; border:1px solid #8886; }
  #modebar[data-mode="private"] { background:#e6f4ee; border-color:#2f6f5e; }
  #modebar[data-mode="openai"]  { background:#fdf0e0; border-color:#c67b18; }
  @media (prefers-color-scheme: dark) {
    #modebar[data-mode="private"] { background:#12271f; }
    #modebar[data-mode="openai"]  { background:#2c2010; } }
  #modebar strong { font-weight:680; }
  #modebar .modenote { color:#595959; font-size:.9rem; }
  #modebar a.cleanerlink { margin-left:auto; }
  #answers[data-track="private"] article[data-track="openai"],
  #answers[data-track="openai"] article[data-track="private"] { display:none; }
```

- [ ] **Step 4: Take a mode and render the bar + tagged answers.** Replace the `renderChatPage` signature and intro (~lines 58-88), keeping the rest of the original markup (`#status`, `#composer`, buttons) unchanged after it, and tagging answers by track:

```ts
export function renderChatPage(mode: "private" | "openai" = "private"): string {
  const priv = mode === "private";
  return page(
    "Advisor chat",
    `<h1>Advisor chat</h1>

<div id="modebar" data-mode="${mode}">
  <strong id="modelabel">${priv ? "Private mode" : "OpenAI mode"}</strong>
  <span class="modenote" id="modenote">${
    priv
      ? "Local, FERPA-approved models. Student information may be used."
      : "De-identified data only \\u2014 do NOT enter student names, IDs, or grades."
  }</span>
  <button id="modeToggle" type="button">${
    priv ? "Switch to OpenAI mode" : "Switch to Private mode"
  }</button>
  <a class="cleanerlink" href="cleaner" target="_blank" rel="noopener">Clean a document \\u2197</a>
</div>

<p>Ask about schedules, room capacity, or GC requirements. Clear the session
when you move to another student.</p>

<div id="status" role="status" aria-live="polite"></div>
<div id="answers" data-track="${mode}" aria-live="polite" aria-atomic="false"></div>

<form id="composer">
  <label for="message">Your question</label>
  <textarea id="message" name="message" required></textarea>
  <button id="send" type="submit">Send</button>
  <button id="stop" type="button" disabled>Stop</button>
  <button id="clear" type="button">Clear session</button>
  <button id="export" type="button">Export transcript</button>
  <button id="schedule" type="button" hidden>Open proposed schedule</button>
</form>

<script>
const $ = (id) => document.getElementById(id);
const status = $("status"), answers = $("answers"), modebar = $("modebar");
let uiMode = ${JSON.stringify(mode)};

function addAnswer(role, text) {
  const art = document.createElement("article");
  art.dataset.track = uiMode;
  const h = document.createElement("h2");
  h.className = "role"; h.textContent = role;
  const p = document.createElement("p"); p.textContent = text;
  art.append(h, p); answers.append(art);
}

// POST a message; transparently handle the OpenAI PII 409. Returns the final
// Response (200) or null if the advisor cancelled at the consent prompt.
async function send(message, consent) {
  const r = await fetch("chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(consent ? { message, consent: true } : { message }),
  });
  if (r.status === 409) {
    const data = await r.json();
    if (data.needsConsent) {
      const cats = data.flags.map((f) => f.category + " (\\u201c" + f.sample + "\\u201d)").join(", ");
      const ok = confirm(
        "This looks like it may contain private information: " + cats + ".\\n\\n" +
        "OK = it is not private, send anyway.\\nCancel = go back and edit."
      );
      if (ok) return send(message, true);
      $("message").value = message;   // restore for editing; nothing was sent
      status.textContent = "Not sent \\u2014 edit and try again.";
      return null;
    }
  }
  return r;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("message").value.trim();
  if (!message) return;
  $("send").disabled = true; $("stop").disabled = false;
  status.textContent = "Checking the schedule\\u2026";
  try {
    const r = await send(message, false);
    if (!r) return;                      // cancelled at consent — leave text as-is
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "request failed");
    addAnswer("You", message);           // committed to sending; reflect it now
    $("message").value = "";
    if (data.schedule) $("schedule").hidden = false;
    if (data.outcome === "aborted") {
      addAnswer("Advisor chat \\u2014 stopped", data.text);
      status.textContent = "Stopped.";
    } else {
      addAnswer("Advisor chat", data.text);
      status.textContent = "Response ready.";
    }
  } catch (err) {
    status.textContent = "Something went wrong. Please try again.";
  } finally {
    $("send").disabled = false; $("stop").disabled = true; $("message").focus();
  }
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  status.textContent = "Stopping\\u2026";
  try {
    const r = await fetch("stop", { method: "POST" });
    const data = await r.json();
    status.textContent = data.stopped ? "Stop requested." : "Nothing to stop.";
  } catch (err) { status.textContent = "Could not stop."; }
});

$("clear").addEventListener("click", async () => {
  await fetch("clear", { method: "POST" });
  // Only the active track was cleared server-side; drop its messages from view.
  answers.querySelectorAll('article[data-track="' + uiMode + '"]').forEach((a) => a.remove());
  $("schedule").hidden = true;
  status.textContent = "Session cleared.";
  $("message").focus();
});

$("export").addEventListener("click", () => { location.href = "export"; });
$("schedule").addEventListener("click", () => { window.open("export/schedule", "_blank", "noopener"); });

$("modeToggle").addEventListener("click", async () => {
  const next = uiMode === "private" ? "openai" : "private";
  if (next === "openai") {
    const ok = confirm(
      "Switch to the OpenAI track?\\n\\nDe-identified data only \\u2014 do not enter " +
      "student names, IDs, or grades. Your Private conversation stays open on the " +
      "Private track."
    );
    if (!ok) return;
  }
  try {
    const r = await fetch("mode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "mode switch failed");
    uiMode = data.mode;
    const priv = uiMode === "private";
    modebar.setAttribute("data-mode", uiMode);
    answers.setAttribute("data-track", uiMode);   // show this track's messages, hide the other
    $("modelabel").textContent = priv ? "Private mode" : "OpenAI mode";
    $("modenote").textContent = priv
      ? "Local, FERPA-approved models. Student information may be used."
      : "De-identified data only \\u2014 do NOT enter student names, IDs, or grades.";
    $("modeToggle").textContent = priv ? "Switch to OpenAI mode" : "Switch to Private mode";
    $("schedule").hidden = true;
    status.textContent = "Now on the " + (priv ? "Private" : "OpenAI") + " track.";
  } catch (err) { status.textContent = "Could not switch mode."; }
});
</script>`,
  );
}
```

(This replaces the entire previous `renderChatPage` body. The original inline handlers are folded in above — verify the returned string still contains `#status`, `#answers`, `#composer`, all buttons, and the stop/clear/export/schedule handlers.)

- [ ] **Step 5: Run + typecheck + commit**

```bash
node --import tsx --test test/advisor-ui.test.ts
npm run typecheck
git add src/advisor-ui.ts test/advisor-ui.test.ts
git commit -m "feat(advisor): mode banner + toggle, per-track transcript, OpenAI consent dialog"
```
Expected: PASS.

---

## Task 7: Degree Works cleaner module (pure, Node-testable)

**Files:**
- Create: `advisor/cleaner/modules/degree-works.js`, `advisor/cleaner/modules/degree-works.d.ts`
- Test: `test/cleaner-degree-works.test.ts`

**Interfaces:**
- Produces: `degreeWorksModule: CleanerModule` where
  ```ts
  interface CleanerResult { schema: string; sanitized: unknown; warnings: string[]; metrics: { label: string; value: string }[]; preview: string; }
  interface CleanerModule { id: string; label: string; description: string; accepts: ("pdf"|"text")[]; clean(rawText: string): CleanerResult; }
  ```
  `clean(rawText)` returns `schema: "gc-course-ledger-v1"`, `sanitized` = the ledger, `metrics`, and `preview` (source with private lines removed). Consumed by the framework (Task 8).

- [ ] **Step 1: Write the failing test** — create `test/cleaner-degree-works.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { degreeWorksModule } from "../advisor/cleaner/modules/degree-works.js";

const SAMPLE = [
  "Clemson University Degree Works",
  "Student name John Q Public C12345678",
  "Overall GPA 3.45",
  "Major Graphic Communications Minor None",
  "Credits required: 122 Credits applied: 45 Catalog year: 2023-2024",
  "Course Title Grade Credits Term",
  "GC 1040 Introduction to Graphic Communications A 3 Fall 2023",
  "GC 2050 Digital Imaging IP 3 Spring 2024",
].join("\n");

test("emits gc-course-ledger-v1 with the completed courses", () => {
  const out = degreeWorksModule.clean(SAMPLE);
  assert.equal(out.schema, "gc-course-ledger-v1");
  assert.equal(out.sanitized.schema, "gc-course-ledger-v1");
  assert.equal(out.sanitized.catalogYear, "2023-2024");
  const codes = out.sanitized.courses.map((c) => c.code);
  assert.ok(codes.includes("GC 1040"));
  assert.ok(codes.includes("GC 2050"));
});

test("sanitized output carries no PII and no grades", () => {
  const out = degreeWorksModule.clean(SAMPLE);
  const json = JSON.stringify(out.sanitized);
  assert.ok(!json.includes("C12345678"), "student ID leaked");
  assert.ok(!json.includes("3.45"), "GPA leaked");
  assert.ok(!json.includes("John"), "name leaked");
  assert.ok(!/"grade"/i.test(json), "grade field present");
  assert.ok(!out.preview.includes("C12345678"));
});

test("warns when the catalog year is missing", () => {
  const out = degreeWorksModule.clean(SAMPLE.replace(/Catalog year: 2023-2024/, ""));
  assert.ok(out.warnings.some((w) => /Catalog year was not found/i.test(w)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/cleaner-degree-works.test.ts`
Expected: FAIL — module file does not exist.

- [ ] **Step 3: Create the module.** Create `advisor/cleaner/modules/degree-works.js` with two parts.

  (a) Copy, UNCHANGED, these pure functions from the uploaded Degree Works Cleaner (`/Users/admin/.claude/uploads/7ac30b7f-3146-4d9a-a8c7-b0ef772ad800/22b70cde-index.html`, `<script>` body lines 415–932): `parseDegreeWorks`, `extractCourseRows`, `parseCourseLine`, `extractStillNeeded`, `extractMinors`, `extractBlockStatuses`, `removePrivateLines`, `redactPrivateTokens`, `isPrivateLine`, `isNonCourseLine`, `parseSectionHeader`, `buildWarnings`, `toPublicCourse`, `makeCourseLedger`, `dedupeCourses`, `dedupeObjects`, `firstMatch`, `firstMatchGroups`, `normalizeSpaces`, `lastToken`, `stripTrailingGradeToken`, `parseBlockHeader`, `parseRequirementLabel`, `normalizeProgram`, `normalizeMajor`, `parseUnmetRequirementLabel`, `mergeRequirementLabel`, `isInvalidRequirementLabel`, `normalizeRequirementText`, `extractCourseCodes`, `requirementConfidence`, `summarizeCandidateCourses`, `isTruncatedNeededText`. These are pure string→data functions and move without edit. Do NOT copy the PDF-extraction functions (`extractPdfPages`, `groupIntoLines`, `joinRowText`) or any DOM code — those belong in the framework (Task 8).

  (b) Add, at the top of the file, and export:

```js
// Degree Works cleaner module. PURE: string in, sanitized data out. No DOM, no
// pdf.js — the framework extracts text from the PDF/paste and hands it here.
//
// Whitelist extraction: the output is BUILT from named safe fields
// (code/title/term/credits/status), so names, student IDs, GPA, advisor, and
// grades cannot appear in it by construction. This is the load-bearing privacy
// property of the cleaner.

export const degreeWorksModule = {
  id: "degree-works",
  label: "Degree Works audit",
  description:
    "Clemson Degree Works PDF \\u2192 sanitized gc-course-ledger-v1 (drops name, ID, GPA, advisor, and grades).",
  accepts: ["pdf", "text"],
  clean(rawText) {
    const text = String(rawText || "");
    // The parser reads line.text only; the framework already flattened the PDF
    // (or the pasted text) to newline-joined lines, so re-wrapping is enough.
    const lines = text.split("\n").map((t) => ({ text: t }));
    const cleanLines = removePrivateLines(lines);
    const { progress, warnings } = parseDegreeWorks(cleanLines, text, "");
    const completed = progress.courses.filter((c) => c.status === "completed").length;
    const inProgress = progress.courses.filter((c) => c.status === "in_progress").length;
    return {
      schema: "gc-course-ledger-v1",
      sanitized: makeCourseLedger(progress),
      warnings,
      metrics: [
        { label: "Catalog year", value: progress.catalogYear ?? "\\u2014" },
        { label: "Completed", value: String(completed) },
        { label: "In progress", value: String(inProgress) },
        { label: "Excess", value: String(progress.excessElectives.length) },
        { label: "Still needed", value: String(progress.requirementsRemaining.length) },
      ],
      preview: cleanLines.map((l) => l.text).join("\n"),
    };
  },
};
```

- [ ] **Step 4: Create the type declaration.** Create `advisor/cleaner/modules/degree-works.d.ts`:

```ts
export interface CleanerResult {
  schema: string;
  sanitized: {
    schema: string;
    catalogYear: string | null;
    courses: { code: string; prefix: string | null; number: string | null; title: string; term: string; credits: number; status: string }[];
    [k: string]: unknown;
  };
  warnings: string[];
  metrics: { label: string; value: string }[];
  preview: string;
}
export interface CleanerModule {
  id: string;
  label: string;
  description: string;
  accepts: ("pdf" | "text")[];
  clean(rawText: string): CleanerResult;
}
export const degreeWorksModule: CleanerModule;
```

- [ ] **Step 5: Run + typecheck + commit**

```bash
node --import tsx --test test/cleaner-degree-works.test.ts
npm run typecheck
git add advisor/cleaner/modules/degree-works.js advisor/cleaner/modules/degree-works.d.ts test/cleaner-degree-works.test.ts
git commit -m "feat(cleaner): Degree Works module -> gc-course-ledger-v1 (pure, Node-tested)"
```
Expected: PASS. (Confirm `advisor/cleaner/**` `.js` is not compiled by `tsc`; the `.d.ts` is what the test resolves.)

---

## Task 8: Cleaner framework shell + page + vendored pdf.js + auth-gated serving

**Files:**
- Create: `advisor/cleaner/index.html`, `advisor/cleaner/framework.js`
- Create (vendored, committed): `advisor/cleaner/vendor/pdfjs/pdf.mjs`, `advisor/cleaner/vendor/pdfjs/pdf.worker.mjs`
- Modify: `package.json` (devDep `pdfjs-dist@4.10.38`)
- Modify: `src/advisor-server.ts` (serve `/cleaner` + `/cleaner/*` behind auth)
- Test: `test/advisor-server.test.ts`

**Interfaces:**
- Consumes: `degreeWorksModule` (Task 7); the auth gate (Task 5); the cleaner link (Task 6).
- Produces: `GET /cleaner` → HTML (auth required); `GET /cleaner/<path>` → static assets under `advisor/cleaner/` (auth required, traversal-safe). The page imports `./vendor/pdfjs/pdf.mjs` and `./modules/degree-works.js` same-origin.

- [ ] **Step 1: Write the failing tests** — append to `test/advisor-server.test.ts`:

```ts
test("GET /cleaner requires auth", async () => {
  const { server, base } = await startTestServer();
  try { assert.equal((await fetch(base + "/cleaner")).status, 401); }
  finally { server.close(); }
});

test("GET /cleaner serves HTML to an authed session", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/cleaner", { headers: { Cookie: c } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await r.text(), /cleaner/i);
  } finally { server.close(); }
});

test("GET /cleaner/modules/degree-works.js serves JS", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/cleaner/modules/degree-works.js", { headers: { Cookie: c } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
  } finally { server.close(); }
});

test("GET /cleaner/../ traversal is refused", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/cleaner/..%2f..%2fsrc%2fadvisor-agent.ts", { headers: { Cookie: c } });
    assert.ok(r.status === 400 || r.status === 404);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-server.test.ts`
Expected: FAIL — `/cleaner` is not served (404 for the authed case).

- [ ] **Step 3: Vendor pdf.js** (committed, no CDN):

```bash
npm i -D pdfjs-dist@4.10.38
mkdir -p advisor/cleaner/vendor/pdfjs
cp node_modules/pdfjs-dist/build/pdf.mjs advisor/cleaner/vendor/pdfjs/pdf.mjs
cp node_modules/pdfjs-dist/build/pdf.worker.mjs advisor/cleaner/vendor/pdfjs/pdf.worker.mjs
git check-ignore advisor/cleaner/vendor/pdfjs/pdf.mjs   # must print nothing
```

- [ ] **Step 4: Create the framework shell.** Create `advisor/cleaner/framework.js`:

```js
// Cleaner framework shell. Source-type agnostic: handles input (PDF via pdf.js,
// or pasted text), routes the raw text to the selected cleaner MODULE, and
// renders the module's sanitized output for review + copy/download. It owns NO
// extraction logic — each module does whitelist extraction. New cleaning duties
// plug in by adding a module to MODULES; the shell is untouched.
//
// Client-side only. The raw document is parsed here; only the sanitized module
// output ever leaves this tab, by copy or download.

import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { degreeWorksModule } from "./modules/degree-works.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

const MODULES = [degreeWorksModule]; // add a module object here to add a duty

const $ = (id) => document.getElementById(id);
const els = {
  moduleSelect: $("moduleSelect"), moduleDesc: $("moduleDesc"),
  pdfInput: $("pdfInput"), pasteInput: $("pasteInput"), cleanPaste: $("cleanPaste"),
  status: $("status"), messages: $("messages"), summary: $("summary"),
  output: $("output"), preview: $("preview"),
  copyButton: $("copyButton"), downloadButton: $("downloadButton"),
};
let current = null;

const activeModule = () => MODULES.find((m) => m.id === els.moduleSelect.value) ?? MODULES[0];

function initModules() {
  for (const m of MODULES) {
    const opt = document.createElement("option");
    opt.value = m.id; opt.textContent = m.label;
    els.moduleSelect.appendChild(opt);
  }
  syncModuleUi();
  els.moduleSelect.addEventListener("change", syncModuleUi);
}
function syncModuleUi() {
  const m = activeModule();
  els.moduleDesc.textContent = m.description;
  els.pdfInput.disabled = !m.accepts.includes("pdf");
  els.pasteInput.disabled = !m.accepts.includes("text");
  els.cleanPaste.disabled = !m.accepts.includes("text");
}

async function extractPdfText(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => "str" in it && it.str.trim())
      .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5], width: it.width ?? 0 }));
    lines.push(...groupIntoLines(items));
  }
  return lines.join("\n");
}
function groupIntoLines(items) {
  const rows = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find((r) => Math.abs(r.y - item.y) <= 2.5);
    if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
    row.items.push(item);
  }
  return rows.sort((a, b) => b.y - a.y)
    .map((r) => joinRow(r.items.sort((a, b) => a.x - b.x))).filter(Boolean);
}
function joinRow(items) {
  let prev = null, text = "";
  for (const it of items) {
    if (prev) text += it.x - (prev.x + prev.width) > 8 ? "  " : " ";
    text += it.text.trim(); prev = it;
  }
  return text.replace(/\s+/g, " ").trim();
}

function run(rawText, sourceLabel) {
  reset();
  try {
    const result = activeModule().clean(rawText);
    current = result;
    els.output.value = JSON.stringify(result.sanitized, null, 2);
    els.preview.value = result.preview;
    renderSummary(result.metrics);
    renderMessages(result.warnings, "warning");
    els.copyButton.disabled = false; els.downloadButton.disabled = false;
    els.status.textContent = `Cleaned ${sourceLabel}. Review before copying.`;
  } catch (err) {
    els.status.textContent = "Could not clean this input.";
    renderMessages([err instanceof Error ? err.message : String(err)], "error");
  }
}
function renderSummary(metrics) {
  els.summary.innerHTML = "";
  for (const m of metrics) {
    const div = document.createElement("div"); div.className = "metric";
    const span = document.createElement("span"); span.textContent = m.label;
    const strong = document.createElement("strong"); strong.textContent = m.value;
    div.append(span, strong); els.summary.appendChild(div);
  }
}
function renderMessages(list, kind) {
  els.messages.innerHTML = "";
  for (const text of list) {
    const div = document.createElement("div"); div.className = "message " + kind;
    div.textContent = text; els.messages.appendChild(div);
  }
}
function reset() {
  current = null; els.output.value = ""; els.preview.value = "";
  els.summary.innerHTML = ""; els.messages.innerHTML = "";
  els.copyButton.disabled = true; els.downloadButton.disabled = true;
}

els.pdfInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  els.status.textContent = "Reading PDF\\u2026";
  try { run(await extractPdfText(await file.arrayBuffer()), file.name); }
  catch (err) {
    els.status.textContent = "Could not read this PDF.";
    renderMessages([err instanceof Error ? err.message : String(err)], "error");
  }
});
els.cleanPaste.addEventListener("click", () => {
  const text = els.pasteInput.value.trim();
  if (!text) { els.status.textContent = "Paste some text first."; return; }
  run(text, "pasted text");
});
els.copyButton.addEventListener("click", async () => {
  if (!current) return;
  await navigator.clipboard.writeText(els.output.value);
  els.status.textContent = "Sanitized output copied.";
});
els.downloadButton.addEventListener("click", () => {
  if (!current) return;
  const blob = new Blob([els.output.value + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = current.schema + ".json"; a.click();
  URL.revokeObjectURL(url);
});

initModules();
```

- [ ] **Step 5: Create the page.** Create `advisor/cleaner/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Document cleaner — advisor</title>
  <style>
    :root { color-scheme: light dark;
      --bg:#f7f7f5; --panel:#fff; --text:#1f2428; --muted:#687078; --line:#d8dadd;
      --accent:#2f6f5e; --accent-dark:#235346; --warn-bg:#fff8e6; --warn-line:#e3bd5f;
      --error-bg:#fff0f0; --error-line:#d87979;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#14171a; --panel:#1c2024; --text:#e8eaed; --muted:#9aa2ab; --line:#333a41; } }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); }
    main { width:min(1200px, calc(100vw - 32px)); margin:28px auto; }
    h1 { margin:0 0 6px; font-size:26px; font-weight:680; }
    p.lead { margin:0; color:var(--muted); line-height:1.45; }
    .privacy { margin:12px 0 0; padding:10px 12px; border-radius:8px;
      background:#e6f4ee; border:1px solid var(--accent); font-size:14px; }
    @media (prefers-color-scheme: dark) { .privacy { background:#12271f; } }
    .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center;
      padding:14px; margin:18px 0; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    label { font-weight:600; font-size:14px; }
    select, input[type=file] { font:inherit; color:var(--text); }
    button { appearance:none; border:0; border-radius:6px; padding:9px 12px;
      background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
    button:hover { background:var(--accent-dark); }
    button:disabled { cursor:not-allowed; opacity:.5; }
    button.secondary { background:#e8ece9; color:#1f2428; }
    #moduleDesc { color:var(--muted); font-size:13px; flex-basis:100%; }
    #status { color:var(--muted); font-size:14px; }
    .paste { display:grid; gap:8px; margin:14px 0; }
    .messages { display:grid; gap:8px; margin-bottom:14px; }
    .message { padding:10px 12px; border-radius:8px; font-size:14px; line-height:1.4; }
    .warning { background:var(--warn-bg); border:1px solid var(--warn-line); color:#1f2428; }
    .error { background:var(--error-bg); border:1px solid var(--error-line); color:#1f2428; }
    #summary { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
    .metric { padding:10px 12px; background:var(--panel); border:1px solid var(--line);
      border-radius:8px; min-width:120px; }
    .metric span { display:block; color:var(--muted); font-size:12px; margin-bottom:3px; }
    .metric strong { font-size:18px; font-weight:680; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    section h2 { margin:0; padding:12px 14px; border-bottom:1px solid var(--line); font-size:15px; font-weight:650; }
    textarea { display:block; width:100%; min-height:520px; resize:vertical; padding:14px;
      border:0; outline:none; background:var(--panel); color:var(--text);
      font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size:2; }
    .paste textarea { min-height:120px; }
    :focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
    @media (max-width:860px) { .grid { grid-template-columns:1fr; } textarea { min-height:340px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Document cleaner</h1>
      <p class="lead">De-identify a document before sharing it with the advisor. Choose what you are cleaning, load a PDF or paste text, review the sanitized output, then copy it into the chat.</p>
      <p class="privacy">Runs entirely in your browser. The original document is never uploaded — only the sanitized output you copy leaves this tab.</p>
    </header>

    <div class="toolbar">
      <label for="moduleSelect">Cleaning</label>
      <select id="moduleSelect" aria-describedby="moduleDesc"></select>
      <label for="pdfInput">PDF</label>
      <input id="pdfInput" type="file" accept="application/pdf">
      <button id="copyButton" type="button" disabled>Copy sanitized output</button>
      <button id="downloadButton" class="secondary" type="button" disabled>Download</button>
      <span id="status">Choose what to clean, then load a PDF or paste text.</span>
      <span id="moduleDesc"></span>
    </div>

    <div class="paste">
      <label for="pasteInput">…or paste text (e.g. a page you copied)</label>
      <textarea id="pasteInput" spellcheck="false" aria-label="Paste text to clean"></textarea>
      <div><button id="cleanPaste" type="button">Clean pasted text</button></div>
    </div>

    <div id="messages" class="messages" aria-live="polite"></div>
    <div id="summary" aria-live="polite"></div>

    <div class="grid">
      <section><h2>Sanitized output</h2>
        <textarea id="output" spellcheck="false" aria-label="Sanitized output"></textarea></section>
      <section><h2>Source preview (private lines removed)</h2>
        <textarea id="preview" spellcheck="false" aria-label="Source preview"></textarea></section>
    </div>
  </main>
  <script type="module" src="framework.js"></script>
</body>
</html>
```

- [ ] **Step 6: Serve the cleaner behind auth.** In `src/advisor-server.ts`, add `readFileSync` to the `node:fs` import (line 15 currently imports `writeFileSync`). Add near the top (after `MAX_BODY_BYTES`, ~line 50):

```ts
const CLEANER_DIR = fileURLToPath(new URL("../advisor/cleaner", import.meta.url));
const CLEANER_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Serve a static asset from advisor/cleaner behind auth; traversal-safe. */
function serveCleanerAsset(res: http.ServerResponse, relPath: string): void {
  const resolved = path.resolve(CLEANER_DIR, "." + path.posix.normalize("/" + relPath));
  if (resolved !== CLEANER_DIR && !resolved.startsWith(CLEANER_DIR + path.sep)) {
    return json(res, 400, { error: "bad path" });
  }
  const type = CLEANER_MIME[path.extname(resolved).toLowerCase()];
  if (!type) return json(res, 404, { error: "not found" });
  let body: Buffer;
  try { body = readFileSync(resolved); }
  catch { return json(res, 404, { error: "not found" }); }
  res.writeHead(200, { "Content-Type": type });
  res.end(body);
}
```

Add the routes **after** the auth gate (after `const session = active.session;`, before `/chat`):

```ts
      if (method === "GET" && url.pathname === "/cleaner") {
        return serveCleanerAsset(res, "index.html");
      }
      if (method === "GET" && url.pathname.startsWith("/cleaner/")) {
        return serveCleanerAsset(res, url.pathname.slice("/cleaner/".length));
      }
```

- [ ] **Step 7: Full suite + typecheck**

```bash
npm test && npm run typecheck
```
Expected: all green.

- [ ] **Step 8: Commit** (verify no node_modules/secrets staged; only the two vendored `.mjs` are large):

```bash
git add advisor/cleaner package.json package-lock.json src/advisor-server.ts test/advisor-server.test.ts
git status   # confirm advisor/cleaner/vendor/pdfjs/*.mjs staged, nothing under node_modules
git commit -m "feat(cleaner): extensible client-side cleaner tab (vendored pdf.js, auth-gated)"
```

---

## Task 9: Deploy + verify (advisor restart)

**Files:** none (operational).

- [ ] **Step 1: Restart the advisor**

```bash
launchctl kickstart -k gui/$(id -u)/com.cuassistant.advisor
```

- [ ] **Step 2: Verify the two-track toggle.** Sign in; banner shows **Private** at first paint. Send a question — the turn logs `mode:"private"` and a `rcd`/`spark` provider. Switch to OpenAI: the confirm is a de-identification reminder (no "conversation lost"); banner turns amber; the Private messages hide but are NOT gone. Send in OpenAI — logs `mode:"openai"` + provider `openai`. Switch back to Private: the earlier Private conversation is still visible; no reset. Confirm the log shows no Private-track turn ever used `openai`.

- [ ] **Step 3: Verify the PII gate.** In the OpenAI track, send a message containing `C12345678` → the consent dialog names the flag; **Cancel & edit** keeps the text in the box and sends nothing; **Not private — send** proceeds and logs an override with `categories:["Clemson student ID"]` (no content). A clean OpenAI message sends with no dialog. Private track: the same message sends with no dialog.

- [ ] **Step 4: Verify the cleaner.** Open "Clean a document" (new tab, same auth). Load a Degree Works PDF → sanitized `gc-course-ledger-v1` shows with no name/ID/GPA/grades, metrics populate, Copy/Download work. DevTools → Network: no CDN request; the raw PDF is never sent to the server (only `/cleaner/` asset GETs).

- [ ] **Step 5: Update the session handoff / STATE** if tracked — toggle + cleaner shipped; fp8 is the Private-track primary.

---

## Self-Review

**Spec coverage:**
- Private/OpenAI per-track chain → Tasks 1–2. `clemson_rcd_vllm` + `rcd` provider → Task 1. Two-track sessions (no reset) → Task 3. Visible banner + toggle + per-track transcript + confirm → Task 6. `/clear` active-track-only → Tasks 3+5. Default last-used per advisor → Task 5 (`lastMode`). Audit per turn → Task 2 (`mode` in the turn log). Cleaner link in both tracks → Task 6. ✅
- OpenAI PII detector: server-enforced `flagLikelyPrivate` → Task 4; `409 needsConsent` gate + override audit → Task 5; consent dialog (cancel-to-edit / send-anyway) → Task 6; structured-only, no names → Task 4. ✅
- Extensible cleaner: auth-gated tab → Task 8; vendored pdf.js (no CDN) → Task 8 Step 3; whitelist-extract module framework → Tasks 7–8; one Degree Works module (`gc-course-ledger-v1`) → Task 7; UI cleanup → Task 8 Step 5; client-side-only guarantee → Task 8. No server-side URL fetch (non-goal) honored (PDF + paste only). ✅
- Deliberate simplification: ledger-only output (no `gc-progress-v1` toggle), per "ledger is primary; derive what's-left from gc_advisor."

**Placeholder scan:** No TBD/TODO. Every code step carries complete code except the verbatim relocation of the existing working parser (Task 7 Step 3), which names exact source + functions — a relocation, not new logic.

**Type/name consistency:** `AdvisorMode` defined once in `advisor-session.ts`, imported by `advisor-agent.ts` (type-only) and `advisor-server.ts`. `MODE_CHAINS`/`advisorChainForMode` (Task 2) used in Tasks 2–3. Client layer `createClient`/`getActiveSession`/`switchActive`/`clearActive` (Task 3) consumed by Task 5. `flagLikelyPrivate` + `PrivacyFlag` (Task 4) consumed by Task 5 (`flags`, `f.category`) and rendered by Task 6 (`flags`, `f.sample`). `renderChatPage(mode)` (Task 6) called with `session.mode` (Task 5). `CleanerModule`/`CleanerResult` (Task 7 `.d.ts`) match the framework's `result.sanitized`/`metrics`/`warnings`/`preview`/`schema` (Task 8). Cookie now carries a **client id** consistently across `/login`, the auth gate, `/mode`, `/clear` (Task 5).
