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
- `list-gc-catalog-years` -> `{ years: ["2026-2027", ...] }`
- `get-gc-program-plan` (args: `year` required, `name` default
  "Graphic Communications, BS") -> full degree plan JSON.

## Register with Claude Code (stdio example)
```bash
claude mcp add gc-curriculum -- npm --prefix /Users/admin/projects/CUassistant run -s mcp:curriculum
```

## Future tools (deferred)
- `get-gc-minor-requirements` (needs a gc_advisor `query.py program-rule`
  subcommand + the minors data)
- `get-gc-course` (needs gc_advisor course-catalog ingestion)
