# gc-advisor HTTP Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shell-out from CUassistant's `gc-curriculum.ts` to gc-advisor's `query.py` with a loopback HTTP call to a new Flask API server running in gc-advisor.

**Architecture:** gc-advisor gains a minimal Flask server (`scripts/serve.py`) binding `127.0.0.1:8768`. CUassistant's `gc-curriculum.ts` keeps the injectable `QueryRunner` seam (tests unchanged) but replaces the `defaultRunner` implementation: instead of `execFile python query.py ...`, it now calls `fetch("http://127.0.0.1:8768/...")`. The shell-out code and the `GC_ADVISOR_PYTHON`/`GC_ADVISOR_QUERY` env vars are deprecated (kept in config for backward-compat) and replaced by `GC_ADVISOR_URL`.

**Tech Stack:** Python 3.12 + Flask 3.x (gc_advisor side); Node.js built-in `fetch` (CUassistant side). No new npm deps. One new Python dep.

---

## File Map

| Action | Path |
|--------|------|
| Create | `gc_advisor/scripts/serve.py` |
| Modify | `gc_advisor/pyproject.toml` — add `flask>=3.0` |
| Create | `gc_advisor/tests/test_serve.py` |
| Create | `gc_advisor/launchd/com.gc-advisor.api.plist` |
| Modify | `CUassistant/src/gc-curriculum.ts` — swap `defaultRunner` |
| Modify | `CUassistant/src/config.ts` — add `GC_ADVISOR_URL` |
| Modify | `~/.dev-ports.yaml` — add `gc_advisor_api: 8768` |

Tests in `CUassistant/test/curriculum-tools.test.ts` do **not** need updating — they inject a mock `QueryRunner` directly and never touch the default runner.

---

### Task 1: Add Flask to gc-advisor

**Files:**
- Modify: `/Users/admin/projects/gc_advisor/pyproject.toml`

- [ ] **Step 1: Add flask dependency**

Open `/Users/admin/projects/gc_advisor/pyproject.toml` and change the `dependencies` list:

```toml
[project]
name = "gc-advisor"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["playwright>=1.44", "flask>=3.0"]

[project.optional-dependencies]
dev = ["pytest>=8.0"]
```

- [ ] **Step 2: Install the new dep**

```bash
cd /Users/admin/projects/gc_advisor
.venv/bin/pip install flask>=3.0
```

Expected: `Successfully installed flask-...` (or already satisfied)

- [ ] **Step 3: Verify Flask importable**

```bash
cd /Users/admin/projects/gc_advisor
.venv/bin/python -c "import flask; print(flask.__version__)"
```

Expected: prints a version string like `3.1.0`

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/projects/gc_advisor
git add pyproject.toml
git commit -m "feat: add flask>=3.0 dependency for HTTP API server"
```

---

### Task 2: Write the Flask serve.py

**Files:**
- Create: `/Users/admin/projects/gc_advisor/scripts/serve.py`

- [ ] **Step 1: Write the failing test first** (in Task 3 — skip ahead and write test_serve.py first, then return here)

Actually write the server file directly, tests come in Task 3.

- [ ] **Step 1: Create scripts/serve.py**

```python
# HTTP API shim over CatalogAccess — keeps query.py as the CLI entry point.
# Binds 127.0.0.1:8768 (GC_ADVISOR_PORT env to override).
# Routes: GET /health  /years  /program-plan?year=X&name=Y  /course?code=Z
import os
from pathlib import Path
from flask import Flask, jsonify, request, abort
from gc_advisor.db.access import CatalogAccess

DEFAULT_DB = Path(__file__).parent.parent / "db" / "gc_advisor.db"

app = Flask(__name__)


def _db() -> str:
    return os.environ.get("GC_ADVISOR_DB", str(DEFAULT_DB))


@app.route("/health")
def health():
    return jsonify({"ok": True})


@app.route("/years")
def years():
    return jsonify(CatalogAccess(_db()).list_catalog_years())


@app.route("/program-plan")
def program_plan():
    year = request.args.get("year")
    if not year:
        abort(400, "year required")
    name = request.args.get("name", "Graphic Communications, BS")
    try:
        return jsonify(CatalogAccess(_db()).get_program_plan(year, name))
    except KeyError as exc:
        abort(404, str(exc))


@app.route("/course")
def course():
    code = request.args.get("code")
    if not code:
        abort(400, "code required")
    result = CatalogAccess(_db()).get_course(code)
    if result is None:
        abort(404, f"Course {code!r} not found")
    return jsonify(result)


if __name__ == "__main__":
    host = os.environ.get("GC_ADVISOR_HOST", "127.0.0.1")
    port = int(os.environ.get("GC_ADVISOR_PORT", "8768"))
    app.run(host=host, port=port)
```

- [ ] **Step 2: Smoke-test manually**

```bash
cd /Users/admin/projects/gc_advisor
PYTHONPATH=src .venv/bin/python scripts/serve.py &
sleep 1
curl -s http://127.0.0.1:8768/health
# Expected: {"ok":true}
curl -s "http://127.0.0.1:8768/years"
# Expected: ["2026-2027", ...]  (or empty if DB not populated yet)
kill %1
```

---

### Task 3: Test the Flask server

**Files:**
- Create: `/Users/admin/projects/gc_advisor/tests/test_serve.py`

- [ ] **Step 1: Write the tests**

Flask's test client doesn't bind a port, so these tests are fast and have no side effects. They require the real DB at the default path but can be skipped when it's absent.

```python
import json, os, pytest
from pathlib import Path

ROOT = Path(__file__).parent.parent
DB_PATH = ROOT / "db" / "gc_advisor.db"
skip_no_db = pytest.mark.skipif(not DB_PATH.exists(), reason="gc_advisor.db not present")


@pytest.fixture
def client():
    os.environ.setdefault("GC_ADVISOR_DB", str(DB_PATH))
    # Import after env is set so _db() picks it up
    from scripts.serve import app
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["ok"] is True


@skip_no_db
def test_years_returns_list(client):
    r = client.get("/years")
    assert r.status_code == 200
    data = r.get_json()
    assert isinstance(data, list)
    assert all(isinstance(y, str) for y in data)


@skip_no_db
def test_program_plan_missing_year(client):
    r = client.get("/program-plan")
    assert r.status_code == 400


@skip_no_db
def test_program_plan_unknown_year(client):
    r = client.get("/program-plan?year=1900-1901")
    assert r.status_code == 404


@skip_no_db
def test_program_plan_default_program(client):
    r = client.get("/years")
    years = r.get_json()
    if not years:
        pytest.skip("no catalog years in DB")
    year = years[0]
    r2 = client.get(f"/program-plan?year={year}")
    assert r2.status_code == 200
    data = r2.get_json()
    assert "total_credits" in data
    assert isinstance(data["groups"], list)


def test_course_missing_code(client):
    r = client.get("/course")
    assert r.status_code == 400


@skip_no_db
def test_course_unknown_code(client):
    r = client.get("/course?code=ZZZZ-9999")
    assert r.status_code == 404
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/admin/projects/gc_advisor
PYTHONPATH=src .venv/bin/pytest tests/test_serve.py -v
```

Expected: all non-skipped tests pass. `test_health` must pass always (it uses the test client only, no DB).

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/projects/gc_advisor
git add scripts/serve.py tests/test_serve.py
git commit -m "feat: add Flask HTTP API server (scripts/serve.py, port 8768)"
```

---

### Task 4: Create the launchd plist for gc-advisor API

**Files:**
- Create: `/Users/admin/projects/gc_advisor/launchd/com.gc-advisor.api.plist`

- [ ] **Step 1: Create the launchd directory and plist template**

```bash
mkdir -p /Users/admin/projects/gc_advisor/launchd
```

Write `/Users/admin/projects/gc_advisor/launchd/com.gc-advisor.api.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  gc-advisor HTTP API service for launchd.

  Runs the loopback Flask API server on 127.0.0.1:8768, exposing
  /years, /program-plan, /course, and /health for CUassistant's
  mcp-catalog server to consume.

  Setup (one time):
    1. Edit this file: replace VENV_PYTHON, SERVE_SCRIPT,
       PYTHONPATH_SRC, and HOME_PATH with absolute paths.
       - VENV_PYTHON  → /Users/admin/projects/gc_advisor/.venv/bin/python
       - SERVE_SCRIPT → /Users/admin/projects/gc_advisor/scripts/serve.py
       - PYTHONPATH_SRC → /Users/admin/projects/gc_advisor/src
       - HOME_PATH    → /Users/admin
    2. cp launchd/com.gc-advisor.api.plist ~/Library/LaunchAgents/
    3. launchctl load ~/Library/LaunchAgents/com.gc-advisor.api.plist
    4. launchctl start com.gc-advisor.api
    5. tail -f ~/Library/Logs/gc-advisor.api.out.log
-->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gc-advisor.api</string>

  <key>ProgramArguments</key>
  <array>
    <string>VENV_PYTHON</string>
    <string>SERVE_SCRIPT</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONPATH</key>
    <string>PYTHONPATH_SRC</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>HOME_PATH/Library/Logs/gc-advisor.api.out.log</string>
  <key>StandardErrorPath</key>
  <string>HOME_PATH/Library/Logs/gc-advisor.api.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Install to LaunchAgents**

Fill in the real paths, then install and start:

```bash
# Copy and edit
cp /Users/admin/projects/gc_advisor/launchd/com.gc-advisor.api.plist \
   ~/Library/LaunchAgents/

# Open in editor to fill VENV_PYTHON, SERVE_SCRIPT, PYTHONPATH_SRC, HOME_PATH:
#   VENV_PYTHON   → /Users/admin/projects/gc_advisor/.venv/bin/python
#   SERVE_SCRIPT  → /Users/admin/projects/gc_advisor/scripts/serve.py
#   PYTHONPATH_SRC→ /Users/admin/projects/gc_advisor/src
#   HOME_PATH     → /Users/admin

launchctl load ~/Library/LaunchAgents/com.gc-advisor.api.plist
launchctl start com.gc-advisor.api
sleep 1
curl -s http://127.0.0.1:8768/health
```

Expected: `{"ok":true}`

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/projects/gc_advisor
git add launchd/com.gc-advisor.api.plist
git commit -m "feat: add launchd plist for gc-advisor HTTP API (port 8768)"
```

---

### Task 5: Update CUassistant config.ts

**Files:**
- Modify: `/Users/admin/projects/CUassistant/src/config.ts`

- [ ] **Step 1: Add GC_ADVISOR_URL export**

Append after the existing `MCP_CATALOG_HTTP_PORT` line (at the bottom of the file):

```typescript
// HTTP endpoint for the gc_advisor API server (scripts/serve.py on 127.0.0.1:8768).
// When set, gc-curriculum.ts calls this URL instead of shelling out to query.py.
export const GC_ADVISOR_URL =
  process.env.GC_ADVISOR_URL || "http://127.0.0.1:8768";
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /Users/admin/projects/CUassistant
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/projects/CUassistant
git add src/config.ts
git commit -m "feat: add GC_ADVISOR_URL config (HTTP endpoint for gc_advisor API)"
```

---

### Task 6: Swap defaultRunner in gc-curriculum.ts

**Files:**
- Modify: `/Users/admin/projects/CUassistant/src/gc-curriculum.ts`

The injectable `QueryRunner = (args: string[]) => Promise<string>` type and the public function signatures are unchanged — tests inject mocks directly and never touch `defaultRunner`. Only the `defaultRunner` implementation changes.

- [ ] **Step 1: Write the updated file**

Replace the entire contents of `src/gc-curriculum.ts`:

```typescript
// GC curriculum data layer — bridges to the gc_advisor HTTP API server
// (scripts/serve.py, default 127.0.0.1:8768). The shell-out to query.py is
// replaced by fetch; the injectable QueryRunner seam is preserved so tests
// that mock it still work unchanged.
import { GC_ADVISOR_URL } from "./config.js";

/** Injectable seam: maps CLI-style args to a JSON string response. */
export type QueryRunner = (args: string[]) => Promise<string>;

/** Translate CLI-style args to an API path+query, e.g. ["years"] → "/years" */
function argsToPath(args: string[]): string {
  const cmd = args[0];
  if (cmd === "years") return "/years";
  if (cmd === "program-plan") {
    const yearIdx = args.indexOf("--year");
    const nameIdx = args.indexOf("--name");
    const year = yearIdx >= 0 ? args[yearIdx + 1] : "";
    const name =
      nameIdx >= 0 ? args[nameIdx + 1] : "Graphic Communications, BS";
    return `/program-plan?year=${encodeURIComponent(year)}&name=${encodeURIComponent(name)}`;
  }
  if (cmd === "course") {
    const codeIdx = args.indexOf("--code");
    const code = codeIdx >= 0 ? args[codeIdx + 1] : "";
    return `/course?code=${encodeURIComponent(code)}`;
  }
  throw new Error(`Unknown gc_advisor command: ${cmd}`);
}

const defaultRunner: QueryRunner = async (args) => {
  const path = argsToPath(args);
  const res = await fetch(`${GC_ADVISOR_URL}${path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gc_advisor API ${res.status}: ${body}`);
  }
  return res.text();
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

- [ ] **Step 2: Typecheck**

```bash
cd /Users/admin/projects/CUassistant
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run the existing curriculum tests**

```bash
cd /Users/admin/projects/CUassistant
node --import tsx --test test/curriculum-tools.test.ts
```

Expected: all 5 tests pass (the live integration test is skipped when gc_advisor API isn't running, as before).

- [ ] **Step 4: Run an integration smoke test against the live server**

With gc-advisor API running (from Task 4):

```bash
cd /Users/admin/projects/CUassistant
GC_ADVISOR_URL=http://127.0.0.1:8768 node --import tsx --test test/curriculum-tools.test.ts
```

The live `listGcCatalogYears against the real gc_advisor DB` test should now pass (it calls the live API rather than shelling out).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/projects/CUassistant
git add src/gc-curriculum.ts
git commit -m "feat: gc-curriculum.ts uses HTTP fetch instead of query.py shell-out"
```

---

### Task 7: Update dev-ports.yaml

**Files:**
- Modify: `/Users/admin/.dev-ports.yaml`

- [ ] **Step 1: Add gc_advisor_api port**

In the `gc_advisor` project section (or add a new `gc_advisor` section if one doesn't exist), add:

```yaml
  gc_advisor:
    path: ~/projects/gc_advisor
    launchd: com.gc-advisor.api
    notes: "Curriculum catalog DB + HTML scraper. Flask API on 8768 (loopback) for CUassistant mcp-catalog consumption."
    services:
      api:  8768   # 127.0.0.1, Flask HTTP API: /years /program-plan /course /health
```

- [ ] **Step 2: Verify no port conflict**

```bash
grep "8768" ~/.dev-ports.yaml
```

Expected: only the new line.

- [ ] **Step 3: Commit dev-ports.yaml is not in a git repo — no commit needed.**

---

### Task 8: Update .env.example

**Files:**
- Modify: `/Users/admin/projects/CUassistant/.env.example` (if it exists)

- [ ] **Step 1: Add the new variable**

```bash
grep -n "GC_ADVISOR" /Users/admin/projects/CUassistant/.env.example
```

If `GC_ADVISOR_PYTHON` / `GC_ADVISOR_QUERY` / `GC_ADVISOR_DB` lines exist, add GC_ADVISOR_URL nearby:

```
GC_ADVISOR_URL=http://127.0.0.1:8768   # gc_advisor HTTP API (scripts/serve.py)
```

- [ ] **Step 2: Commit**

```bash
cd /Users/admin/projects/CUassistant
git add .env.example
git commit -m "docs: add GC_ADVISOR_URL to .env.example"
```

---

## End-to-End Verification

After all tasks:

```bash
# 1. gc_advisor API running
curl -s http://127.0.0.1:8768/health          # {"ok":true}
curl -s http://127.0.0.1:8768/years           # ["2026-2027",...]

# 2. CUassistant tests
cd /Users/admin/projects/CUassistant
npm run typecheck
npm test

# 3. MCP catalog server responds via the API (not shell-out)
MCP_TRANSPORT=http npm run mcp:catalog:http &
sleep 1
# In another shell or MCP client: call list-gc-catalog-years
# Should return years from the live API
kill %1
```
