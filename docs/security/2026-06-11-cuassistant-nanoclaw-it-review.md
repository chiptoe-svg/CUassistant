# CUassistant ↔ NanoClaw — Combined Security Review (IT Perspective)

**Date:** 2026-06-11
**Scope:** CUassistant (host MCP provider, this machine, `main` @ `807e5eb`, verified live)
operating together with **NanoClaw personal** (`chiptoe-svg/nanoclaw-personal`,
local working copy — host-side code audited; the in-container agent-runner bridge
is noted as out-of-scope where relevant).
**Lens:** institutional IT — credential governance, data egress, isolation,
audit, revocability. Attention given to the areas IT (and the IT-perspective
reviews this project ran) have been sensitive to historically.

---

## 1. The combined system & trust boundaries

```
NanoClaw container (agent + Pi harness)          Host (this Mac)
  • agent backend: GPT-5.4 (OpenAI-family)         CUassistant credentialed MCP (127.0.0.1:8765)
  • holds: a per-agent BEARER to CUassistant        • holds MS365 refresh token (.env, 0600)
  • model creds injected on-wire by OneCLI          • holds gws creds (keyring file backend)
        │  HTTP via host.docker.internal:8765        • policy allow-list + audit + send-gate
        └───────────── Bearer ──────────────▶        └─▶ MS365 Graph (delegated) / Google (gws) / Banner (public)
```

**Core property:** the institutional credentials live **host-side in CUassistant**;
the container holds only a bearer token to *reach* CUassistant and request
operations through tools. MS365/Google credentials never enter the container.
Both repos independently enforce this (verified on both sides).

---

## 2. How the system addresses each IT sensitivity

| # | IT sensitivity (historical) | Current posture | Verdict |
|---|---|---|---|
| 1 | **Over-broad OAuth / privilege escalation** (the original graph-cli problem) | MS365 access is **delegated + self-scoped** (`Mail.ReadWrite`, `Calendars.ReadWrite`, `Tasks.ReadWrite`, `Mail.Send`), single user — the token can do only what the user can, to their own data. No app-only/tenant-wide permission. | ✅ Strong |
| 2 | **Credential containment (never in container)** | MS365 token in `.env` (0600); gws in keyring **file** backend (0600). Container gets only the CUassistant bearer (stored as a `${VAR}` *reference*, not a literal, in NanoClaw's DB/`container.json`; injected transiently from `.env` at spawn). NanoClaw mount-security blocks `.env`/`.ssh`/`credentials`/keys from being mounted into containers. | ✅ Strong (both sides) |
| 3 | **Data egress to LLMs / DPA / FERPA** | Classifier egress is *declared and gated* in `policy/action-policy.yaml` → `data_egress`: `codex_chatgpt_edu` (institutional, authorized), `openai_api` (**authorized: false — blocked even though `OPENAI_API_KEY` is present**, verified), local LLMs `scope: local`. | ⚠️ See §3 below — the bigger egress is the *agent's* model |
| 4 | **Audit / accountability** | Authoritative trail = **M365 unified audit log** (every Graph call carries the delegated identity). Local `state/decisions.jsonl` (0600, append-only, `npm run audit:verify`, optional `chflags` append-only) records the send-gate + writes. | ✅ for M365; ⚠️ local trail not tamper-proof (same-uid) |
| 5 | **Revocability / IT kill-switch** | IT can revoke the GCassistant app consent / disable the account (MS365), or the `cuagent-tonkin` app/account (Google) → access dies. Per-agent bearer revocable (`mcp:consumers --revoke`). | ✅ Strong — IdP-level kill switch retained |
| 6 | **Irreversible / external actions** | `send` → **out-of-band Telegram human-approval gate** (frozen artifact, bot token the agent can't reach, audited). Delete/RSVP/task-delete and Sheets/Docs delete/share/overwrite-body → `human_required`, **unexposed**. Google writes = read-any / append-any / **update-own**; **share off**. | ✅ Strong — no autonomous irreversible external action |
| 7 | **OAuth app configuration** | MS365: registered GCassistant app, IT-granted delegated consent. Google: **`cuagent-tonkin` Internal app** (in Clemson's Workspace org) → no 7-day expiry, no verification, governance-clean. | ✅ Good |
| 8 | **Multi-user / shared-broker governance** | CUassistant is **single-identity** (one MS365 token, one gws). NanoClaw is multi-agent/role capable. | ⚠️ See §4 — do not multi-tenant casually |

---

## 3. The dominant data-egress path (only visible reviewing them together)

The classifier egress (CUassistant → ChatGPT Edu) is declared and gated. **The
larger egress is the agent's own model.** Anything the NanoClaw agent *reads*
through CUassistant tools — mailbox messages, calendar, **Sheets/Docs content**,
Banner data — enters the agent's context and is **sent to the agent's model
backend** as part of normal reasoning.

**The institutional rule:** all Clemson-related data must flow only through
**OpenAI (ChatGPT Edu) or on-host local models** — Anthropic is *not* a permitted
destination for Clemson data (no covering agreement). The system is built to
honor this on both egress paths:

- **Classifier path** (CUassistant): subject+body → `codex_chatgpt_edu`
  (institutional, authorized); raw `openai_api` is `authorized: false`; local
  backends are `scope: local`. Declared and gated in `policy/action-policy.yaml`.
- **Agent-reasoning path** (NanoClaw): the agent runs on the **Pi harness backed
  by GPT-5.4 (OpenAI-family)** — *not* Anthropic. So mailbox/doc content read
  through CUassistant tools flows into an **OpenAI-family model**, which is the
  *intended* alignment with the "OpenAI-or-local only" rule, not a leak to an
  unapproved provider.

So both data flows land in the OpenAI/ChatGPT-Edu envelope by design. Neither
repo's local view shows the agent path; it's a property of the two operating
together, so **IT should still confirm it explicitly.**

**The verification item that matters:** confirm the agent's **GPT-5.4 backend is
the ChatGPT-Edu-covered instance** (institutional agreement), not a raw
consumer/`openai_api`-tier endpoint that falls *outside* the Clemson agreement.
"OpenAI-family" satisfies the rule only if the specific endpoint is the one the
Clemson agreement actually covers. Same question for the classifier: confirm the
ChatGPT-Edu agreement covers that programmatic use.

**Recommendation:** confirm (a) the ChatGPT-Edu agreement covers the classifier
use, and (b) the NanoClaw agent's GPT-5.4 backend is the institutionally-covered
ChatGPT-Edu endpoint (so Clemson mail/doc content stays inside the agreement).
Keep CUassistant's `openai_api` classifier provider `authorized: false` unless/until
a separate DPA covers it. **Defense-in-depth:** if CUassistant's raw-OpenAI
classifier path isn't used, *remove* `OPENAI_API_KEY` from `.env` entirely — no
key means no egress on that path even if the policy gate were ever misconfigured.
(This is separate from the agent's own GPT-5.4 credentials, which live in the
NanoClaw/OneCLI layer, never in CUassistant.)

---

## 4. Combined-system findings

| Finding | Severity | Owner | Notes / mitigation |
|---|---|---|---|
| **Agent-model egress** (mail/doc content → the agent's GPT-5.4 backend) | **Low–Medium** (governance) | both | The dominant data flow. The agent runs on the **Pi harness → GPT-5.4 (OpenAI-family)**, *not* Anthropic — which is the intended alignment with Clemson's "OpenAI-or-local only" rule. Residual item is verification, not redirection: confirm that GPT-5.4 backend is the **ChatGPT-Edu-covered endpoint**, not a raw/uncovered OpenAI tier (§3). Not a code bug — a disclosure/governance item. |
| **Bearer lives in the container env**, not behind the OneCLI proxy | **Medium** | both | A container compromise/escape exposes the CUassistant bearer → attacker can call CUassistant tools (read mailbox/cal/docs; append; own-write) until revoked. Reads are the main exposure (writes are gated/own-only; sends still need the out-of-band tap). It is per-agent + revocable. Treat the bearer as the single secret guarding CUassistant from a bad container. |
| **Token-in-logs risk** | **Medium** | NanoClaw | Host logs container **stderr without header masking**; if the in-container Pi bridge logs the `Authorization` header, the bearer lands in host logs. *In-container bridge not audited here.* Mitigation: verify the bridge doesn't log headers; add host-side `Bearer …` stderr redaction as defense-in-depth. |
| **No per-tool gate in NanoClaw host** — permission is **user/group-level**, not per-tool; per-tool prompting is delegated to the agent SDK | **Medium** | NanoClaw | So "keep send/write off the allowlist" is an SDK-harness behavior, **not a NanoClaw host guarantee**. → CUassistant's out-of-band send-gate is therefore the *load-bearing* control for sends (good that it exists), and CUassistant's policy `human_required`/own-write constraints are the load-bearing control for destructive/cross-file writes. The combined system is safe *because CUassistant enforces server-side*, not because NanoClaw gates per tool. |
| **Local audit not tamper-proof** | **Low** | CUassistant | `decisions.jsonl` is owner-writable (same uid). M365 unified audit is the authoritative trail. Off-host shipping if a stronger local guarantee is needed. |
| **Single-identity boundary** | **Low (today) / High if misused** | both | All agents pointed at this CUassistant act as the **one** `.env` MS365 user. Do **not** point multiple distinct users' agents at one CUassistant expecting per-user isolation — use **per-user CUassistant instances** (process isolation). |
| **Static, manually-rotated bearer** | **Low** | both | No auto-expiry/refresh. Rotate periodically (`mcp:pair` re-mint); OIDC/client-credentials would add expiry + IT-central revocation (assessed separately). |
| **Secrets that transited operator chat** | **Low (op hygiene)** | operator | Telegram bot token, the per-agent MCP bearer, and the gws client secret were pasted during setup. Rotate at leisure. |
| **Global memory mount RO-shared across agents** | **Low** | NanoClaw | `/workspace/global` shared read-only — cross-agent info leak if agents are mutually untrusted. Acceptable for collaborative single-operator use. |

**Strengths worth recording:** no privileged containers / no cap-add / non-root
when possible; OneCLI gateway refuses to spawn without credential injection
(model keys never hardcoded); mount allowlist external to the repo; per-session
container/folder isolation; CUassistant fails closed (refuses to start the
credentialed HTTP server with no registered consumer); all secret stores at rest
are `0600`.

---

## 5. Prioritized recommendations

1. **Confirm ChatGPT-Edu coverage for both OpenAI-family egress channels** — the classifier (`codex_chatgpt_edu`) *and* the NanoClaw agent's GPT-5.4 backend. The "Clemson data → OpenAI-or-local only" rule is honored architecturally (no Anthropic in the Clemson path); the open item is confirming the agent's GPT-5.4 is the institutionally-covered endpoint, not a raw OpenAI tier. This is the top IT item. Keep CUassistant's `openai_api` classifier provider blocked; drop `OPENAI_API_KEY` from `.env` if that path is unused.
2. **Verify the in-container Pi bridge does not log the `Authorization` header**, and add host-side `Bearer …` redaction to NanoClaw's stderr logging as defense-in-depth.
3. **Treat the CUassistant bearer as the single guard against a compromised container** — rotate on a schedule; evaluate the OIDC/client-credentials path (short-lived tokens + IdP-central revocation) if/when this warrants institutional governance.
4. **Document the single-user boundary** — per-user CUassistant instances for any real multi-user use; never in-process multi-tenancy without IT ownership.
5. **Keep the controls that are doing the heavy lifting:** out-of-band send-gate ON; destructive ops unexposed; Sheets/Docs update-own; share off; fail-closed auth.

---

## 6. IT verdict

Operating together, CUassistant + NanoClaw are **conservatively designed for an
institutional setting**: delegated + self-scoped credentials that never enter the
container, an out-of-band human gate (on a channel the agent can't reach) for the
one irreversible external action, declared-and-gated data egress, IdP-level
revocability, and container isolation that blocks host-secret mounts and runs
unprivileged.

A key design property: the agent runs on the **Pi harness → GPT-5.4
(OpenAI-family)**, so the dominant data flow stays inside the **OpenAI/ChatGPT-Edu
or local** envelope that Clemson permits — Anthropic is never in the Clemson data
path. That is alignment by design, not a leak.

The residual items are the right things for IT to **sign off on knowingly**, not
alarms: (a) confirm the agent's GPT-5.4 backend (and the classifier) are on the
**ChatGPT-Edu-covered endpoint**, not a raw/uncovered OpenAI tier — a
governance/agreement verification, not a redirection; (b) the bearer as the
single guard against a bad container — rotate, consider OIDC; (c) it is
single-user — don't multi-tenant it casually. The system's safety rests on
**CUassistant enforcing server-side** (policy, gate, own-write), which holds
regardless of NanoClaw's coarser host-level permissioning.
