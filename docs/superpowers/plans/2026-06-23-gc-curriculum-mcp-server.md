# GC Curriculum MCP Server (in CUassistant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, read-only "GC curriculum" MCP server to the CUassistant repo that exposes Clemson Graphic Communications degree-plan data, reusing CUassistant's existing `startMcpServer` framework and bridging to the separate `gc_advisor` project via its `query.py` CLI.

**Architecture:** A new public MCP server entry (`src/mcp-curriculum.ts`) mirrors `mcp-public.ts` and reuses `startMcpServer` (stdio default, loopback HTTP, `auth:{kind:"open"}`). A data layer (`src/gc-curriculum.ts`) shells out to gc_advisor's Python `query.py` (which emits JSON) so gc_advisor stays the single source of truth — no curriculum logic is reimplemented in TS. A tool module (`src/mcp-tools/curriculum.ts`) wraps the data layer as `McpToolDefinition`s following the `clemson-classes.ts` pattern.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (existing), `tsx`, `node --test`. Bridges to gc_advisor (Python/SQLite) on the same machine.

**Scope (first cut):** two tools that work against the *existing* `query.py` today — `list-gc-catalog-years` and `get-gc-program-plan`. The `get-gc-minor-requirements` and `get-gc-course` tools are deferred (they need a new `query.py` subcommand on the gc_advisor side plus the in-flight minors data / Phase 2B courses).

**Conventions verified in-repo (2026-06-23):**
- `McpToolDefinition = {operation, tool: Tool, handler}`; helpers `okJson(data)`, `err(text)`, `permissionErr(e)` in `src/mcp-tools/types.ts`.
- Handlers call `assertMcpOperation(op)` first (`try/catch → permissionErr`).
- A tool module ends with `registerTools([...])`; a barrel imports it for side effects; an entry imports the barrel + calls `startMcpServer`.
- New operations must be registered in `src/mcp-tools/permissions.ts` in **two** places: the `MCP_ALLOWED_OPERATIONS` map AND the public-operations list (~line 570 where the `clemson.*` ops are listed), AND get an `approval: none` action in `policy/action-policy.yaml`.
- `backend: "external-http"` is the precedent for public no-auth Clemson data.
- Public server config: `MCP_TRANSPORT` (stdio/http), `MCP_HTTP_HOST` (127.0.0.1), public port pattern like `MCP_PUBLIC_HTTP_PORT` (8766).
- Tests: `node --import tsx --test test/**/*.test.ts`; pre-commit husky runs `format:check`/gitleaks — run `npm run format` + `npm run typecheck` before committing.

---

## File Structure

```
CUassistant/
├── src/
│   ├── config.ts                     # (modify) GC_ADVISOR_* paths + MCP_CURRICULUM_HTTP_PORT
│   ├── gc-curriculum.ts              # (new) data layer: spawn gc_advisor query.py, parse JSON
│   ├── mcp-curriculum.ts             # (new) public server entry (mirrors mcp-public.ts)
│   └── mcp-tools/
│       ├── permissions.ts            # (modify) register 2 operations (map + public list)
│       ├── curriculum.ts             # (new) tool definitions + registerTools
│       └── index-curriculum.ts       # (new) barrel
├── policy/action-policy.yaml         # (modify) 2 approval:none actions
├── package.json                      # (modify) mcp:curriculum scripts
├── docs/mcp-curriculum.md            # (new) how to register the server with an agent
└── test/
    └── curriculum-tools.test.ts      # (new) data-layer + tool-handler tests
```

---

## Task 1: Config — gc_advisor bridge paths + curriculum port

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add config constants.** Append near the other `MCP_*` exports in `src/config.ts`:

```ts
// --- GC curriculum bridge (gc_advisor project, same machine) ---
// The curriculum MCP server shells out to gc_advisor's query.py (JSON out),
// keeping gc_advisor's CatalogAccess the single source of truth.
export const GC_ADVISOR_PYTHON =
  process.env.GC_ADVISOR_PYTHON || "/Users/admin/projects/gc_advisor/.venv/bin/python";
export const GC_ADVISOR_QUERY =
  process.env.GC_ADVISOR_QUERY || "/Users/admin/projects/gc_advisor/scripts/query.py";
export const GC_ADVISOR_DB =
  process.env.GC_ADVISOR_DB || "/Users/admin/projects/gc_advisor/db/gc_advisor.db";

// Public GC curriculum MCP server port (loopback HTTP transport).
export const MCP_CURRICULUM_HTTP_PORT = Number(
  process.env.MCP_CURRICULUM_HTTP_PORT || 8767,
);
```

- [ ] **Step 2: Typecheck** — Run: `npm run typecheck`
Expected: passes (no type errors).

- [ ] **Step 3: Commit**

```bash
npm run format
git add src/config.ts
git commit -m "feat(curriculum): add gc_advisor bridge config + curriculum MCP port"
```

---

## Task 2: Data layer — bridge to gc_advisor query.py

**Files:**
- Create: `src/gc-curriculum.ts`, `test/curriculum-tools.test.ts`

- [ ] **Step 1: Write the failing test** — `test/curriculum-tools.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { listGcCatalogYears, getGcProgramPlan } from "../src/gc-curriculum.ts";

test("listGcCatalogYears calls the runner with ['years'] and parses JSON", async () => {
  const run = async (args: string[]) => {
    assert.deepEqual(args, ["years"]);
    return JSON.stringify(["2026-2027", "2025-2026"]);
  };
  const years = await listGcCatalogYears(run);
  assert.deepEqual(years, ["2026-2027", "2025-2026"]);
});

test("getGcProgramPlan passes year+name and parses the plan JSON", async () => {
  const run = async (args: string[]) => {
    assert.deepEqual(args, [
      "program-plan", "--year", "2026-2027", "--name", "Graphic Communications, BS",
    ]);
    return JSON.stringify({ total_credits: 120, groups: [] });
  };
  const plan = await getGcProgramPlan("2026-2027", "Graphic Communications, BS", run);
  assert.equal((plan as { total_credits: number }).total_credits, 120);
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node --import tsx --test test/curriculum-tools.test.ts`
Expected: FAIL (cannot find module `../src/gc-curriculum.ts`).

- [ ] **Step 3: Write `src/gc-curriculum.ts`**:

```ts
// GC curriculum data layer — bridges to the gc_advisor project's query.py CLI
// (JSON in/out) so gc_advisor's CatalogAccess stays the single source of truth.
// Read-only; the curriculum DB holds public catalog data.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GC_ADVISOR_PYTHON, GC_ADVISOR_QUERY, GC_ADVISOR_DB } from "./config.js";

const execFileAsync = promisify(execFile);

/** Runs gc_advisor's query.py with the given subcommand args, returns stdout. */
export type QueryRunner = (args: string[]) => Promise<string>;

const defaultRunner: QueryRunner = async (args) => {
  const { stdout } = await execFileAsync(
    GC_ADVISOR_PYTHON,
    [GC_ADVISOR_QUERY, "--db", GC_ADVISOR_DB, ...args],
    { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
  );
  return stdout;
};

export async function listGcCatalogYears(
  run: QueryRunner = defaultRunner,
): Promise<string[]> {
  const out = await run(["years"]);
  return JSON.parse(out) as string[];
}

export async function getGcProgramPlan(
  year: string,
  name: string,
  run: QueryRunner = defaultRunner,
): Promise<unknown> {
  const out = await run(["program-plan", "--year", year, "--name", name]);
  return JSON.parse(out);
}
```

- [ ] **Step 4: Run tests** — Run: `node --import tsx --test test/curriculum-tools.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add a guarded live integration test** (skips when gc_advisor isn't present). Append to `test/curriculum-tools.test.ts`:

```ts
import fs from "node:fs";
import { GC_ADVISOR_DB } from "../src/config.ts";
import { listGcCatalogYears as listLive } from "../src/gc-curriculum.ts";

test("listGcCatalogYears against the real gc_advisor DB", { skip: !fs.existsSync(GC_ADVISOR_DB) }, async () => {
  const years = await listLive();
  assert.ok(Array.isArray(years) && years.length > 0);
  assert.ok(years.every((y) => /^\d{4}-\d{4}$/.test(y)));
});
```

- [ ] **Step 6: Run the suite** — Run: `node --import tsx --test test/curriculum-tools.test.ts`
Expected: 2 unit tests pass; the live test passes if `db/gc_advisor.db` exists (it does on this machine), else is skipped. Report which.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck && npm run format
git add src/gc-curriculum.ts test/curriculum-tools.test.ts
git commit -m "feat(curriculum): gc_advisor query.py bridge (years + program-plan)"
```

---

## Task 3: Register operations (permissions + policy)

**Files:**
- Modify: `src/mcp-tools/permissions.ts`, `policy/action-policy.yaml`

- [ ] **Step 1: Add the two operations to the `MCP_ALLOWED_OPERATIONS` map** in `src/mcp-tools/permissions.ts`, immediately after the existing `clemson.room_availability` entry:

```ts
  "clemson.gc_catalog_years": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_catalog_years",
  },
  "clemson.gc_program_plan": {
    backend: "external-http",
    status: "active",
    policyActionId: "clemson.gc_program_plan",
  },
```

- [ ] **Step 2: Add the two operations to the public-operations list** (~line 570 in `permissions.ts`, where `"clemson.list_terms" … "clemson.room_availability"` are listed for the open/public server). Add, after `"clemson.room_availability",`:

```ts
    "clemson.gc_catalog_years",
    "clemson.gc_program_plan",
```

- [ ] **Step 3: Add matching policy actions.** Open `policy/action-policy.yaml`, find the existing `clemson.list_terms` action, and add two analogous actions with the SAME field shape and `approval: none`:

```yaml
clemson.gc_catalog_years:
  approval: none
  description: List Clemson catalog years available for GC curriculum lookups (public, read-only).
clemson.gc_program_plan:
  approval: none
  description: Get a Clemson program's semester-by-semester degree plan for a catalog year (public, read-only).
```

(Match the exact indentation/structure of the existing `clemson.list_terms` entry — if it nests under a top-level key or uses different field names, mirror that precisely.)

- [ ] **Step 4: Verify the policy + permissions load** — Run: `npm run typecheck`
Expected: passes. Then confirm there is no existing test that asserts a fixed operation count that your additions would break: `node --import tsx --test test/mcp-scopes.test.ts test/mcp-policy.test.ts test/mcp-activation.test.ts`
Expected: PASS. If a test asserts an exact list/count of operations, update that test's expectations to include the two new `clemson.gc_*` operations (this is a legitimate expected change, not a weakening).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/mcp-tools/permissions.ts policy/action-policy.yaml test/
git commit -m "feat(curriculum): expose gc_catalog_years + gc_program_plan operations (public)"
```

---

## Task 4: Tool module

**Files:**
- Create: `src/mcp-tools/curriculum.ts`
- Modify: `test/curriculum-tools.test.ts` (add handler tests)

- [ ] **Step 1: Write `src/mcp-tools/curriculum.ts`** (mirrors `clemson-classes.ts`; exports the defs so they can be unit-tested):

```ts
// Public GC curriculum tools — backed by the gc_advisor project's query.py CLI
// (see src/gc-curriculum.ts). Read-only, public catalog data, no credentials.
import { getGcProgramPlan, listGcCatalogYears } from "../gc-curriculum.js";
import { assertMcpOperation } from "./permissions.js";
import { registerTools } from "./server.js";
import { err, okJson, permissionErr, type McpToolDefinition } from "./types.js";

export const catalogYears: McpToolDefinition = {
  operation: "clemson.gc_catalog_years",
  tool: {
    name: "list-gc-catalog-years",
    description:
      "List Clemson catalog years available for Graphic Communications " +
      'curriculum lookups, e.g. "2026-2027". Read-only, no login. Pass a ' +
      "returned year to get-gc-program-plan.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  async handler() {
    try {
      assertMcpOperation("clemson.gc_catalog_years");
    } catch (e) {
      return permissionErr(e);
    }
    try {
      const years = await listGcCatalogYears();
      return okJson({ years });
    } catch (e) {
      return err(
        `GC catalog years unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export const programPlan: McpToolDefinition = {
  operation: "clemson.gc_program_plan",
  tool: {
    name: "get-gc-program-plan",
    description:
      "Get the full semester-by-semester degree plan for a Clemson program " +
      "in a given catalog year: required courses, choice sets (one-of), " +
      "requirement slots, per-term and total credits, and footnotes. " +
      "Read-only, no login. Defaults to the Graphic Communications, BS. " +
      "Get a valid year from list-gc-catalog-years.",
    inputSchema: {
      type: "object" as const,
      properties: {
        year: {
          type: "string",
          description: "Catalog year, e.g. 2026-2027 (from list-gc-catalog-years).",
        },
        name: {
          type: "string",
          description: 'Program name (default "Graphic Communications, BS").',
        },
      },
      required: ["year"],
    },
  },
  async handler(args) {
    try {
      assertMcpOperation("clemson.gc_program_plan");
    } catch (e) {
      return permissionErr(e);
    }
    const year = args.year as string | undefined;
    if (!year) return err("year is required (see list-gc-catalog-years)");
    const name =
      typeof args.name === "string" && args.name
        ? args.name
        : "Graphic Communications, BS";
    try {
      const plan = await getGcProgramPlan(year, name);
      return okJson(plan);
    } catch (e) {
      return err(
        `GC program plan lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

registerTools([catalogYears, programPlan]);
```

- [ ] **Step 2: Add handler tests.** Append to `test/curriculum-tools.test.ts`:

```ts
import { catalogYears, programPlan } from "../src/mcp-tools/curriculum.ts";

test("programPlan handler requires a year", async () => {
  const res = await programPlan.handler({});
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /year is required/);
});

test("tool definitions carry the expected names and operations", () => {
  assert.equal(catalogYears.tool.name, "list-gc-catalog-years");
  assert.equal(catalogYears.operation, "clemson.gc_catalog_years");
  assert.equal(programPlan.tool.name, "get-gc-program-plan");
  assert.equal(programPlan.operation, "clemson.gc_program_plan");
  assert.deepEqual(programPlan.tool.inputSchema.required, ["year"]);
});
```

- [ ] **Step 3: Run tests** — Run: `node --import tsx --test test/curriculum-tools.test.ts`
Expected: PASS. (The `programPlan` no-year test exercises the handler without touching gc_advisor.)

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck && npm run format
git add src/mcp-tools/curriculum.ts test/curriculum-tools.test.ts
git commit -m "feat(curriculum): MCP tools list-gc-catalog-years + get-gc-program-plan"
```

---

## Task 5: Barrel + server entry + scripts

**Files:**
- Create: `src/mcp-tools/index-curriculum.ts`, `src/mcp-curriculum.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the barrel** — `src/mcp-tools/index-curriculum.ts`:

```ts
// src/mcp-tools/index-curriculum.ts
// Public GC curriculum barrel — no credentials. Imported by the
// cuassistant-curriculum entry point (src/mcp-curriculum.ts).
import "./curriculum.js";
```

- [ ] **Step 2: Write the entry** — `src/mcp-curriculum.ts` (mirrors `src/mcp-public.ts`):

```ts
// src/mcp-curriculum.ts
// Public GC curriculum MCP server (no credentials). Bridges to the gc_advisor
// project's query.py for catalog data. Defaults to stdio; serves loopback HTTP
// when MCP_TRANSPORT=http. Holds no secrets and only reads public catalog data.
import "./mcp-tools/index-curriculum.js";
import { startMcpServer } from "./mcp-tools/server.js";
import {
  MCP_TRANSPORT,
  MCP_HTTP_HOST,
  MCP_CURRICULUM_HTTP_PORT,
} from "./config.js";

startMcpServer({
  name: "cuassistant-curriculum",
  transport: MCP_TRANSPORT,
  httpHost: MCP_HTTP_HOST,
  httpPort: MCP_CURRICULUM_HTTP_PORT,
  auth: { kind: "open" }, // public catalog data — loopback-open, no credentials
}).catch((err) => {
  process.stderr.write(
    `[cuassistant-curriculum] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
```

- [ ] **Step 3: Add package.json scripts.** In `package.json` `"scripts"`, after the `mcp:public:http` line:

```json
    "mcp:curriculum": "tsx src/mcp-curriculum.ts",
    "mcp:curriculum:http": "MCP_TRANSPORT=http tsx src/mcp-curriculum.ts",
```

- [ ] **Step 4: Smoke-test the server starts and lists the tools over stdio.** Run:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npx tsx src/mcp-curriculum.ts 2>/tmp/cur-mcp.err | head -c 2000; echo; echo "--- stderr ---"; cat /tmp/cur-mcp.err
```
Expected: a JSON-RPC response whose `result.tools` contains `list-gc-catalog-years` and `get-gc-program-plan`. (stderr shows the `[cuassistant-curriculum]` startup line.) If the MCP SDK's stdio handshake needs an `initialize` first, instead verify via the typecheck + the existing http-integration test pattern in `test/mcp-http-integration.test.ts` adapted to the curriculum entry — but the simplest confirmation is that the process starts without throwing and registers 2 tools (watch the startup log line which prints the tool count).

- [ ] **Step 5: Full typecheck + test suite** — Run: `npm run typecheck && npm test`
Expected: all green (no regressions across the repo).

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/mcp-tools/index-curriculum.ts src/mcp-curriculum.ts package.json
git commit -m "feat(curriculum): public curriculum MCP server entry + scripts"
```

---

## Task 6: Docs — registering the server with an agent

**Files:**
- Create: `docs/mcp-curriculum.md`

- [ ] **Step 1: Write `docs/mcp-curriculum.md`**:

```markdown
# GC Curriculum MCP Server

A public, read-only MCP server exposing Clemson Graphic Communications
curriculum (degree plans by catalog year). It reuses CUassistant's
`startMcpServer` framework and bridges to the `gc_advisor` project's `query.py`
CLI — gc_advisor remains the single source of truth.

## Requirements
- Runs on the **same machine** (or shared mount) as `gc_advisor`: it spawns
  `gc_advisor/.venv/bin/python gc_advisor/scripts/query.py` and reads
  `gc_advisor/db/gc_advisor.db`.
- Override paths via env: `GC_ADVISOR_PYTHON`, `GC_ADVISOR_QUERY`, `GC_ADVISOR_DB`.

## Run
- stdio (local agent): `npm run mcp:curriculum`
- loopback HTTP (containerized agent): `npm run mcp:curriculum:http`
  (binds `MCP_HTTP_HOST`:`MCP_CURRICULUM_HTTP_PORT`, default 127.0.0.1:8767)

## Tools
- `list-gc-catalog-years` → `{ years: ["2026-2027", ...] }`
- `get-gc-program-plan` (args: `year` required, `name` default
  "Graphic Communications, BS") → full degree plan JSON.

## Register with Claude Code (stdio example)
```bash
claude mcp add gc-curriculum -- npm --prefix /Users/admin/projects/CUassistant run -s mcp:curriculum
```

## Future tools (deferred)
- `get-gc-minor-requirements` (needs a gc_advisor `query.py program-rule`
  subcommand + the minors backfill data)
- `get-gc-course` (needs gc_advisor Phase 2B course ingestion)
```

- [ ] **Step 2: Commit**

```bash
npm run format
git add docs/mcp-curriculum.md
git commit -m "docs(curriculum): how to run and register the GC curriculum MCP server"
```

---

## Final verification

- [ ] `npm run typecheck` — clean.
- [ ] `npm test` — full suite green (no regressions).
- [ ] Manual: `npm run mcp:curriculum` starts and its startup log reports 2 registered tools; with the real gc_advisor DB present, `list-gc-catalog-years` returns the catalog years and `get-gc-program-plan --year 2026-2027` returns a 120-credit plan.
- [ ] Confirm gc_advisor was NOT modified (this plan is entirely within the CUassistant repo).

---

## Self-Review notes

- Reuses `startMcpServer` / `registerTools` / `types.ts` helpers — no framework duplication. ✓
- gc_advisor stays source of truth via CLI bridge; no curriculum logic in TS. ✓
- Operations registered in both `permissions.ts` locations + `policy/action-policy.yaml` (else tools silently skip / fail closed). ✓ (Tasks 3)
- Public/open/loopback auth mirrors `mcp-public.ts`. ✓ (Task 5)
- Deferred (not gaps): minor-requirements + course tools (need gc_advisor-side `query.py` additions and Phase 2B data); these are noted in docs and are a follow-up plan once the minors backfill completes and Plan B lands.
- Same-machine constraint documented; HTTP-service bridge is the future escape hatch. ✓ (docs)
