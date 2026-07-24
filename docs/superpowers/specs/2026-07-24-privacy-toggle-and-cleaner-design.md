# Privacy Toggle + Extensible Cleaner — Design Spec

**Date:** 2026-07-24
**Status:** Design, approved for planning.

## Goal
Two privacy-transparency features for the advisor. Their **primary purpose is
clear, honest messaging about privacy** (informed consent, institutional
optics); a secondary benefit is performance/quality choice. The technical
routing exists to make the message *true* — a "Private" claim that could leak
would be worse than no toggle, so Private mode must be *literally unable* to
reach OpenAI.

1. **Mode toggle** — advisor chooses Private (FERPA-OK local models) vs OpenAI
   (de-identified frontier), with a visible, honest boundary.
2. **Extensible cleaner** — a separate-tab, client-side de-identifier that lets
   an advisor sanitize a document (Degree Works PDF now; transcripts / web-page
   text later) before pasting it into the chat. The raw document never leaves the
   browser.

## Non-goals / YAGNI
- No server-side URL fetch in the cleaner (decided): all inputs are client-side
  (PDF via pdf.js, pasted text/HTML), so the "raw document never leaves your
  machine" guarantee holds for every module. "Web page" = paste the page content.
- Do NOT build the transcript / web-page / generic cleaner modules now — only the
  **framework** + the **Degree Works module**. The others plug in later.
- No change to the buffer-and-gate answer rendering, the MCP tool surface, or the
  benchmark.

---

## Feature 1 — Private / OpenAI mode toggle

### Provider chains per mode
Today `ADVISOR_PROVIDER_CHAIN` (config.ts) is a process-level constant
(`"spark,openai"`) resolved once. Change it to be **selected by the active
track's mode** (each track is an `AdvisorSession` carrying its own `mode`):

```
MODE_CHAINS = {
  private: ["rcd", "spark"],   // fp8 primary, SGLang-Spark fallback — both FERPA-OK local
  openai:  ["openai"],         // gpt-5.5, NO fallback
}
```

When the harness is built for a turn, use `MODE_CHAINS[session.mode]` instead of
the process constant. `assertAdvisorChainAuthorized` still validates whichever
chain is used (all three labels remain declared+authorized), so the fail-closed
egress gate is unchanged — it just gates the mode's chain. Keep
`ADVISOR_PROVIDER_CHAIN` as the env override / default source for the *private*
chain if set; the openai chain is fixed.

### New egress plumbing (the `rcd` provider)
- **Policy record** (`policy/action-policy.yaml`, `data_egress.agent_backends`):
  add `clemson_rcd_vllm`, `authorized: true`, basis = "Clemson-operated RCD LLM
  cluster **campus models** at `llm.rcd.clemson.edu/v1` (NOT the `/openai/v1`
  OpenAI passthrough); Clemson-hosted open-weight models, FERPA-cleared for
  identifiable student data, TLS, Clemson-issued key." This is DISTINCT from
  `clemson_llm_gateway_openai` even though the host is the same — different service
  (`/v1` vs `/openai/v1`), different FERPA status.
- **Chain destination** (`advisor-agent.ts` `CHAIN_EGRESS_PROVIDER`): add
  `rcd: { policyProvider: "clemson_rcd_vllm", hosts: ["llm.rcd.clemson.edu"] }`.
- **Provider model** (`advisor-agent.ts` `providerModel`): add the `rcd` branch —
  `baseUrl: CLEMSON_LLM_BASE_URL`, `apiKey: CLEMSON_LLM_API_KEY`,
  `id: "qwen3.6-35b-a3b-fp8"`, same qwen-thinking request shape as the `spark`
  branch (temperature + `chat_template_kwargs.enable_thinking`). Make the model id
  overridable by an env var (e.g. `ADVISOR_RCD_MODEL`).
- **OpenAI mode model** = `gpt-5.5` (verified to do tools+reasoning on
  `/chat/completions`; `gpt-5.6-sol` does NOT and must not be used here). Make it a
  configurable constant (`ADVISOR_OPENAI_MODEL`, default `gpt-5.5`).

### Two-track sessions (no reset)

A browser (cookie) owns a **pair** of sessions, one per mode, plus an `active`
mode. Switching modes swaps which track the UI and the next turn use — it never
disposes anything. Isolation is therefore **structural**: the Private track's
history, workDir, and Pi conversation are a different `AdvisorSession` from the
OpenAI track's and never enter each other's context, so no reset is needed to
keep Private data out of an OpenAI request.

- The cookie identifies a **client** (the browser), not a single session —
  phase-1 isolation stays per-cookie (`advisorId` is still `"shared"`).
- A client holds `{ private?: AdvisorSession, openai?: AdvisorSession, active:
  AdvisorMode }`. The non-active track is created lazily on first entry.
- `AdvisorSession` gains a `mode` field so a turn reads its own chain
  (`MODE_CHAINS[session.mode]`); the two tracks carry `"private"` and `"openai"`.
- **Switch:** set `active`, lazily create the target track. No abort, no dispose,
  no new cookie. Flip back and forth freely; each conversation persists.
- **Clear session:** clears the **active** track only (dispose + recreate); the
  other track is untouched.
- **Disposal/sweep/shutdown** must reap **both** tracks of every client (TTL
  expiry and SIGTERM), since each holds JSONL transcripts.

### UX (the featured surface)
- **Persistent, distinct chrome per track**, unmistakable at first paint (a
  colored banner + label; Private and OpenAI visually different enough that no
  one loses track). The banner reflects the **active** track.
- **Confirm-on-switch-to-OpenAI** (one-shot dialog): now a pure de-identification
  reminder — "You're switching to the OpenAI track. De-identified data only — no
  student names, IDs, or grades." No conversation is lost, so it no longer warns
  about that. No confirm switching back to Private.
- The cleaner tab link is present on **both** tracks.

### OpenAI-track private-info detector (server-enforced)

Sending in the **OpenAI track** passes a rudimentary PII check the Private track
never runs. The check is **server-side and enforced** — one source of truth,
unit-tested, and not bypassable by editing page JS:

- On `POST /chat` for an OpenAI-track session, run `flagLikelyPrivate(message)`.
  If it returns any flags AND the request did not carry `consent: true`, respond
  **`409 { needsConsent: true, flags }`** and **run no turn** — nothing egresses.
- `flagLikelyPrivate` matches **high-precision structured patterns only**:
  Clemson C-ID (`C` + 8 digits), SSN, email, phone, `GPA` + a number, and long
  digit runs. **Names are deliberately NOT gated** — regex name-detection
  false-fires on course titles, buildings, and instructor names, which trains
  advisors to click through. Names are covered by the standing banner and the
  switch confirm instead.
- The browser renders the 409: a dialog lists the flagged categories (with the
  matched snippet, so the advisor can find and fix it) and offers **Cancel &
  edit** (keep the text in the box, refocus, send nothing) or **Not private —
  send** (re-POST with `consent: true`).
- **Audit:** when an advisor overrides, log that an OpenAI turn was sent with a
  PII-flag override and the flagged **categories** (never the content).
- Private track: no check — identifiable data is allowed there.

### Persistence + audit

- **Default track on login** = the client's last-active mode (in-memory per
  client; a restart resets to `private`, the safe default). The server is
  authoritative for routing; the banner is cosmetic and cannot disagree.
- **Audit per turn:** log the `mode` on every turn (which turns went to OpenAI),
  plus the override record above — cheap and valuable for FERPA traceability.

### Deployment
Advisor change (chain-per-mode, session mode, UI) + policy change → **restart the
advisor (8770)**, verify with a smoke test that (a) Private mode reaches fp8 with
auth and passes the egress gate, (b) OpenAI mode reaches gpt-5.5, (c) the egress
gate refuses a private-mode attempt to dial OpenAI. MCP servers unchanged (no
restart).

---

## Feature 2 — Extensible cleaner (separate tab)

### Shape
- A **self-contained page** served at its own route on the advisor origin, behind
  the same advisor auth, opened in a **new tab** from a link in the advisor UI.
- **Client-side only.** `pdf.js` is **vendored locally** (no external CDN — it
  handles the raw PII). Only the sanitized output ever leaves the tab, by
  copy/download. The server receives nothing raw.

### Framework shell (shared, source-type agnostic)
Responsibilities: input handling, module dispatch, the review UI, copy/download.
- **Inputs:** a file picker (PDF → pdf.js text extraction) and a paste box
  (text/HTML). Both produce a raw-text string, client-side.
- **Module selector:** a dropdown of available cleaner modules (with descriptions).
- **Review UI:** two panes — left = source preview (with private lines redacted
  for display), right = the sanitized JSON output — plus a metrics row and warning
  banners. **Copy sanitized** / **Download** buttons.
- The shell owns NO extraction logic; it routes `rawText` to the selected module.

### Cleaner module interface
```
interface CleanerModule {
  id: string;                 // "degree-works"
  label: string;              // "Degree Works audit"
  description: string;        // shown in the selector
  accepts: ("pdf" | "text")[];
  clean(rawText: string): {
    schema: string;           // e.g. "gc-course-ledger-v1"
    sanitized: unknown;       // the whitelist-extracted object (PII-clean by construction)
    warnings: string[];       // e.g. "catalog year not found; add manually"
  };
}
```
Modules do **whitelist extraction** — the output is *built* from named safe
fields, so unlisted content (names, IDs, GPA, grades) cannot appear. Adding a new
cleaning duty = registering a new module; the shell is untouched.

### The one module now — Degree Works
Refactor the existing quick-and-dirty cleaner into a `degree-works` module that
emits **`gc-course-ledger-v1`** (the canonical shape converged on: clean
completed-work ledger — `code`/`prefix`/`number`/`title`/`term`/`credits`/`status`
— with requirement derivation deferred to gc_advisor). Keep the redaction of
name/ID/GPA/grades. (The richer `gc-progress-v1` may remain as a secondary output
if trivial, but the ledger is primary.)

### UI cleanup
Replace the tech-demo styling with a **polished, accessible surface** (it's
advisor-facing and part of the PR story): clear header, the module selector,
labeled input/review panes, readable metrics, visible warnings, keyboard/contrast
accessible. Theme-consistent with the advisor page.

### Deployment
Static page + a link in the advisor UI. No MCP restart; ships with the advisor
page's static assets (vendored pdf.js included).

---

## Data flow (both features, one story)
1. Advisor opens the cleaner tab, picks the module, uploads a PDF / pastes text.
2. Cleaner parses + whitelist-extracts **in the browser**; advisor reviews the
   sanitized output and copies it.
3. Advisor pastes the sanitized ledger into the advisor chat.
4. The **active track** decides where that turn goes: Private (fp8→spark, local)
   or OpenAI (gpt-5.5, de-identified). The banner is visible; the egress gate
   makes the routing honest; and an OpenAI-track send first passes the
   server-enforced PII detector (consent required to override a flag).

## Testing
- **Mode→chain routing:** private resolves `rcd,spark`; openai resolves `openai`;
  the egress gate authorizes each and REFUSES a private-mode dial to a
  non-authorized/openai host (assert the fail-closed path).
- **Two-track sessions:** switching sets `active` and preserves both tracks (no
  dispose); `/clear` disposes the active track only; client expiry/shutdown reaps
  both tracks.
- **PII detector:** `flagLikelyPrivate` flags C-ID/SSN/email/phone/GPA/long-digits
  and does NOT flag names or ordinary advising prose; OpenAI-track `/chat`
  returns `409 needsConsent` on a flag without consent (no turn runs) and
  proceeds with `consent: true`; Private-track `/chat` never checks.
- **`rcd` provider:** resolves the fp8 model, base URL, and auth correctly (unit),
  plus a live smoke that the advisor reaches fp8.
- **Cleaner framework:** input dispatch (pdf/text) and module routing.
- **Degree Works module:** offline extraction tests over sample text — name/ID/GPA/
  grades absent from output; ledger fields present; warnings on missing catalog
  year (mirror the existing cleaner-parser tests).

## Open questions for the owner (not blocking)
- Server-side per-`advisorId` last-used persistence (cross-device) vs client-side
  localStorage — pilot can start with localStorage.
- Exact mode chrome/colors (a visual-design detail for implementation).
