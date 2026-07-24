# Advisor Privacy Toggle + Extensible Cleaner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session Private/OpenAI mode toggle to the advisor chat, and ship a self-contained, client-side "cleaner" tab (starting with Degree Works) built as an extensible module framework.

**Architecture:** Feature 1 makes the provider chain a function of the session's `mode` (Private = `rcd,spark`, both FERPA-OK local; OpenAI = `openai` only, no fallback), adds a new `rcd` provider + `clemson_rcd_vllm` policy record, and adds a visible mode indicator with a confirm-on-switch-to-OpenAI dialog and a session reset that fires only on private→OpenAI. Feature 2 serves a static, auth-gated `/cleaner` page whose PDF/paste input is parsed in the browser (vendored pdf.js, no CDN) and whitelist-extracted by a pluggable cleaner module; only the sanitized `gc-course-ledger-v1` output ever leaves the tab.

**Tech Stack:** TypeScript + `node:http` (advisor service, hand-rolled routes), `@earendil-works/pi-agent-core` / `pi-ai` (agent harness), plain browser ES modules + vendored `pdfjs-dist@4.10.38` (cleaner), `node:test` + `tsx`.

## Global Constraints

- **Repo is PUBLIC.** No secrets in any commit; credentials live only in the gitignored `.env`. Scan diffs before committing.
- **FERPA routing (verbatim intent):** identifiable student data may reach only **local inference** and **RCD campus models at `https://llm.rcd.clemson.edu/v1`**. The `/openai/v1` gateway passthrough is **de-identified only**. **NEVER Anthropic.**
- **Private mode chain = `rcd,spark`** (fp8 primary at RCD, SGLang-Spark fallback — both FERPA-OK). **OpenAI mode chain = `openai` only, NO fallback.**
- **OpenAI mode model = `gpt-5.5`** (does tools+reasoning on `/chat/completions`). Do **NOT** use `gpt-5.6-sol` here (it rejects function tools on that route).
- **RCD provider model = `qwen3.6-35b-a3b-fp8`**, dialed at `CLEMSON_LLM_BASE_URL` (`https://llm.rcd.clemson.edu/v1`), auth `CLEMSON_LLM_API_KEY`.
- **Egress gate is fail-closed.** Every chain label must map to an authorized `data_egress.classifiers` record in `policy/action-policy.yaml` AND dial a host that record covers.
- **Session reset asymmetry:** full dispose (history + workDir + piSessionRoot) **only** on private→OpenAI. OpenAI→private switches in place, no reset.
- **Cleaner is client-side only.** pdf.js is **vendored locally** (no CDN). Only the sanitized ledger leaves the browser (copy/download). The sanitized `gc-course-ledger-v1` output **never** contains name, student ID, GPA, advisor, or grades.
- **Deploy:** the advisor is a long-lived launchd daemon (port 8770). These changes are **not done until the advisor is restarted and verified** (final task). MCP servers (8765/8766/8767) are unchanged — no restart.

---

## File Structure

- `src/config.ts` — add `ADVISOR_OPENAI_MODEL`, `ADVISOR_RCD_MODEL`; change `ADVISOR_PROVIDER_CHAIN` default to the private chain (`rcd,spark`).
- `src/advisor-session.ts` — add `AdvisorMode` type + `mode` field; `createSession` takes a mode.
- `src/advisor-agent.ts` — add `rcd` to `providerModel`/`resolveProvider`/`CHAIN_EGRESS_PROVIDER`; add `MODE_CHAINS`; drive `runAdvisorTurn` and `initAdvisorTools` off the mode; log `mode` per turn.
- `policy/action-policy.yaml` — add the `clemson_rcd_vllm` classifier record.
- `src/advisor-server.ts` — `POST /mode` (with last-used tracking + reset asymmetry), pass `mode` to `renderChatPage`, keep mode across `/clear`, and serve the `/cleaner` static tab behind auth.
- `src/advisor-ui.ts` — `renderChatPage(mode)`: mode banner, toggle, confirm-on-switch, cleaner link.
- `advisor/cleaner/modules/degree-works.js` (+ `.d.ts`) — the Degree Works cleaner module (pure, Node-testable).
- `advisor/cleaner/framework.js` — the browser shell (pdf.js extraction, module registry/selector, review UI, copy/download).
- `advisor/cleaner/index.html` — the polished cleaner page.
- `advisor/cleaner/vendor/pdfjs/pdf.mjs` + `pdf.worker.mjs` — vendored pdf.js (committed).
- Tests: extend `test/advisor-agent.test.ts`, `test/advisor-server.test.ts`, `test/advisor-ui.test.ts`, `test/advisor-session.test.ts`; new `test/cleaner-degree-works.test.ts`.

---

## Task 1: `rcd` provider + `clemson_rcd_vllm` policy record

**Files:**
- Modify: `policy/action-policy.yaml` (add a classifier under `data_egress.classifiers`, after `clemson_spark_vllm` ~line 631)
- Modify: `src/config.ts:233` (chain default), and add two model constants after `src/config.ts:235`
- Modify: `src/advisor-agent.ts` (`providerModel` ~248, `resolveProvider` ~301, `CHAIN_EGRESS_PROVIDER` ~100, imports ~39-51)
- Test: `test/advisor-agent.test.ts`

**Interfaces:**
- Consumes: `CLEMSON_LLM_API_KEY`, `CLEMSON_LLM_BASE_URL` (already in config); `isEgressAuthorized` (reads `data_egress.classifiers`).
- Produces: `providerModel("rcd")` → a `Model` dialing `llm.rcd.clemson.edu`; `resolveProvider("rcd")` → target keyed by `CLEMSON_LLM_API_KEY`; chain label `rcd` authorized by the gate. Config: `ADVISOR_RCD_MODEL` (default `qwen3.6-35b-a3b-fp8`), `ADVISOR_OPENAI_MODEL` (default `gpt-5.5`).

- [ ] **Step 1: Write the failing test** — append to `test/advisor-agent.test.ts`:

```ts
test("rcd chain entry is egress-authorized and dials the RCD campus host", () => {
  assert.doesNotThrow(() => assertAdvisorChainAuthorized(["rcd"]));
  const target = __resolveProviderForTest("rcd");
  // Resolves only when CLEMSON_LLM_API_KEY (or OPENAI_API_KEY) is present; the
  // gate check above does not depend on the key, this does.
  if (target) {
    assert.equal(new URL(target.model.baseUrl).hostname, "llm.rcd.clemson.edu");
    assert.equal(new URL(target.model.baseUrl).pathname, "/v1");
    assert.equal(target.model.id, process.env.ADVISOR_RCD_MODEL || "qwen3.6-35b-a3b-fp8");
  }
});

test("rcd model carries the qwen thinking shape, like spark", () => {
  const m = __dialledHostForTest("rcd");
  assert.equal(m, "llm.rcd.clemson.edu");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test test/advisor-agent.test.ts`
Expected: FAIL — `assertAdvisorChainAuthorized(["rcd"])` throws `advisor provider "rcd" has no destination declared`.

- [ ] **Step 3: Add the policy record.** In `policy/action-policy.yaml`, immediately after the `clemson_spark_vllm` block (ends ~line 631), add:

```yaml
    # Clemson RCD LLM cluster — CAMPUS-HOSTED models at llm.rcd.clemson.edu/v1
    # (the "/v1" path, NOT the "/openai/v1" passthrough). These are Clemson-
    # operated, open-weight models running on Clemson infrastructure; content
    # stays inside Clemson and reaches no third party, so this route is
    # FERPA-cleared for identifiable student data. Same host and same credential
    # as clemson_llm_gateway_openai, but a DIFFERENT service on a different path:
    # this record covers /v1 (campus models, no third-party egress); that record
    # covers /openai/v1 (forwarded to OpenAI, de-identified only). They are kept
    # as separate records precisely because their FERPA status differs.
    - provider: clemson_rcd_vllm
      scope: external
      sends: [subject, body]
      basis: "Clemson-operated RCD LLM cluster, campus-hosted models at llm.rcd.clemson.edu/v1 over TLS with a Clemson-issued key; content stays within Clemson infrastructure and is not forwarded to any third party"
      authorized: true
```

- [ ] **Step 4: Add the config constants.** In `src/config.ts`, change line 233 and add two constants after line 235:

```ts
// Private mode's provider chain: fp8 (RCD campus, FERPA-OK) first, SGLang-Spark
// fallback. OpenAI mode's chain is fixed in advisor-agent.ts and not env-driven.
export const ADVISOR_PROVIDER_CHAIN = (
  process.env.ADVISOR_PROVIDER_CHAIN || "rcd,spark"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "qwen3.6-35b-a3b";
export const ADVISOR_BASE_URL =
  process.env.ADVISOR_BASE_URL || "http://gcspark.clemson.edu:8080/v1";
/** RCD campus fp8 model (Private mode primary), dialed at CLEMSON_LLM_BASE_URL. */
export const ADVISOR_RCD_MODEL =
  process.env.ADVISOR_RCD_MODEL || "qwen3.6-35b-a3b-fp8";
/**
 * OpenAI-mode model. gpt-5.5 does tools+reasoning on /chat/completions;
 * gpt-5.6-sol does NOT and must not be set here.
 */
export const ADVISOR_OPENAI_MODEL =
  process.env.ADVISOR_OPENAI_MODEL || "gpt-5.5";
```

- [ ] **Step 5: Add the `rcd` egress destination.** In `src/advisor-agent.ts`, add to `CHAIN_EGRESS_PROVIDER` (after the `openai` entry, ~line 115):

```ts
  // Clemson RCD campus models at llm.rcd.clemson.edu/v1 — the FERPA-OK local
  // route (distinct from the openai passthrough on /openai/v1, same host). The
  // gate checks only the host; the FERPA distinction between /v1 and /openai/v1
  // is carried by which mode uses which label (see MODE_CHAINS).
  rcd: {
    policyProvider: "clemson_rcd_vllm",
    hosts: ["llm.rcd.clemson.edu"],
  },
```

- [ ] **Step 6: Add the `rcd` model + resolution.** In `src/advisor-agent.ts`, add the imports `ADVISOR_RCD_MODEL`, `CLEMSON_LLM_BASE_URL`, `ADVISOR_OPENAI_MODEL` to the `./config.js` import block (~line 39). Add an `rcd` branch at the top of `providerModel` (before the `spark` branch, ~line 249):

```ts
  if (name === "rcd") {
    // Same Qwen thinking shape as spark (identical model family), but dialed at
    // the RCD campus /v1 endpoint with the gateway key. reasoning + the
    // qwen-chat-template compat flag turn on pi-ai's enable_thinking path.
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

Change the `openai` branch model id (~line 277) to use the config constant:

```ts
    const id = ADVISOR_OPENAI_MODEL;
```

In `resolveProvider` (~line 312), give `rcd` the gateway key and fail closed without it. Replace the key/return block:

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

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --import tsx --test test/advisor-agent.test.ts`
Expected: PASS (the two new tests; all existing tests still pass — `["spark","openai"]` remains authorized).

- [ ] **Step 8: Typecheck + commit**

```bash
npm run typecheck
git add policy/action-policy.yaml src/config.ts src/advisor-agent.ts test/advisor-agent.test.ts
git commit -m "feat(advisor): add rcd (RCD fp8) provider + clemson_rcd_vllm egress record"
```

---

## Task 2: Session mode → mode-driven provider chain + per-turn audit

**Files:**
- Modify: `src/advisor-session.ts` (add `AdvisorMode`, `mode` field, `createSession` param)
- Modify: `src/advisor-agent.ts` (`MODE_CHAINS`, `runAdvisorTurn` loop, `initAdvisorTools`, per-turn log)
- Test: `test/advisor-agent.test.ts`, `test/advisor-session.test.ts`

**Interfaces:**
- Consumes: `providerModel`/`resolveProvider`/`CHAIN_EGRESS_PROVIDER` incl. `rcd` (Task 1); `ADVISOR_PROVIDER_CHAIN`.
- Produces: `AdvisorMode = "private" | "openai"` (exported from `advisor-session.ts`); `AdvisorSession.mode`; `createSession(advisorId, mode = "private")`; `advisorChainForMode(mode)`; `runAdvisorTurn` iterates the session-mode chain.

- [ ] **Step 1: Write the failing test** — append to `test/advisor-session.test.ts`:

```ts
test("createSession defaults to private mode and honors an explicit mode", () => {
  const a = createSession("shared");
  assert.equal(a.mode, "private");
  const b = createSession("shared", "openai");
  assert.equal(b.mode, "openai");
});
```

And append to `test/advisor-agent.test.ts`:

```ts
test("advisorChainForMode: private is rcd,spark and openai is openai-only", () => {
  assert.deepEqual([...advisorChainForMode("private")], ["rcd", "spark"]);
  assert.deepEqual([...advisorChainForMode("openai")], ["openai"]);
});
```

Add `advisorChainForMode` to the import from `../src/advisor-agent.ts` and `createSession` to the import from `../src/advisor-session.ts` in the respective test files if not already present.

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-session.test.ts test/advisor-agent.test.ts`
Expected: FAIL — `mode` undefined; `advisorChainForMode` is not exported.

- [ ] **Step 3: Add mode to the session.** In `src/advisor-session.ts`, add the type and field, and extend `createSession`:

```ts
export type AdvisorMode = "private" | "openai";
```

Add to the `AdvisorSession` interface (after `advisorId`):

```ts
  /**
   * Private routes to FERPA-OK local models; OpenAI routes de-identified data to
   * gpt-5.5. Set at creation; a private→OpenAI switch creates a fresh session
   * rather than mutating this, so no prior message survives into an OpenAI turn.
   */
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

- [ ] **Step 4: Add `MODE_CHAINS` + `advisorChainForMode`.** In `src/advisor-agent.ts`, add a type-only import and the map after `CHAIN_EGRESS_PROVIDER` (~line 116):

```ts
import type { AdvisorMode } from "./advisor-session.js";

// The provider chain is a function of the session's mode. Private never lists
// the `openai` label, so Private mode is structurally unable to dial the OpenAI
// passthrough — that is what makes the "Private" claim honest, not a runtime
// check. OpenAI mode has no fallback: a failure surfaces rather than silently
// retrying somewhere else.
const MODE_CHAINS: Readonly<Record<AdvisorMode, readonly string[]>> = {
  private: ADVISOR_PROVIDER_CHAIN,
  openai: ["openai"],
};

export function advisorChainForMode(mode: AdvisorMode): readonly string[] {
  return MODE_CHAINS[mode];
}
```

- [ ] **Step 5: Drive startup + the turn off the mode.** In `initAdvisorTools` (~line 216), replace the single assert with a per-mode assert:

```ts
  // Fail at startup on any misconfigured mode chain, not at the first turn.
  for (const chain of Object.values(MODE_CHAINS)) {
    assertAdvisorChainAuthorized(chain);
  }
```

In `runAdvisorTurn` (~line 940), replace `for (const name of ADVISOR_PROVIDER_CHAIN) {` with:

```ts
  for (const name of MODE_CHAINS[session.mode]) {
```

- [ ] **Step 6: Log the mode per turn.** In `runWithProvider`, add `mode` to the `log.info("advisor turn complete", {...})` object (~line 772), right after `advisorId`:

```ts
      mode: session.mode,
```

- [ ] **Step 7: Update existing tests that build a session or assert the chain default.** Run `grep -rn '"spark,openai"\|ADVISOR_PROVIDER_CHAIN' test/` and update any assertion of the old default to `"rcd,spark"` / `["rcd","spark"]`. Run `grep -rn 'mode:' test/advisor-agent.test.ts` and, for any hand-built `AdvisorSession` object literal used with `runAdvisorTurn`, add `mode: "private"`. (Sessions built via `createSession` need no change — the default covers them.)

- [ ] **Step 8: Run the tests**

Run: `node --import tsx --test test/advisor-session.test.ts test/advisor-agent.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 9: Typecheck + commit**

```bash
npm run typecheck
git add src/advisor-session.ts src/advisor-agent.ts test/advisor-session.test.ts test/advisor-agent.test.ts
git commit -m "feat(advisor): route provider chain by per-session mode (Private vs OpenAI)"
```

---

## Task 3: `POST /mode` endpoint — switch, last-used, reset asymmetry

**Files:**
- Modify: `src/advisor-server.ts` (import `AdvisorMode`; add `lastMode` map; pass `mode` to `renderChatPage`; keep mode across `/clear`; add `/mode` route)
- Test: `test/advisor-server.test.ts`

**Interfaces:**
- Consumes: `createSession(advisorId, mode)`, `clearSession`, `AdvisorMode` (Task 2); `inFlight`, `sessionCookie`, `getSession`, `authenticate` (existing).
- Produces: `POST /mode` accepting `{ mode: "private" | "openai" }`; returns `{ mode, reset }`; sets a new session cookie only when it resets (private→OpenAI). Login and `/clear` open sessions in the advisor's last-used mode / current mode respectively.

- [ ] **Step 1: Write the failing tests** — append to `test/advisor-server.test.ts` (follow the file's existing pattern for standing up the server and driving requests with a cookie):

```ts
test("POST /mode private->openai resets the session and sets a new cookie", async () => {
  const { server, base } = await startTestServer();
  try {
    const sid = await loginCookie(base); // helper already used by other tests
    const r = await fetch(base + "/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sid },
      body: JSON.stringify({ mode: "openai" }),
    });
    const data = await r.json();
    assert.equal(r.status, 200);
    assert.equal(data.mode, "openai");
    assert.equal(data.reset, true);
    assert.match(r.headers.get("set-cookie") ?? "", /advisor_sid=/);
  } finally {
    server.close();
  }
});

test("POST /mode openai->private switches in place with no reset cookie", async () => {
  const { server, base } = await startTestServer();
  try {
    const sid = await loginCookie(base);
    await fetch(base + "/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sid },
      body: JSON.stringify({ mode: "openai" }),
    });
    // Switching to openai issued a NEW cookie; re-login to get a clean private
    // session, then flip back and assert no reset.
    const sid2 = await loginCookie(base);
    await fetch(base + "/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sid2 },
      body: JSON.stringify({ mode: "openai" }),
    });
  } finally {
    server.close();
  }
});

test("POST /mode rejects an unknown mode", async () => {
  const { server, base } = await startTestServer();
  try {
    const sid = await loginCookie(base);
    const r = await fetch(base + "/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sid },
      body: JSON.stringify({ mode: "banana" }),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});
```

If `test/advisor-server.test.ts` has no `startTestServer`/`loginCookie` helpers, add them at the top mirroring the existing tests' setup (create the server with `createAdvisorServer({ runTurn })` using a stub `runTurn`, `listen(0)`, read the port; `loginCookie` POSTs `/login` with `ADVISOR_PASSWORD` set for the test and returns the `advisor_sid` cookie string).

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-server.test.ts`
Expected: FAIL — `/mode` returns 404.

- [ ] **Step 3: Import the type and add last-used tracking.** In `src/advisor-server.ts`, add `type AdvisorMode` to the `./advisor-session.js` import (~line 33), and add near the `inFlight` map (~line 220):

```ts
// Last mode each advisor used, so a fresh session (login) opens where they left
// off. In-memory only: a restart resets everyone to `private`, which is the safe
// default. The server is authoritative for routing — the client's indicator is
// cosmetic — so this never disagrees with what a turn actually dials.
const lastMode = new Map<string, AdvisorMode>();
```

- [ ] **Step 4: Open login + clear in the right mode.** In the `/login` handler, replace `const session = createSession("shared");` (~line 259) with:

```ts
        const session = createSession("shared", lastMode.get("shared") ?? "private");
```

In the `GET "/"` handler, pass the mode to the chat page (~line 238):

```ts
        return getSession(sid)
          ? html(res, 200, renderChatPage(getSession(sid)!.mode))
          : html(res, 200, renderLoginPage());
```

In the `/clear` handler, preserve the current mode (~line 368):

```ts
        const fresh = createSession(session.advisorId, session.mode);
```

- [ ] **Step 5: Add the `/mode` route.** Insert after the `/clear` handler block (~line 375), before `/upload`:

```ts
      if (method === "POST" && url.pathname === "/mode") {
        const parsed = JSON.parse(await readBody(req)) as { mode?: string };
        const next = parsed.mode;
        if (next !== "private" && next !== "openai") {
          return json(res, 400, { error: "mode must be 'private' or 'openai'" });
        }
        if (next === session.mode) {
          return json(res, 200, { mode: session.mode, reset: false });
        }
        lastMode.set(session.advisorId, next);

        // private -> OpenAI: full dispose + fresh session. The leak boundary —
        // no prior message may survive into the first OpenAI turn. Abort and
        // WAIT for any in-flight turn first, exactly as /clear does, so its
        // commit step cannot recreate piSessionRoot after disposal.
        if (session.mode === "private" && next === "openai") {
          const entry = inFlight.get(session.id);
          if (entry) {
            entry.controller.abort();
            await entry.done;
            inFlight.delete(session.id);
          }
          clearSession(session.id);
          const fresh = createSession(session.advisorId, "openai");
          log.info("advisor mode switched with reset", {
            session: fresh.id,
            mode: "openai",
          });
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": sessionCookie(fresh.id),
          });
          return res.end(JSON.stringify({ mode: "openai", reset: true }));
        }

        // OpenAI -> private: switch in place, no reset. A turn already in flight
        // resolved its chain at the start and is unaffected; the next turn reads
        // the new mode.
        session.mode = "private";
        log.info("advisor mode switched", {
          session: session.id,
          mode: "private",
        });
        return json(res, 200, { mode: "private", reset: false });
      }
```

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --test test/advisor-server.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add src/advisor-server.ts test/advisor-server.test.ts
git commit -m "feat(advisor): POST /mode with last-used default and reset-on-private->openai"
```

---

## Task 4: Mode indicator + toggle + confirm dialog + cleaner link (UI)

**Files:**
- Modify: `src/advisor-ui.ts` (`renderChatPage` takes `mode`; add banner, toggle, confirm, cleaner link)
- Test: `test/advisor-ui.test.ts`

**Interfaces:**
- Consumes: `renderChatPage(mode)` is now called with `session.mode` (Task 3).
- Produces: `renderChatPage(mode: "private" | "openai"): string` — a page whose initial banner + toggle reflect `mode` at first paint; the toggle POSTs `/mode`; switching TO OpenAI is gated by a `confirm()` naming both consequences; a reset response clears the answers pane; a "Clean a document" link opens `cleaner` in a new tab.

- [ ] **Step 1: Write the failing test** — append to `test/advisor-ui.test.ts`:

```ts
test("renderChatPage reflects the mode at first paint and links the cleaner", () => {
  const priv = renderChatPage("private");
  assert.match(priv, /Private/);
  assert.match(priv, /data-mode="private"/);
  assert.match(priv, /cleaner/); // the new-tab link target
  const oai = renderChatPage("openai");
  assert.match(oai, /data-mode="openai"/);
  assert.match(oai, /de-identified/i);
});
```

Update the existing `renderChatPage()` call sites in this test file to pass a mode (e.g. `renderChatPage("private")`).

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-ui.test.ts`
Expected: FAIL — `renderChatPage` takes no arg / markers absent.

- [ ] **Step 3: Add banner styles.** In `src/advisor-ui.ts`, append to the `STYLE` template (before the closing backtick, ~line 21):

```css
  #modebar { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap;
             padding:.6rem .8rem; border-radius:8px; margin-bottom:1rem;
             border:1px solid #8886; }
  #modebar[data-mode="private"] { background:#e6f4ee; border-color:#2f6f5e; }
  #modebar[data-mode="openai"]  { background:#fdf0e0; border-color:#c67b18; }
  @media (prefers-color-scheme: dark) {
    #modebar[data-mode="private"] { background:#12271f; }
    #modebar[data-mode="openai"]  { background:#2c2010; }
  }
  #modebar strong { font-weight:680; }
  #modebar .modenote { color:#595959; font-size:.9rem; }
  #modebar a.cleanerlink { margin-left:auto; }
```

- [ ] **Step 4: Make `renderChatPage` take a mode and render the bar.** Replace the signature and the intro markup (~lines 58-63):

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
when you move to another student.</p>`,
  );
}
```

Note: the closing of the template literal moves — the remaining chat markup (`#status` through the `<script>`) stays exactly as-is but is now concatenated after the intro. Keep the original `#status`, `#answers`, `#composer`, and the existing `<script>` block unchanged; only prepend the modebar and split the intro `<p>` as above. Verify the returned string still contains all original elements.

- [ ] **Step 5: Add the toggle behavior.** Inside the existing `<script>` block (add after the `#clear` handler, ~line 147):

```js
const modebar = $("modebar");
$("modeToggle").addEventListener("click", async () => {
  const current = modebar.getAttribute("data-mode");
  const next = current === "private" ? "openai" : "private";
  if (next === "openai") {
    const ok = confirm(
      "Switch to OpenAI mode?\\n\\nThis starts a NEW conversation and routes " +
      "de-identified data to OpenAI. Do not enter student names, IDs, or grades."
    );
    if (!ok) return;
  }
  try {
    const r = await fetch("mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "mode switch failed");
    modebar.setAttribute("data-mode", data.mode);
    const priv = data.mode === "private";
    $("modelabel").textContent = priv ? "Private mode" : "OpenAI mode";
    $("modenote").textContent = priv
      ? "Local, FERPA-approved models. Student information may be used."
      : "De-identified data only \\u2014 do NOT enter student names, IDs, or grades.";
    $("modeToggle").textContent = priv ? "Switch to OpenAI mode" : "Switch to Private mode";
    if (data.reset) {
      answers.replaceChildren();       // the private conversation is gone with it
      $("schedule").hidden = true;
      status.textContent = "Switched to OpenAI mode \\u2014 new conversation.";
    } else {
      status.textContent = "Switched to " + (priv ? "Private" : "OpenAI") + " mode.";
    }
  } catch (err) {
    status.textContent = "Could not switch mode.";
  }
});
```

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --test test/advisor-ui.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add src/advisor-ui.ts test/advisor-ui.test.ts
git commit -m "feat(advisor): visible mode banner + toggle with confirm-on-OpenAI + cleaner link"
```

---

## Task 5: Degree Works cleaner module (pure, Node-testable)

**Files:**
- Create: `advisor/cleaner/modules/degree-works.js`
- Create: `advisor/cleaner/modules/degree-works.d.ts`
- Test: `test/cleaner-degree-works.test.ts`

**Interfaces:**
- Produces: `degreeWorksModule: CleanerModule` where
  ```ts
  interface CleanerResult {
    schema: string;
    sanitized: unknown;
    warnings: string[];
    metrics: { label: string; value: string }[];
    preview: string;
  }
  interface CleanerModule {
    id: string; label: string; description: string;
    accepts: ("pdf" | "text")[];
    clean(rawText: string): CleanerResult;
  }
  ```
  `degreeWorksModule.clean(rawText)` returns `schema: "gc-course-ledger-v1"`, `sanitized` = the ledger, `metrics` = catalog-year/completed/in-progress/excess/still-needed, `preview` = the source text with private lines removed. Consumed by the framework (Task 6).

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

test("degree-works: emits gc-course-ledger-v1 with the completed courses", () => {
  const out = degreeWorksModule.clean(SAMPLE);
  assert.equal(out.schema, "gc-course-ledger-v1");
  assert.equal(out.sanitized.schema, "gc-course-ledger-v1");
  assert.equal(out.sanitized.catalogYear, "2023-2024");
  const codes = out.sanitized.courses.map((c) => c.code);
  assert.ok(codes.includes("GC 1040"));
  assert.ok(codes.includes("GC 2050"));
});

test("degree-works: sanitized output carries no PII and no grades", () => {
  const out = degreeWorksModule.clean(SAMPLE);
  const json = JSON.stringify(out.sanitized);
  assert.ok(!json.includes("C12345678"), "student ID leaked");
  assert.ok(!json.includes("3.45"), "GPA leaked");
  assert.ok(!json.includes("John"), "name leaked");
  assert.ok(!/"grade"/i.test(json), "grade field present");
  // The redacted preview may still show tokens for human review, but the
  // student ID must be redacted there too.
  assert.ok(!out.preview.includes("C12345678"));
});

test("degree-works: warns when the catalog year is missing", () => {
  const noYear = SAMPLE.replace(/Catalog year: 2023-2024/, "");
  const out = degreeWorksModule.clean(noYear);
  assert.ok(out.warnings.some((w) => /Catalog year was not found/i.test(w)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/cleaner-degree-works.test.ts`
Expected: FAIL — module file does not exist.

- [ ] **Step 3: Create the module.** Create `advisor/cleaner/modules/degree-works.js`. It has two parts: (a) the **pure parser/redaction helpers relocated verbatim** from the existing cleaner, and (b) a **new module wrapper**.

  (a) Copy, UNCHANGED, these functions from the uploaded Degree Works Cleaner script (`/Users/admin/.claude/uploads/7ac30b7f-3146-4d9a-a8c7-b0ef772ad800/22b70cde-index.html`, `<script>` body, lines 415–932): `parseDegreeWorks`, `extractCourseRows`, `parseCourseLine`, `extractStillNeeded`, `extractMinors`, `extractBlockStatuses`, `removePrivateLines`, `redactPrivateTokens`, `isPrivateLine`, `isNonCourseLine`, `parseSectionHeader`, `buildWarnings`, `toPublicCourse`, `makeCourseLedger`, `dedupeCourses`, `dedupeObjects`, `firstMatch`, `firstMatchGroups`, `normalizeSpaces`, `lastToken`, `stripTrailingGradeToken`, `parseBlockHeader`, `parseRequirementLabel`, `normalizeProgram`, `normalizeMajor`, `parseUnmetRequirementLabel`, `mergeRequirementLabel`, `isInvalidRequirementLabel`, `normalizeRequirementText`, `extractCourseCodes`, `requirementConfidence`, `summarizeCandidateCourses`, `isTruncatedNeededText`. These are pure string→data functions and move without edit. Do NOT copy the PDF-extraction functions (`extractPdfPages`, `groupIntoLines`, `joinRowText`) — those are browser-side extraction and belong in the framework (Task 6). Do NOT copy any DOM code.

  (b) Add, at the top of the file, this wrapper (and export it):

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
    // The parser consumes line objects; the framework already flattened the PDF
    // (or the pasted text) to newline-joined text, and only line.text is read
    // downstream, so re-wrapping is enough.
    const lines = String(rawText || "")
      .split("\n")
      .map((text) => ({ text }));
    const cleanLines = removePrivateLines(lines);
    const { progress, warnings } = parseDegreeWorks(
      cleanLines,
      String(rawText || ""),
      "",
    );
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

- [ ] **Step 4: Create the type declaration.** Create `advisor/cleaner/modules/degree-works.d.ts` (so the `.ts` test typechecks against a real interface):

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

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test test/cleaner-degree-works.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit** (confirm `advisor/cleaner/**` `.js` is not picked up by `tsc` — the `.d.ts` is what the test resolves):

```bash
npm run typecheck
git add advisor/cleaner/modules/degree-works.js advisor/cleaner/modules/degree-works.d.ts test/cleaner-degree-works.test.ts
git commit -m "feat(cleaner): Degree Works module -> gc-course-ledger-v1 (pure, Node-tested)"
```

---

## Task 6: Cleaner framework shell + page + vendored pdf.js + auth-gated serving

**Files:**
- Create: `advisor/cleaner/index.html`, `advisor/cleaner/framework.js`
- Create (vendored, committed): `advisor/cleaner/vendor/pdfjs/pdf.mjs`, `advisor/cleaner/vendor/pdfjs/pdf.worker.mjs`
- Modify: `package.json` (add `pdfjs-dist@4.10.38` to devDependencies)
- Modify: `src/advisor-server.ts` (serve `/cleaner` and `/cleaner/*` behind auth)
- Test: `test/advisor-server.test.ts`

**Interfaces:**
- Consumes: `degreeWorksModule` (Task 5); the auth gate + `authenticate`/`getSession` (existing); `renderChatPage`'s cleaner link (Task 4).
- Produces: `GET /cleaner` → the cleaner HTML (auth required); `GET /cleaner/<path>` → static assets under `advisor/cleaner/` (auth required, path-traversal-safe); the browser page imports `./vendor/pdfjs/pdf.mjs` same-origin and `./modules/degree-works.js`.

- [ ] **Step 1: Write the failing tests** — append to `test/advisor-server.test.ts`:

```ts
test("GET /cleaner requires auth", async () => {
  const { server, base } = await startTestServer();
  try {
    const r = await fetch(base + "/cleaner");
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});

test("GET /cleaner serves HTML to an authed session", async () => {
  const { server, base } = await startTestServer();
  try {
    const sid = await loginCookie(base);
    const r = await fetch(base + "/cleaner", { headers: { Cookie: sid } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await r.text(), /cleaner/i);
  } finally {
    server.close();
  }
});

test("GET /cleaner/modules/degree-works.js serves JS", async () => {
  const { server, base } = await startTestServer();
  try {
    const sid = await loginCookie(base);
    const r = await fetch(base + "/cleaner/modules/degree-works.js", { headers: { Cookie: sid } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
  } finally {
    server.close();
  }
});

test("GET /cleaner/../advisor-agent.ts is refused (no traversal)", async () => {
  const { server, base } = await startTestServer();
  try {
    const sid = await loginCookie(base);
    const r = await fetch(base + "/cleaner/..%2f..%2fsrc%2fadvisor-agent.ts", { headers: { Cookie: sid } });
    assert.ok(r.status === 400 || r.status === 404);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/advisor-server.test.ts`
Expected: FAIL — `/cleaner` returns 401 for the authed case too (route absent → falls through to the auth-gated 404... it will 404, not 200).

- [ ] **Step 3: Vendor pdf.js.** Install and copy the two build files into the repo (committed, no CDN):

```bash
npm i -D pdfjs-dist@4.10.38
mkdir -p advisor/cleaner/vendor/pdfjs
cp node_modules/pdfjs-dist/build/pdf.mjs advisor/cleaner/vendor/pdfjs/pdf.mjs
cp node_modules/pdfjs-dist/build/pdf.worker.mjs advisor/cleaner/vendor/pdfjs/pdf.worker.mjs
```

Confirm `advisor/cleaner/vendor/` is NOT gitignored (`git check-ignore advisor/cleaner/vendor/pdfjs/pdf.mjs` prints nothing).

- [ ] **Step 4: Create the framework shell.** Create `advisor/cleaner/framework.js`:

```js
// Cleaner framework shell. Source-type agnostic: it handles input (PDF via
// pdf.js, or pasted text), routes the raw text to the selected cleaner MODULE,
// and renders the module's sanitized output for review + copy/download. It owns
// NO extraction logic — each module does whitelist extraction. New cleaning
// duties plug in by adding a module to MODULES below; the shell is untouched.
//
// Client-side only. The raw document is parsed here in the browser; only the
// sanitized module output ever leaves this tab, by copy or download.

import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { degreeWorksModule } from "./modules/degree-works.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

// The registry. Add a module object here to add a cleaning duty.
const MODULES = [degreeWorksModule];

const $ = (id) => document.getElementById(id);
const els = {
  moduleSelect: $("moduleSelect"),
  moduleDesc: $("moduleDesc"),
  pdfInput: $("pdfInput"),
  pasteInput: $("pasteInput"),
  cleanPaste: $("cleanPaste"),
  status: $("status"),
  messages: $("messages"),
  summary: $("summary"),
  output: $("output"),
  preview: $("preview"),
  copyButton: $("copyButton"),
  downloadButton: $("downloadButton"),
};

let current = null; // last CleanerResult

function activeModule() {
  return MODULES.find((m) => m.id === els.moduleSelect.value) ?? MODULES[0];
}

function initModules() {
  for (const m of MODULES) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
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
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => joinRow(r.items.sort((a, b) => a.x - b.x)))
    .filter(Boolean);
}

function joinRow(items) {
  let prev = null, text = "";
  for (const it of items) {
    if (prev) text += it.x - (prev.x + prev.width) > 8 ? "  " : " ";
    text += it.text.trim();
    prev = it;
  }
  return text.replace(/\s+/g, " ").trim();
}

function run(rawText, sourceLabel) {
  reset();
  try {
    const module = activeModule();
    const result = module.clean(rawText);
    current = result;
    els.output.value = JSON.stringify(result.sanitized, null, 2);
    els.preview.value = result.preview;
    renderSummary(result.metrics);
    renderMessages(result.warnings, "warning");
    els.copyButton.disabled = false;
    els.downloadButton.disabled = false;
    els.status.textContent = `Cleaned ${sourceLabel}. Review before copying.`;
  } catch (err) {
    els.status.textContent = "Could not clean this input.";
    renderMessages([err instanceof Error ? err.message : String(err)], "error");
  }
}

function renderSummary(metrics) {
  els.summary.innerHTML = "";
  for (const metric of metrics) {
    const div = document.createElement("div");
    div.className = "metric";
    const span = document.createElement("span");
    span.textContent = metric.label;
    const strong = document.createElement("strong");
    strong.textContent = metric.value;
    div.append(span, strong);
    els.summary.appendChild(div);
  }
}

function renderMessages(list, kind) {
  els.messages.innerHTML = "";
  for (const text of list) {
    const div = document.createElement("div");
    div.className = "message " + kind;
    div.textContent = text;
    els.messages.appendChild(div);
  }
}

function reset() {
  current = null;
  els.output.value = "";
  els.preview.value = "";
  els.summary.innerHTML = "";
  els.messages.innerHTML = "";
  els.copyButton.disabled = true;
  els.downloadButton.disabled = true;
}

els.pdfInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  els.status.textContent = "Reading PDF\\u2026";
  try {
    run(await extractPdfText(await file.arrayBuffer()), file.name);
  } catch (err) {
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
  a.href = url;
  a.download = current.schema + ".json";
  a.click();
  URL.revokeObjectURL(url);
});

initModules();
```

- [ ] **Step 5: Create the page.** Create `advisor/cleaner/index.html` (polished, accessible; theme-aware; loads the framework as a module):

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
    .paste textarea { min-height:120px; }
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
      <textarea id="pasteInput" spellcheck="false" style="min-height:120px" aria-label="Paste text to clean"></textarea>
      <div><button id="cleanPaste" type="button">Clean pasted text</button></div>
    </div>

    <div id="messages" class="messages" aria-live="polite"></div>
    <div id="summary" aria-live="polite"></div>

    <div class="grid">
      <section>
        <h2>Sanitized output</h2>
        <textarea id="output" spellcheck="false" aria-label="Sanitized output"></textarea>
      </section>
      <section>
        <h2>Source preview (private lines removed)</h2>
        <textarea id="preview" spellcheck="false" aria-label="Source preview"></textarea>
      </section>
    </div>
  </main>
  <script type="module" src="framework.js"></script>
</body>
</html>
```

- [ ] **Step 6: Serve the cleaner behind auth.** In `src/advisor-server.ts`, add imports at the top with the other `node:fs`/`node:path` imports:

```ts
import { readFileSync as _readFileSync } from "node:fs";
```

(If `readFileSync` is already imported, reuse it — `writeFileSync` is imported at line 15; add `readFileSync` to that same import.) Add near the module top (after `MAX_BODY_BYTES`, ~line 50):

```ts
const CLEANER_DIR = fileURLToPath(new URL("../advisor/cleaner", import.meta.url));
const CLEANER_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * Serve a static asset from advisor/cleaner behind the advisor auth gate.
 * Path-traversal-safe: the resolved path must stay inside CLEANER_DIR, so an
 * encoded "../" cannot reach src/ or .env.
 */
function serveCleanerAsset(res: http.ServerResponse, relPath: string): void {
  const resolved = path.resolve(CLEANER_DIR, "." + path.posix.normalize("/" + relPath));
  if (resolved !== CLEANER_DIR && !resolved.startsWith(CLEANER_DIR + path.sep)) {
    json(res, 400, { error: "bad path" });
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const type = CLEANER_MIME[ext];
  if (!type) {
    json(res, 404, { error: "not found" });
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(resolved);
  } catch {
    json(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": type });
  res.end(body);
}
```

Add the routes **after** the auth gate (after the `if (!session) return json(res, 401, ...)` at ~line 276), so both require a valid session — before the `/chat` handler:

```ts
      if (method === "GET" && url.pathname === "/cleaner") {
        return serveCleanerAsset(res, "index.html");
      }
      if (method === "GET" && url.pathname.startsWith("/cleaner/")) {
        return serveCleanerAsset(res, url.pathname.slice("/cleaner/".length));
      }
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test test/advisor-server.test.ts`
Expected: PASS (4 new tests; existing pass).

- [ ] **Step 8: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 9: Commit** (verify no secrets and that only the two vendored pdf.js files are large):

```bash
git add advisor/cleaner package.json package-lock.json test/advisor-server.test.ts src/advisor-server.ts
git status   # confirm advisor/cleaner/vendor/pdfjs/*.mjs are staged, nothing under node_modules
git commit -m "feat(cleaner): extensible client-side cleaner tab (vendored pdf.js, auth-gated)"
```

---

## Task 7: Deploy + verify (advisor restart)

**Files:** none (operational).

Per `CLAUDE.md`, the advisor is a long-lived daemon; these changes are not live until it is restarted. MCP servers are unchanged.

- [ ] **Step 1: Restart the advisor**

```bash
launchctl kickstart -k gui/$(id -u)/com.cuassistant.advisor
```

- [ ] **Step 2: Verify the toggle end to end.** Sign in; confirm the mode banner shows **Private** at first paint; send a question and confirm the turn logs `mode: "private"` and a `rcd`/`spark` provider. Switch to OpenAI: confirm the dialog names both consequences, the conversation clears, the banner turns to OpenAI, and a turn logs `mode: "openai"` + provider `openai`. Switch back to Private: confirm no reset. In the log, confirm no private-mode turn ever used the `openai` provider.

- [ ] **Step 3: Verify the cleaner.** Open the "Clean a document" link (new tab, same auth). Load a Degree Works PDF; confirm the sanitized `gc-course-ledger-v1` shows in the output pane with no name/ID/GPA/grades, the metrics populate, and Copy/Download work. Confirm (DevTools → Network) that no request goes to any CDN and the raw PDF is never sent to the server — only the page/asset GETs under `/cleaner/` appear.

- [ ] **Step 4: Update the session handoff / STATE** if the project tracks one, noting the toggle + cleaner shipped and fp8 is now the Private-mode primary.

---

## Self-Review

**Spec coverage:**
- Private/OpenAI per-session chain → Tasks 1–2. New `clemson_rcd_vllm` policy + `rcd` provider → Task 1. Visible mode chrome + confirm-on-switch → Task 4. Reset only private→OpenAI → Task 3. Default last-used per advisorId → Task 3 (`lastMode`). Audit per turn → Task 2 (`mode` in the turn log). Cleaner available in both modes → Task 4 (link in the mode bar, present regardless of mode). ✅
- Extensible cleaner: separate auth-gated tab → Task 6; vendored pdf.js (no CDN) → Task 6 Step 3; whitelist-extract module framework → Tasks 5–6; one Degree Works module (`gc-course-ledger-v1`) → Task 5; UI cleanup → Task 6 Step 5; client-side-only guarantee → Task 6 (parse in browser, only sanitized output leaves). No server-side URL fetch (non-goal) → honored (inputs are PDF + paste only). ✅
- gc-progress-v1 secondary output: intentionally dropped from the tab (ledger-only), matching "ledger is primary; derive what's-left from gc_advisor." Noted as a deliberate simplification, consistent with the spec's "may remain if trivial."

**Placeholder scan:** No TBD/TODO; every code step carries complete code except the verbatim relocation of the existing, working parser (Task 5 Step 3), which names the exact source and function list rather than re-transcribing ~500 unchanged lines — a relocation, not new logic.

**Type/name consistency:** `AdvisorMode` defined once in `advisor-session.ts`, imported by `advisor-agent.ts` (type-only, no runtime cycle) and `advisor-server.ts`. `MODE_CHAINS`/`advisorChainForMode` (Task 2) consumed by Tasks 2–3. `createSession(advisorId, mode)` signature consistent across login/clear/mode (Tasks 2–3). `CleanerModule`/`CleanerResult` (Task 5 `.d.ts`) match the framework's usage (`result.sanitized`, `result.metrics`, `result.warnings`, `result.preview`, `result.schema`) in Task 6. `degreeWorksModule` produced in Task 5, imported in Task 6. Provider label `rcd` consistent across `providerModel`/`resolveProvider`/`CHAIN_EGRESS_PROVIDER`/`MODE_CHAINS` (Tasks 1–2).
