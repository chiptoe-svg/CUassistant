# Handoff: `feature/gc-curriculum-mcp` — review + merge

Built in isolation by the gc_advisor session. Please review and do the final
merge/push, since you own this repo's conventions, governance, and the
in-flight WIP. 7 feature commits on top of `main`.

## What it adds
A public, read-only `cuassistant-curriculum` MCP server (port **8767**,
stdio default / loopback-HTTP via `MCP_TRANSPORT=http`, `auth:{kind:"open"}`)
exposing Clemson GC curriculum. Tools: `list-gc-catalog-years`,
`get-gc-program-plan`. It **bridges to the separate gc_advisor project** by
shelling out to `gc_advisor/scripts/query.py` (JSON) — gc_advisor stays the
single source of truth; no curriculum logic is reimplemented in TS.

## Files
- `src/config.ts` — `GC_ADVISOR_PYTHON/QUERY/DB` bridge consts + `MCP_CURRICULUM_HTTP_PORT` (8767)
- `src/gc-curriculum.ts` — data layer (injectable `QueryRunner`; spawns query.py)
- `src/mcp-tools/curriculum.ts` — the two `McpToolDefinition`s + `registerTools`
- `src/mcp-tools/index-curriculum.ts` — barrel
- `src/mcp-curriculum.ts` — entry (mirrors `mcp-public.ts`)
- `src/mcp-tools/permissions.ts` — 2 ops in `MCP_ALLOWED_OPERATIONS` + `SCOPE_OPERATIONS.clemson`
- `policy/action-policy.yaml` — 2 `approval:none` actions (`surface: external_read, risk: low, reversibility: read_only, constraints: [public_data_only]`)
- `package.json` — `mcp:curriculum` + `mcp:curriculum:http` scripts
- `launchd/com.cuassistant.mcp-curriculum-http.plist` — auto-start service (added per your note; mirrors the public-HTTP plist; port 8767; logs to `cuassistant.mcp-curriculum.{out,err}.log`)
- `test/curriculum-tools.test.ts` — data-layer + handler tests
- `docs/mcp-curriculum.md` — run/register/auto-start doc; design in `docs/superpowers/plans/2026-06-23-gc-curriculum-mcp-server.md`

## Verified
- `npm run typecheck` clean
- `npm test` 127/127
- Server boots + registers both tools: `cuassistant-curriculum http on 127.0.0.1:8767 … tools: list-gc-catalog-years, get-gc-program-plan`
- Live end-to-end (real gc_advisor DB): returns 9 catalog years + `total_credits: 120`
- husky/prettier applied per commit

## ⚠️ Working-tree WIP to NOT conflate
`M src/clemson-classes.ts`, `M src/mcp-tools/clemson-classes.ts`, `?? .env.bak`,
`?? scripts/mcp-public-bridge.mjs` are **pre-existing, not part of this branch** —
every commit used targeted `git add`, so the branch excludes them. They are
yours; don't assume they belong to this feature.

## Please bless (repo-governance calls inferred by the gc_advisor session)
1. Exposing these 2 ops as **public/open** (loopback) — intended?
2. The `policy/action-policy.yaml` entries match house style?
3. **Deploy topology:** bridge assumes gc_advisor on the **same machine/mount**
   (`GC_ADVISOR_PYTHON/QUERY/DB`, default `/Users/admin/projects/gc_advisor`).
   Confirm, or set env overrides (also settable in the launchd plist).
4. A **separate server entry** (own port 8767) vs folding curriculum tools into
   `cuassistant-public` — chose separate; your call.
5. Add `mcp_curriculum 8767` to `~/.dev-ports.yaml`.

## Deferred (next, gc_advisor side)
`get-gc-minor-requirements` (needs a gc_advisor `query.py program-rule`
subcommand + the minors data, which is backfilling now) and `get-gc-course`
(needs gc_advisor course ingestion). Both register as additional tools here when
those land.
