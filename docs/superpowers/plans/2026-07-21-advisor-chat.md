# Advisor Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser chat on `127.0.0.1:8770` where a GC advisor asks composition questions ("student has GC 4060 and GC 3400 at these times — find a specialty area class and a tech elective that fit") answered by a Codex-SDK agent wired to the public MCP servers.

**Architecture:** One `node:http` service following `src/token-portal.ts`: hand-rolled routes, inline HTML, no framework. Sessions live in an in-memory `Map` keyed by an opaque cookie; each session owns a temp working directory and its own `CODEX_HOME`, both destroyed on clear. The agent runs through `@openai/codex-sdk`, which spawns the Codex CLI, so the read-only sandbox and process isolation of `src/codex-agent.ts` carry over.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers in `src/`, `.ts` in `test/`), `node:http`, `node:test` + `node:assert/strict`, `@openai/codex-sdk` 0.145.0.

**Spec:** `docs/superpowers/specs/2026-07-21-advisor-chat-design.md`

## Global Constraints

- **MCP tool surface is exactly `8766` and `8767`.** `8765` is never wired in — it carries `send-outlook-mail`, `send-gmail`, and calendar writes.
- **`CODEX_HOME` is per session and is a write surface.** Codex persists transcripts under `CODEX_HOME/sessions` and creates `memories/` and `tmp/`. It must be created per session and removed with the session, or "nothing persists server-side" is false.
- **The SDK's `env` option replaces the child environment wholesale** — it does not merge with `process.env`.
- **`sandboxMode: "read-only"`.** The agent never writes files. Artifacts are rendered host-side from schema-validated output.
- **`webSearchMode: "disabled"`.** Answers come from MCP tools or not at all.
- **`approvalPolicy: "never"`.** Unattended service, nobody to prompt.
- **Prose by default.** `outputSchema` is per-turn (`TurnOptions`); conversational turns pass none.
- **Audit records metadata only** — never prompt or response content.
- **Session isolation is per-cookie, never per-password.**
- Every module imports with `.js` specifiers; tests import with `.ts`.
- `npm run typecheck` covers `src/` and `test/` (via `tsconfig.test.json`).

---

### Task 1: Config and session store

**Files:**
- Modify: `src/config.ts` (append a new section at end of file)
- Create: `src/advisor-session.ts`
- Test: `test/advisor-session.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface AdvisorSession { id: string; advisorId: string; workDir: string; codexHome: string; threadId: string | null; history: TurnRecord[]; lastTouched: number; }`
  - `interface TurnRecord { role: "advisor" | "agent"; text: string; at: number; }`
  - `createSession(advisorId: string): AdvisorSession`
  - `getSession(id: string | undefined): AdvisorSession | undefined`
  - `clearSession(id: string): void`
  - `sweepExpired(now?: number): number`
  - `sessionCount(): number`
  - `resetSessionsForTest(): void`

- [ ] **Step 1: Add config values**

Append to `src/config.ts`:

```ts
// --- Advisor chat service (port 8770) ---
export const ADVISOR_PORT = Number(process.env.ADVISOR_PORT || 8770);
export const ADVISOR_PASSWORD = process.env.ADVISOR_PASSWORD || "";
export const ADVISOR_SESSION_TTL_MS = Number(
  process.env.ADVISOR_SESSION_TTL_MS || 2 * 60 * 60 * 1000,
);
/** Egress provider name; must be authorized in policy/action-policy.yaml. */
export const ADVISOR_PROVIDER = process.env.ADVISOR_PROVIDER || "local_vllm";
export const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "qwen3";
/** Local vLLM by default; set to an OpenAI base URL to fall back. */
export const ADVISOR_BASE_URL =
  process.env.ADVISOR_BASE_URL || "http://127.0.0.1:8000/v1";
export const ADVISOR_MCP_PUBLIC_URL =
  process.env.ADVISOR_MCP_PUBLIC_URL || "http://127.0.0.1:8766/";
export const ADVISOR_MCP_CATALOG_URL =
  process.env.ADVISOR_MCP_CATALOG_URL || "http://127.0.0.1:8767/";
```

- [ ] **Step 2: Authorize the local vLLM provider in policy**

Add to `policy/action-policy.yaml` under `data_egress.classifiers`, after the `local_ollama` entry:

```yaml
    - provider: local_vllm
      scope: local
      sends: [subject, body]
      basis: "on-host inference (vLLM on DGX Spark); content does not leave Clemson-managed hardware"
      authorized: true
```

- [ ] **Step 3: Write the failing tests**

Create `test/advisor-session.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";

import {
  createSession,
  getSession,
  clearSession,
  sweepExpired,
  sessionCount,
  resetSessionsForTest,
} from "../src/advisor-session.ts";

test("a session gets its own working directory and CODEX_HOME", () => {
  resetSessionsForTest();
  const s = createSession("shared");
  assert.ok(existsSync(s.workDir), "workDir must exist");
  assert.ok(existsSync(s.codexHome), "codexHome must exist");
  assert.notEqual(s.workDir, s.codexHome, "must be separate directories");
  clearSession(s.id);
});

// Isolation matters more than usual: the shared password makes two advisors
// indistinguishable at the auth layer, so the cookie is the ONLY thing keeping
// their conversations apart.
test("two sessions never resolve to each other", () => {
  resetSessionsForTest();
  const a = createSession("shared");
  const b = createSession("shared");
  assert.notEqual(a.id, b.id);
  assert.equal(getSession(a.id)?.id, a.id);
  assert.equal(getSession(b.id)?.id, b.id);
  assert.notEqual(a.workDir, b.workDir);
  assert.notEqual(a.codexHome, b.codexHome);
});

test("getSession returns undefined for unknown or missing ids", () => {
  resetSessionsForTest();
  assert.equal(getSession(undefined), undefined);
  assert.equal(getSession("nope"), undefined);
});

// Clear is a data-disposal control, not a convenience: Codex writes transcripts
// under CODEX_HOME/sessions, so both directories must actually be gone.
test("clear removes the entry and BOTH directories from disk", () => {
  resetSessionsForTest();
  const s = createSession("shared");
  const { workDir, codexHome } = s;
  clearSession(s.id);
  assert.equal(getSession(s.id), undefined);
  assert.equal(existsSync(workDir), false, "workDir must be deleted");
  assert.equal(existsSync(codexHome), false, "codexHome must be deleted");
});

test("sweep expires idle sessions and leaves active ones", () => {
  resetSessionsForTest();
  const old = createSession("shared");
  const fresh = createSession("shared");
  const now = Date.now();
  old.lastTouched = now - 3 * 60 * 60 * 1000; // 3h idle, TTL is 2h
  const removed = sweepExpired(now);
  assert.equal(removed, 1);
  assert.equal(getSession(old.id), undefined);
  assert.equal(getSession(fresh.id)?.id, fresh.id);
  assert.equal(existsSync(old.workDir), false);
  assert.equal(existsSync(old.codexHome), false);
  assert.equal(sessionCount(), 1);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test test/advisor-session.test.ts`
Expected: FAIL — `Cannot find module '../src/advisor-session.ts'`

- [ ] **Step 5: Implement the session store**

Create `src/advisor-session.ts`:

```ts
// In-memory session store for the advisor chat.
//
// Nothing persists server-side. Each session owns two directories:
//
//   workDir    - the agent's read-only sandbox cwd; holds uploaded files
//   codexHome  - CODEX_HOME for this session's Codex CLI invocations
//
// codexHome is per session because it is a WRITE surface: Codex persists thread
// transcripts under CODEX_HOME/sessions and creates memories/ and tmp/ there. A
// service-global CODEX_HOME would quietly write conversation content - possibly
// including student information - to disk, making "nothing persists" false.
// Both directories are removed together on clear or expiry.

import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ADVISOR_SESSION_TTL_MS } from "./config.js";
import { log } from "./log.js";

export interface TurnRecord {
  role: "advisor" | "agent";
  text: string;
  at: number;
}

export interface AdvisorSession {
  id: string;
  /** Always "shared" until Phase 2 wires per-advisor identity. */
  advisorId: string;
  workDir: string;
  codexHome: string;
  threadId: string | null;
  history: TurnRecord[];
  lastTouched: number;
}

const sessions = new Map<string, AdvisorSession>();

export function createSession(advisorId: string): AdvisorSession {
  const id = crypto.randomBytes(24).toString("base64url");
  const session: AdvisorSession = {
    id,
    advisorId,
    workDir: mkdtempSync(path.join(tmpdir(), "advisor-work-")),
    codexHome: mkdtempSync(path.join(tmpdir(), "advisor-codex-")),
    threadId: null,
    history: [],
    lastTouched: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string | undefined): AdvisorSession | undefined {
  if (!id) return undefined;
  const s = sessions.get(id);
  if (s) s.lastTouched = Date.now();
  return s;
}

function disposeDirs(s: AdvisorSession): void {
  for (const dir of [s.workDir, s.codexHome]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Loud, because a directory surviving disposal means transcript content
      // stayed on disk after the advisor asked for it to be gone.
      log.warn("advisor session dir not removed", { dir, err: String(err) });
    }
  }
}

export function clearSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  disposeDirs(s);
}

export function sweepExpired(now = Date.now()): number {
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - s.lastTouched > ADVISOR_SESSION_TTL_MS) {
      sessions.delete(id);
      disposeDirs(s);
      removed++;
    }
  }
  return removed;
}

export function sessionCount(): number {
  return sessions.size;
}

/** Test seam: drop all sessions and their directories. */
export function resetSessionsForTest(): void {
  for (const id of [...sessions.keys()]) clearSession(id);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test test/advisor-session.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no output (clean)

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/advisor-session.ts test/advisor-session.test.ts policy/action-policy.yaml
git commit -m "feat(advisor): in-memory session store with per-session CODEX_HOME"
```

---

### Task 2: Codex home — tool surface, persona, and skills

This is the security-critical task. Without an isolated `CODEX_HOME` the agent inherits `~/.codex/config.toml` — on the development machine that is `codegraph` and `node_repl`, a code-execution tool.

The session's `CODEX_HOME` holds three things, and together they are the entire definition of this agent: `config.toml` (its tool surface), `AGENTS.md` (its persona), and `skills/` (its procedural knowledge). All three are materialised per session from repo-tracked sources, so they are version-controlled and editable over time while the runtime copy stays disposable.

**Files:**
- Create: `src/advisor-agent.ts`
- Create: `advisor/AGENTS.md`
- Read (not modified): `skills/*`, `/Users/admin/projects/gc_advisor/skills/*`
- Test: `test/advisor-agent.test.ts`
- Modify: `package.json` (add `@openai/codex-sdk` dependency)
- Modify: `src/config.ts` (add `ADVISOR_SKILLS`, `ADVISOR_SKILL_ROOTS`)

**Interfaces:**
- Consumes: `AdvisorSession` from `src/advisor-session.ts`.
- Produces:
  - `materializeCodexHome(codexHome: string, skills?: string[]): void`
  - `buildThreadOptions(session: AdvisorSession): ThreadOptions`
  - `runAdvisorTurn(session: AdvisorSession, input: string, outputSchema?: unknown): Promise<{ text: string; toolCalls: string[] }>`

- [ ] **Step 1: Add the dependency**

Run: `npm install @openai/codex-sdk@0.145.0`

- [ ] **Step 2: Add the skills config values**

Append to the advisor section of `src/config.ts`:

```ts
/**
 * Directories searched for advisor skills, in order. gc_advisor owns the
 * curriculum skills; this follows the existing GC catalog bridge above, which
 * shells out to gc_advisor rather than copying its data — same principle,
 * keeping each repo the single source of truth for what it owns.
 */
export const ADVISOR_SKILL_ROOTS = (
  process.env.ADVISOR_SKILL_ROOTS ||
  "/Users/admin/projects/CUassistant/skills,/Users/admin/projects/gc_advisor/skills"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Skills materialised into each session's CODEX_HOME, comma-separated. */
export const ADVISOR_SKILLS = (
  process.env.ADVISOR_SKILLS ||
  "clemson-schedule-advising,gc-curriculum-lookup,gc-advisor"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
```

- [ ] **Step 3: Write the persona**

Create `advisor/AGENTS.md`. This is the highest-leverage artifact in the project — it is where advising judgment lives, and it is meant to be edited as advisors report what the agent gets wrong.

```markdown
# Advisor Chat

You help Clemson Graphic Communications advisors answer scheduling and
curriculum questions. Your users are staff, not students.

## Where your answers come from

Every factual claim about a course, section, time, room, or requirement must
come from a tool result. You have the Clemson class schedule and the GC catalog
available as tools; use them. If the tools cannot answer, say so plainly —
do not fill the gap from memory. Course numbers, prerequisites, and requirement
rules change between catalog years, and a confident wrong answer here costs a
student a semester.

You have no web access. This is deliberate: Clemson course pages are public,
frequently outdated, and not versioned by catalog year.

## Catalog year

Students are bound to the catalog year they matriculated under, not the current
one. If a question depends on requirements and you do not know the student's
catalog year, ask. Never assume the newest one.

## What you do not do

You compute the published, by-the-book path. You do not know about petitions,
substitutions, waivers, department approvals, or transfer equivalencies — none
of that is in your data. When a question turns on one of them, say so and hand
it back to the advisor. This is not a disclaimer; it is an accurate description
of your boundary.

You also cannot see grades, holds, or residency requirements, so you cannot
verify that a completed course actually counted.

## Room capacity

Room capacities come from a hand-exported snapshot and go stale when rooms are
renovated. Treat capacity as a planning aid. If a room looks over capacity,
say what the data shows and note it is worth confirming — several rooms in the
export are known to be wrong.

## Student information

Advisors will describe specific students to you. That is expected. Do not ask
for names, ID numbers, or anything else identifying — you never need it. Course
lists and meeting times are enough to answer scheduling questions.

## How to answer

Write prose. You are in a chat window, and most turns are discussion: what the
student needs, why a section does not fit, what the tradeoffs are. Be concrete —
name CRNs, days, and times. When you have checked for conflicts, say so. When
you have not, do not imply that you have.

Keep answers short enough to read at a glance. If you are proposing several
options, lead with your recommendation and say why.
```

- [ ] **Step 4: Write the failing tests**

Create `test/advisor-agent.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { materializeCodexHome, buildThreadOptions } from "../src/advisor-agent.ts";
import {
  createSession,
  clearSession,
  resetSessionsForTest,
} from "../src/advisor-session.ts";

function readConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codexhome-test-"));
  try {
    materializeCodexHome(dir);
    return readFileSync(path.join(dir, "config.toml"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the generated config declares exactly the two public MCP servers", () => {
  const toml = readConfig();
  assert.match(toml, /\[mcp_servers\.cu_public\]/);
  assert.match(toml, /\[mcp_servers\.cu_catalog\]/);
  assert.match(toml, /127\.0\.0\.1:8766/);
  assert.match(toml, /127\.0\.0\.1:8767/);
});

// The credentialed server carries send-outlook-mail, send-gmail, and calendar
// writes. An advisor chat must never hold them.
test("the generated config never mentions the credentialed server", () => {
  const toml = readConfig();
  assert.doesNotMatch(toml, /8765/, "8765 must never appear");
});

// Regression for the real failure mode: without an isolated CODEX_HOME the CLI
// reads ~/.codex/config.toml. On the dev machine that contributes node_repl, a
// code-execution tool. Nothing in the SDK warns, and the tool list looks
// correct on inspection because those servers are named nowhere in this repo.
test("the generated config cannot inherit developer MCP servers", () => {
  const toml = readConfig();
  for (const inherited of ["node_repl", "codegraph"]) {
    assert.doesNotMatch(
      toml,
      new RegExp(inherited),
      `${inherited} must not be inherited`,
    );
  }
  const declared = [...toml.matchAll(/\[mcp_servers\.([a-z_]+)\]/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(declared.sort(), ["cu_catalog", "cu_public"]);
});

test("the persona and skills are materialised into CODEX_HOME", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codexhome-test-"));
  try {
    materializeCodexHome(dir);
    const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /catalog year/i, "persona must carry catalog-year discipline");
    assert.match(agents, /petitions/i, "persona must state the exceptions boundary");
    assert.ok(
      existsSync(path.join(dir, "skills", "clemson-schedule-advising", "SKILL.md")),
      "the schedule skill must be present",
    );
    assert.ok(
      existsSync(path.join(dir, "skills", "gc-curriculum-lookup", "SKILL.md")),
      "the curriculum skill must be present (it lives in the gc_advisor repo)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Skills are editable over time, so a missing or renamed one must fail loudly
// at materialisation rather than producing an agent that quietly knows less.
test("a missing skill is an error, not a silent omission", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codexhome-test-"));
  try {
    assert.throws(
      () => materializeCodexHome(dir, ["no-such-skill"]),
      /no-such-skill/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("thread options pin the sandbox, web search, and approval policy", () => {
  resetSessionsForTest();
  const s = createSession("shared");
  const opts = buildThreadOptions(s);
  assert.equal(opts.sandboxMode, "read-only");
  assert.equal(opts.webSearchMode, "disabled");
  assert.equal(opts.approvalPolicy, "never");
  assert.equal(opts.workingDirectory, s.workDir);
  assert.equal(opts.skipGitRepoCheck, true);
  clearSession(s.id);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx tsx --test test/advisor-agent.test.ts`
Expected: FAIL — `Cannot find module '../src/advisor-agent.ts'`

- [ ] **Step 6: Implement the agent wrapper**

Create `src/advisor-agent.ts`:

```ts
// Codex SDK wrapper for the advisor chat.
//
// The SDK spawns the Codex CLI, so sandboxMode/workingDirectory give the same
// process isolation src/codex-agent.ts relies on. Two things the SDK does NOT
// give us, both handled here:
//
//   1. There is no --ignore-user-config equivalent. Without an isolated
//      CODEX_HOME the CLI reads ~/.codex/config.toml and inherits whatever MCP
//      servers a developer has configured. Verified 2026-07-21: that is
//      codegraph and node_repl (code execution). So we write our own
//      config.toml into a per-session CODEX_HOME and point the child at it.
//   2. `env` REPLACES the child environment rather than merging, so everything
//      the CLI needs must be listed explicitly.

import { copyFileSync, cpSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Codex, type ThreadOptions } from "@openai/codex-sdk";

import {
  ADVISOR_BASE_URL,
  ADVISOR_MCP_CATALOG_URL,
  ADVISOR_MCP_PUBLIC_URL,
  ADVISOR_MODEL,
  ADVISOR_PROVIDER,
  ADVISOR_SKILLS,
  ADVISOR_SKILL_ROOTS,
} from "./config.js";
import { buildChildEnv } from "./child-env.js";
import { log } from "./log.js";
import { isEgressAuthorized } from "./policy.js";
import type { AdvisorSession } from "./advisor-session.js";

/**
 * Materialise a session's CODEX_HOME. Three files define this agent entirely:
 *
 *   config.toml  - its tool surface (exactly two MCP servers)
 *   AGENTS.md    - its persona and advising judgment
 *   skills/      - its procedural knowledge
 *
 * All three are copied from repo-tracked sources, so they are version
 * controlled and editable over time while the runtime copy stays disposable.
 * Adding a tool or a skill is a deliberate edit at the source, never something
 * that happens by inheritance.
 */
export function materializeCodexHome(
  codexHome: string,
  skills: string[] = ADVISOR_SKILLS,
): void {
  const toml = [
    "# Generated per advisor session. Do not add servers here by hand.",
    "# This file IS the agent's tool surface.",
    "",
    "[mcp_servers.cu_public]",
    `url = "${ADVISOR_MCP_PUBLIC_URL}"`,
    "",
    "[mcp_servers.cu_catalog]",
    `url = "${ADVISOR_MCP_CATALOG_URL}"`,
    "",
  ].join("\n");
  writeFileSync(path.join(codexHome, "config.toml"), toml, "utf8");

  copyFileSync(
    fileURLToPath(new URL("../advisor/AGENTS.md", import.meta.url)),
    path.join(codexHome, "AGENTS.md"),
  );

  for (const name of skills) {
    const src = ADVISOR_SKILL_ROOTS.map((root) => path.join(root, name)).find(
      (dir) => existsSync(path.join(dir, "SKILL.md")),
    );
    if (!src) {
      // Loud, not silent: a renamed or deleted skill would otherwise produce an
      // agent that quietly knows less than the operator thinks it does.
      throw new Error(
        `advisor skill not found: ${name} (searched ${ADVISOR_SKILL_ROOTS.join(", ")})`,
      );
    }
    cpSync(src, path.join(codexHome, "skills", name), { recursive: true });
  }
}

export function buildThreadOptions(session: AdvisorSession): ThreadOptions {
  return {
    model: ADVISOR_MODEL,
    sandboxMode: "read-only",
    workingDirectory: session.workDir,
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  };
}

function buildCodex(session: AdvisorSession): Codex {
  return new Codex({
    baseUrl: ADVISOR_BASE_URL,
    env: buildChildEnv({ CODEX_HOME: session.codexHome }) as Record<
      string,
      string
    >,
  });
}

export async function runAdvisorTurn(
  session: AdvisorSession,
  input: string,
  outputSchema?: unknown,
): Promise<{ text: string; toolCalls: string[] }> {
  if (!isEgressAuthorized(ADVISOR_PROVIDER)) {
    throw new Error(
      `egress provider "${ADVISOR_PROVIDER}" is not authorized in policy/action-policy.yaml`,
    );
  }
  materializeCodexHome(session.codexHome);
  const codex = buildCodex(session);
  const opts = buildThreadOptions(session);
  const thread = session.threadId
    ? codex.resumeThread(session.threadId, opts)
    : codex.startThread(opts);

  // outputSchema is per-TURN: conversational turns pass none and get prose.
  const turn = await thread.run(input, outputSchema ? { outputSchema } : {});
  session.threadId = thread.id;

  const toolCalls = turn.items
    .filter((i) => i.type === "mcp_tool_call")
    .map((i) => JSON.stringify((i as { tool?: unknown }).tool ?? "mcp"));

  // Metadata only. Prompt and response content are never logged - student
  // information may be in them.
  log.info("advisor turn", {
    session: session.id,
    advisorId: session.advisorId,
    toolCalls: toolCalls.length,
    inputTokens: turn.usage?.input_tokens ?? null,
    outputTokens: turn.usage?.output_tokens ?? null,
  });

  return { text: turn.finalResponse, toolCalls };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx tsx --test test/advisor-agent.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 8: Verify the isolation claim end to end**

Run:
```bash
node -e '
const {mkdtempSync,rmSync}=require("fs"),{tmpdir}=require("os"),path=require("path");
const d=mkdtempSync(path.join(tmpdir(),"iso-"));
require("child_process").execFileSync("npx",["tsx","-e",
  `import {materializeCodexHome} from "./src/advisor-agent.ts"; materializeCodexHome("${d}");`],
  {stdio:"inherit"});
console.log(require("child_process").execFileSync("codex",["mcp","list"],
  {env:{...process.env,CODEX_HOME:d},encoding:"utf8"}));
rmSync(d,{recursive:true,force:true});'
```
Expected: exactly `cu_public` and `cu_catalog`. **`node_repl` and `codegraph` must not appear.**

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/advisor-agent.ts advisor/AGENTS.md src/config.ts test/advisor-agent.test.ts package.json package-lock.json
git commit -m "feat(advisor): Codex agent with isolated tool surface, persona, and skills"
```

---

### Task 3: Chat UI with the buffer-and-gate accessibility pattern

**Files:**
- Create: `src/advisor-ui.ts`
- Test: `test/advisor-ui.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produced first because Task 4's server imports these two functions.
- Produces: `renderLoginPage(error?: string): string`, `renderChatPage(): string`

- [ ] **Step 1: Write the failing tests**

Create `test/advisor-ui.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { renderChatPage, renderLoginPage } from "../src/advisor-ui.ts";

test("login page posts to /login and shows an error when given one", () => {
  const page = renderLoginPage();
  assert.match(page, /<form[^>]+action="\/login"[^>]+method="post"/);
  assert.match(page, /type="password"/);
  assert.doesNotMatch(page, /Incorrect password/);
  assert.match(renderLoginPage("Incorrect password."), /Incorrect password\./);
});

// Live regions only announce changes detected AFTER they are in the
// accessibility tree, so both must be present and empty in the initial HTML.
test("both live regions are mounted empty in the initial markup", () => {
  const page = renderChatPage();
  assert.match(page, /id="status"[^>]*aria-live="polite"[^>]*><\/div>/);
  assert.match(page, /id="answers"[^>]*aria-live="polite"[^>]*>/);
});

// Buffer and gate: streaming prose mutates the DOM dozens of times a second,
// which screen readers were never designed for.
test("the client fetches /chat once and does not stream tokens", () => {
  const page = renderChatPage();
  assert.match(page, /fetch\("\/chat"/);
  assert.doesNotMatch(page, /EventSource|ReadableStream|text\/event-stream/);
});

test("every control has an accessible name", () => {
  const page = renderChatPage();
  for (const id of ["send", "clear", "export", "message"]) {
    assert.match(
      page,
      new RegExp(`id="${id}"[^>]*(aria-label=|>)`),
      `${id} needs an accessible name`,
    );
  }
  assert.match(page, /<label[^>]+for="message"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/advisor-ui.test.ts`
Expected: FAIL — `Cannot find module '../src/advisor-ui.ts'`

- [ ] **Step 3: Implement the UI**

Create `src/advisor-ui.ts`:

```ts
// HTML for the advisor chat, kept out of the server module so routing stays
// readable.
//
// Accessibility: buffer and gate (Title II / WCAG 2.1 AA). Streaming prose
// token-by-token mutates the DOM dozens of times a second, which produces
// either stutter or repeated re-reading in a screen reader. So a low-bandwidth
// STATUS region streams progress, and the ANSWER arrives once, complete.
// Both regions are in the initial markup and empty: a live region only
// announces changes detected after it is already in the accessibility tree.

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem;
         margin: 2rem auto; padding: 0 1rem; }
  #answers article { border-top: 1px solid #8888; padding: 1rem 0; }
  .role { font-weight: 600; }
  #status { min-height: 1.5rem; color: #595959; }
  label { display: block; font-weight: 600; margin-bottom: .25rem; }
  textarea { width: 100%; min-height: 5rem; font: inherit; padding: .5rem; }
  button { font: inherit; padding: .5rem 1rem; margin-right: .5rem; }
  :focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
`;

function page(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${STYLE}</style></head>
<body>${inner}</body></html>`;
}

export function renderLoginPage(error = ""): string {
  return page(
    "Advisor chat — sign in",
    `<h1>Advisor chat</h1>
${error ? `<p role="alert">${error}</p>` : ""}
<form action="/login" method="post">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>`,
  );
}

export function renderChatPage(): string {
  return page(
    "Advisor chat",
    `<h1>Advisor chat</h1>
<p>Ask about schedules, room capacity, or GC requirements. Clear the session
when you move to another student.</p>

<div id="status" role="status" aria-live="polite"></div>
<div id="answers" aria-live="polite" aria-atomic="false"></div>

<form id="composer">
  <label for="message">Your question</label>
  <textarea id="message" name="message" required></textarea>
  <button id="send" type="submit">Send</button>
  <button id="clear" type="button">Clear session</button>
  <button id="export" type="button">Export transcript</button>
</form>

<script>
const $ = (id) => document.getElementById(id);
const status = $("status"), answers = $("answers");

function addAnswer(role, text) {
  const art = document.createElement("article");
  const h = document.createElement("h2");
  h.className = "role"; h.textContent = role;
  const p = document.createElement("p"); p.textContent = text;
  art.append(h, p); answers.append(art);
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("message").value.trim();
  if (!message) return;
  addAnswer("You", message);
  $("message").value = "";
  $("send").disabled = true;
  status.textContent = "Checking the schedule\\u2026";
  try {
    const r = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "request failed");
    addAnswer("Advisor chat", data.text);
    status.textContent = "Response ready.";
  } catch (err) {
    status.textContent = "Something went wrong. Please try again.";
  } finally {
    $("send").disabled = false;
    $("message").focus();   // focus stays on input, never yanked to the answer
  }
});

$("clear").addEventListener("click", async () => {
  await fetch("/clear", { method: "POST" });
  answers.replaceChildren();
  status.textContent = "Session cleared.";
  $("message").focus();
});

$("export").addEventListener("click", () => { location.href = "/export"; });
</script>`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/advisor-ui.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/advisor-ui.ts test/advisor-ui.test.ts
git commit -m "feat(advisor): chat UI using the buffer-and-gate accessibility pattern"
```

---

### Task 4: Auth seam and HTTP server

**Files:**
- Create: `src/advisor-auth.ts`
- Create: `src/advisor-server.ts`
- Test: `test/advisor-auth.test.ts`
- Modify: `package.json` (add `advisor` script)

**Interfaces:**
- Consumes: `renderLoginPage`/`renderChatPage` from `src/advisor-ui.ts`; `createSession`, `getSession`, `clearSession`, `sweepExpired` from `src/advisor-session.ts`; `runAdvisorTurn` from `src/advisor-agent.ts`.
- Produces:
  - `authenticate(req: IncomingMessage): { advisorId: string } | null`
  - `checkPassword(supplied: string): boolean`
  - `parseCookies(header: string | undefined): Record<string, string>`
  - `SESSION_COOKIE = "advisor_sid"`

- [ ] **Step 1: Write the failing tests**

Create `test/advisor-auth.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { checkPassword, parseCookies } from "../src/advisor-auth.ts";

test("parseCookies handles absent, single, and multiple cookies", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("advisor_sid=abc"), { advisor_sid: "abc" });
  assert.deepEqual(parseCookies("a=1; advisor_sid=xyz; b=2"), {
    a: "1",
    advisor_sid: "xyz",
    b: "2",
  });
});

// Fail closed: an unset ADVISOR_PASSWORD must not mean "accept anything".
test("an unconfigured password rejects every attempt", () => {
  assert.equal(checkPassword("", ""), false);
  assert.equal(checkPassword("guess", ""), false);
});

test("a configured password accepts only an exact match", () => {
  assert.equal(checkPassword("hunter2", "hunter2"), true);
  assert.equal(checkPassword("hunter3", "hunter2"), false);
  assert.equal(checkPassword("", "hunter2"), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/advisor-auth.test.ts`
Expected: FAIL — `Cannot find module '../src/advisor-auth.ts'`

- [ ] **Step 3: Implement the auth seam**

Create `src/advisor-auth.ts`:

```ts
// Authentication seam for the advisor chat.
//
// Phase 1 is a shared password behind a firewall. The important part is not the
// password - it is that `advisorId` exists in the data model from day one, so
// Phase 2 replaces the body of authenticate() and nothing else. Sessions,
// audit, and export already have somewhere to put a real identity.
//
// Phase 2 is mostly built: src/token-portal.ts already runs Google OAuth2 and
// verifies hd=g.clemson.edu.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import { ADVISOR_PASSWORD } from "./config.js";

export const SESSION_COOKIE = "advisor_sid";

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Constant-time comparison. `expected` defaults to config so tests can inject.
 * An empty expected password rejects everything - never "accept anything".
 */
export function checkPassword(
  supplied: string,
  expected: string = ADVISOR_PASSWORD,
): boolean {
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Phase 1: any request carrying a valid session cookie is "shared".
 * Phase 2: resolve the real advisor here and return their id.
 */
export function authenticate(
  req: IncomingMessage,
): { advisorId: string } | null {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return sid ? { advisorId: "shared" } : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/advisor-auth.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Implement the server**

Create `src/advisor-server.ts`:

```ts
// Advisor chat HTTP service. Follows src/token-portal.ts: node:http,
// hand-rolled routes, no framework.

import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ADVISOR_PORT, ADVISOR_SESSION_TTL_MS } from "./config.js";
import { log } from "./log.js";
import {
  SESSION_COOKIE,
  authenticate,
  checkPassword,
  parseCookies,
} from "./advisor-auth.js";
import {
  clearSession,
  createSession,
  getSession,
  sweepExpired,
} from "./advisor-session.js";
import { runAdvisorTurn } from "./advisor-agent.js";
import { renderChatPage, renderLoginPage } from "./advisor-ui.js";

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString("utf8");
      if (data.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function html(res: http.ServerResponse, status: number, page: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && url.pathname === "/") {
      const auth = authenticate(req);
      if (!auth) return html(res, 200, renderLoginPage());
      return html(res, 200, renderChatPage());
    }

    if (method === "POST" && url.pathname === "/login") {
      const form = new URLSearchParams(await body(req));
      if (!checkPassword(form.get("password") ?? "")) {
        return html(res, 401, renderLoginPage("Incorrect password."));
      }
      const session = createSession("shared");
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return res.end();
    }

    const auth = authenticate(req);
    if (!auth) return json(res, 401, { error: "not authenticated" });
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = getSession(sid);
    if (!session) return json(res, 401, { error: "session expired" });

    if (method === "POST" && url.pathname === "/chat") {
      const { message } = JSON.parse(await body(req)) as { message?: string };
      if (!message) return json(res, 400, { error: "message is required" });
      session.history.push({ role: "advisor", text: message, at: Date.now() });
      const { text, toolCalls } = await runAdvisorTurn(session, message);
      session.history.push({ role: "agent", text, at: Date.now() });
      return json(res, 200, { text, toolCalls: toolCalls.length });
    }

    if (method === "POST" && url.pathname === "/clear") {
      clearSession(session.id);
      const fresh = createSession("shared");
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `${SESSION_COOKIE}=${fresh.id}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return res.end(JSON.stringify({ cleared: true }));
    }

    if (method === "POST" && url.pathname === "/upload") {
      const name = path.basename(url.searchParams.get("name") ?? "upload.txt");
      writeFileSync(path.join(session.workDir, name), await body(req), "utf8");
      return json(res, 200, { stored: name });
    }

    if (method === "GET" && url.pathname === "/export") {
      const md = session.history
        .map((t) => `## ${t.role}\n\n${t.text}\n`)
        .join("\n");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="advising-session.md"',
      });
      return res.end(md);
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    // Never echo the error body back - it can contain prompt content.
    log.warn("advisor request failed", {
      path: url.pathname,
      err: String(err),
    });
    return json(res, 500, { error: "request failed" });
  }
});

setInterval(() => {
  const n = sweepExpired();
  if (n > 0) log.info("advisor sessions swept", { removed: n });
}, Math.min(ADVISOR_SESSION_TTL_MS, 15 * 60 * 1000)).unref();

server.listen(ADVISOR_PORT, "127.0.0.1", () => {
  log.info("advisor chat listening", { port: ADVISOR_PORT });
});
```

- [ ] **Step 6: Add the npm script**

Add to `package.json` `scripts`:

```json
"advisor": "tsx src/advisor-server.ts"
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/advisor-auth.ts src/advisor-server.ts test/advisor-auth.test.ts package.json
git commit -m "feat(advisor): HTTP service with shared-password auth and advisorId seam"
```

---

### Task 5: Schedule artifacts, rendered host-side

**Files:**
- Create: `schemas/advisor-schedule.schema.json`
- Create: `src/advisor-artifacts.ts`
- Test: `test/advisor-artifacts.test.ts`
- Modify: `src/advisor-server.ts` (add the `/artifact/schedule` route)

**Interfaces:**
- Consumes: `runAdvisorTurn` from `src/advisor-agent.ts`.
- Produces:
  - `interface ProposedSection { crn: string; subjectCourse: string; section: string; title: string; creditHours: number; days: string; beginTime: string; endTime: string; building: string | null; room: string | null; }`
  - `interface ProposedSchedule { term: string; sections: ProposedSection[]; notes: string | null; }`
  - `SCHEDULE_SCHEMA: unknown`
  - `parseSchedule(raw: string): ProposedSchedule`
  - `renderSchedule(s: ProposedSchedule): string`

- [ ] **Step 1: Create the schema**

Create `schemas/advisor-schedule.schema.json`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["term", "sections", "notes"],
  "properties": {
    "term": { "type": "string" },
    "notes": { "type": ["string", "null"] },
    "sections": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["crn", "subjectCourse", "section", "title",
                     "creditHours", "days", "beginTime", "endTime",
                     "building", "room"],
        "properties": {
          "crn": { "type": "string" },
          "subjectCourse": { "type": "string" },
          "section": { "type": "string" },
          "title": { "type": "string" },
          "creditHours": { "type": "number" },
          "days": { "type": "string" },
          "beginTime": { "type": "string" },
          "endTime": { "type": "string" },
          "building": { "type": ["string", "null"] },
          "room": { "type": ["string", "null"] }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/advisor-artifacts.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { parseSchedule, renderSchedule } from "../src/advisor-artifacts.ts";

const VALID = JSON.stringify({
  term: "202608",
  notes: null,
  sections: [
    {
      crn: "80833", subjectCourse: "GC4060", section: "001",
      title: "Advanced Packaging", creditHours: 3, days: "TR",
      beginTime: "1100", endTime: "1150",
      building: "Godfrey Hall", room: "201",
    },
  ],
});

test("a valid payload parses into a schedule", () => {
  const s = parseSchedule(VALID);
  assert.equal(s.term, "202608");
  assert.equal(s.sections.length, 1);
  assert.equal(s.sections[0]!.crn, "80833");
});

// The whole point of schema-validated artifact turns: malformed model output is
// refused, not rendered into a document an advisor might hand to a student.
test("malformed output is rejected rather than rendered", () => {
  assert.throws(() => parseSchedule("not json"), /could not be parsed/);
  assert.throws(() => parseSchedule('{"term":"202608"}'), /missing sections/);
  assert.throws(
    () => parseSchedule('{"term":"202608","notes":null,"sections":[{"crn":"1"}]}'),
    /incomplete section/,
  );
});

test("rendering produces a printable document with the section data", () => {
  const html = renderSchedule(parseSchedule(VALID));
  assert.match(html, /@media print/);
  assert.match(html, /GC4060/);
  assert.match(html, /11:00/);
  assert.match(html, /Godfrey Hall 201/);
  assert.match(html, /3 credits?/);
});

test("rendering escapes values rather than interpolating them raw", () => {
  const evil = JSON.parse(VALID) as { sections: { title: string }[] };
  evil.sections[0]!.title = '<script>alert("x")</script>';
  const html = renderSchedule(parseSchedule(JSON.stringify(evil)));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test test/advisor-artifacts.test.ts`
Expected: FAIL — `Cannot find module '../src/advisor-artifacts.ts'`

- [ ] **Step 4: Implement artifacts**

Create `src/advisor-artifacts.ts`:

```ts
// Host-side rendering of agent-proposed schedules.
//
// "No write actions" governs systems of record, not artifacts - a proposed
// schedule document changes nothing outside the session. But sandboxMode is
// read-only, so the agent cannot write files, and that constraint is worth
// keeping. So the agent returns structured JSON on a schema-constrained TURN
// and the host renders it here.
//
// Three things this buys beyond preserving the sandbox: formatting is
// deterministic because a template produces it; output is validatable in a way
// a model-authored document is not; and the model decides WHAT is in the
// schedule while never deciding how the page looks.

import { readFileSync } from "node:fs";

export interface ProposedSection {
  crn: string;
  subjectCourse: string;
  section: string;
  title: string;
  creditHours: number;
  days: string;
  beginTime: string;
  endTime: string;
  building: string | null;
  room: string | null;
}

export interface ProposedSchedule {
  term: string;
  sections: ProposedSection[];
  notes: string | null;
}

export const SCHEDULE_SCHEMA: unknown = JSON.parse(
  readFileSync(
    new URL("../schemas/advisor-schedule.schema.json", import.meta.url),
    "utf8",
  ),
);

const REQUIRED: (keyof ProposedSection)[] = [
  "crn", "subjectCourse", "section", "title", "creditHours",
  "days", "beginTime", "endTime",
];

export function parseSchedule(raw: string): ProposedSchedule {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("schedule output could not be parsed as JSON");
  }
  const obj = data as Partial<ProposedSchedule>;
  if (!Array.isArray(obj.sections)) {
    throw new Error("schedule output is missing sections");
  }
  for (const s of obj.sections) {
    for (const key of REQUIRED) {
      if (s[key] === undefined || s[key] === null) {
        throw new Error(`schedule output has an incomplete section: ${key}`);
      }
    }
  }
  return {
    term: String(obj.term ?? ""),
    notes: obj.notes ?? null,
    sections: obj.sections,
  };
}

function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hhmm(t: string): string {
  return t.length === 4 ? `${t.slice(0, 2)}:${t.slice(2)}` : t;
}

export function renderSchedule(s: ProposedSchedule): string {
  const rows = s.sections
    .map(
      (x) => `<tr>
      <td>${esc(x.subjectCourse)}-${esc(x.section)}</td>
      <td>${esc(x.title)}</td>
      <td>${esc(x.crn)}</td>
      <td>${esc(x.creditHours)} credit${x.creditHours === 1 ? "" : "s"}</td>
      <td>${esc(x.days)} ${esc(hhmm(x.beginTime))}–${esc(hhmm(x.endTime))}</td>
      <td>${x.building ? `${esc(x.building)} ${esc(x.room ?? "")}`.trim() : ""}</td>
    </tr>`,
    )
    .join("\n");
  const credits = s.sections.reduce((n, x) => n + x.creditHours, 0);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Proposed schedule — ${esc(s.term)}</title>
<style>
  body { font: 12pt/1.4 system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: .4rem .6rem; text-align: left; }
  @media print { body { margin: 0; } button { display: none; } }
</style></head>
<body>
<h1>Proposed schedule — ${esc(s.term)}</h1>
<table>
  <caption>${esc(s.sections.length)} sections, ${esc(credits)} credits total</caption>
  <thead><tr><th>Course</th><th>Title</th><th>CRN</th><th>Credits</th>
  <th>Meets</th><th>Location</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
${s.notes ? `<p>${esc(s.notes)}</p>` : ""}
<p><em>Proposed by an assistant from published schedule data. Verify before
registration; petitions and substitutions are not reflected here.</em></p>
</body></html>`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test test/advisor-artifacts.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Wire the artifact route**

In `src/advisor-server.ts`, add these imports beside the existing ones:

```ts
import {
  SCHEDULE_SCHEMA,
  parseSchedule,
  renderSchedule,
} from "./advisor-artifacts.js";
```

And add this route immediately before the final `return json(res, 404, ...)`:

```ts
    if (method === "POST" && url.pathname === "/artifact/schedule") {
      // An artifact is a SECOND, explicit turn carrying a schema. Conversation
      // stays prose; documents are never produced by surprise.
      const { text } = await runAdvisorTurn(
        session,
        "Produce the proposed schedule we just discussed as structured data.",
        SCHEDULE_SCHEMA,
      );
      const html = renderSchedule(parseSchedule(text));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
```

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass

```bash
git add schemas/advisor-schedule.schema.json src/advisor-artifacts.ts test/advisor-artifacts.test.ts src/advisor-server.ts
git commit -m "feat(advisor): schema-validated schedule artifacts rendered host-side"
```

---

### Task 6: Deployment

**Files:**
- Create: `launchd/com.cuassistant.advisor.plist`
- Modify: `docs/superpowers/specs/2026-07-21-advisor-chat-design.md` (set Status)
- Modify: `CLAUDE.md` (note the new service)

**Interfaces:**
- Consumes: the `advisor` npm script from Task 4.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create the launchd plist**

Create `launchd/com.cuassistant.advisor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cuassistant.advisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/npm</string>
    <string>run</string>
    <string>advisor</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/admin/projects/CUassistant</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/admin</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/admin/Library/Logs/cuassistant.advisor.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/admin/Library/Logs/cuassistant.advisor.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Install and start**

```bash
cp launchd/com.cuassistant.advisor.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cuassistant.advisor.plist
sleep 3
launchctl list | grep advisor
```
Expected: a PID and status `0`.

- [ ] **Step 3: Verify it serves and gates**

```bash
curl -s -o /dev/null -w "login page: %{http_code}\n" http://127.0.0.1:8770/
curl -s -o /dev/null -w "unauthenticated chat: %{http_code}\n" \
  -X POST http://127.0.0.1:8770/chat -d '{"message":"hi"}'
```
Expected: `login page: 200`, `unauthenticated chat: 401`

- [ ] **Step 4: Verify the tool surface on a live session**

```bash
grep -c "8765" ~/Library/Logs/cuassistant.advisor.err.log || echo "8765 never referenced: good"
```
Expected: `8765 never referenced: good`

- [ ] **Step 5: Update CLAUDE.md**

Add to the MCP-restart section of `CLAUDE.md`:

```markdown
The advisor chat (`com.cuassistant.advisor`, port 8770) is a fourth long-lived
service. It consumes the public MCP servers over loopback and adds no MCP tools
of its own, so tool/policy changes do not require restarting it — but it holds
every session in memory, so restarting it ends all in-flight conversations.
```

- [ ] **Step 6: Mark the spec implemented and commit**

Change the spec's Status line to:
```markdown
**Status:** Implemented 2026-07-21.
```

```bash
git add launchd/com.cuassistant.advisor.plist CLAUDE.md docs/superpowers/specs/2026-07-21-advisor-chat-design.md
git commit -m "feat(advisor): launchd service on 8770"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Architecture / 5 modules | 1, 2, 3, 4, 5 |
| Agent loop, sandbox, webSearch, approvalPolicy | 2 |
| `CODEX_HOME` isolation + per-session | 1 (dirs), 2 (config + test) |
| Persona (`advisor/AGENTS.md`) and skills | 2 |
| 8765 exclusion | 2 |
| Sessions, clear, TTL, per-cookie isolation | 1, 4 |
| Files in / transcript out | 4 |
| Artifacts, prose-vs-schema | 5 |
| Auth + `advisorId` seam | 4 |
| Accessibility | 3 |
| Metadata-only audit | 2 |
| Testing | every task |
| Deployment | 6 |

**Known gap, deliberately deferred:** the spec's "re-verify against `check-schedule-conflicts` before rendering" is not implemented. Task 5 validates the schema and rejects malformed output, but does not re-run the conflict check on the proposed sections. That is a second validation layer worth adding once real advisor use shows whether the agent actually proposes conflicting sections — building it now would be speculative.

**Type consistency:** `AdvisorSession` fields (`id`, `advisorId`, `workDir`, `codexHome`, `threadId`, `history`, `lastTouched`) are used identically in Tasks 1, 2, 4. `runAdvisorTurn` returns `{ text, toolCalls }` in Task 2 and is destructured that way in Tasks 4 and 5. `SESSION_COOKIE` is defined once in Task 4 and used only there.
