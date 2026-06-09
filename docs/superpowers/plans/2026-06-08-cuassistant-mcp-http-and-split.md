# CUassistant MCP: Security-Class Split + Host HTTP Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CUassistant mountable by a containerized NanoClaw agent without the MS365 token entering the container — by splitting the MCP surface into a credentialed `cuassistant-credentialed` server and a public `cuassistant-public` server, and giving the credentialed one a Streamable HTTP transport with bearer auth (kept dual with stdio).

**Architecture:** Two MCP entry points in one repo, each a separate host process with its own tool registry (the registry is module-global, which is safe per-process). The credentialed entry selects transport by env (`stdio` default, `http` when `MCP_TRANSPORT=http`), binds `127.0.0.1`, and enforces `Authorization: Bearer ${MCP_AUTH_TOKEN}` only when that env var is set (loopback-open otherwise — the interim auth mode). The public entry stays stdio-only, no creds.

**Tech Stack:** TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk` (StdioServerTransport + StreamableHTTPServerTransport, both already installed), `tsx`, node `--test`, prettier.

**Spec:** `docs/superpowers/specs/2026-06-08-cuassistant-nanoclaw-mcp-integration-design.md`

**Scope note:** This plan covers Phases 1–3 below. The NanoClaw-side changes (5-file config-type sweep, bridge HTTP branch, `resolveHeaders`, vault stub) are out of scope — they live in `nanoclaw-personal` and implement against the spec's "nanoclaw-personal repo changes" + "Auth model" sections.

---

## File structure

- `src/mcp-tools/server.ts` — MODIFY: `startMcpServer(opts)` takes a server name + transport; add the HTTP transport + bearer-auth path. Registry stays module-global.
- `src/mcp-tools/index.ts` — MODIFY: drop the `clemson-classes` import (this becomes the **credentialed** barrel).
- `src/mcp-tools/index-public.ts` — CREATE: imports only `clemson-classes`.
- `src/mcp-server.ts` — MODIFY: the **credentialed** entry — use the credentialed barrel, transport-by-env, name `cuassistant-credentialed`.
- `src/mcp-public.ts` — CREATE: the **public** entry — stdio, name `cuassistant-public`, no approval gate.
- `src/config.ts` — MODIFY: add `MCP_TRANSPORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_AUTH_TOKEN`.
- `src/approval/ms365-sender.ts` — CREATE: MS365 Graph `sendMail` backend.
- `src/approval/sender.ts` — MODIFY: pass the ms365 backend into `makeSender`.
- `src/mcp-server.ts` — MODIFY: wire the ms365 sender into the gate.
- `src/mcp-tools/mail-send.ts` — MODIFY: split `request_send_mail` → `send-outlook-mail` + `send-gmail`.
- `launchd/com.cuassistant.mcp-http.plist` — CREATE: run the host HTTP credentialed server.
- `package.json` — MODIFY: scripts `mcp` (credentialed stdio), `mcp:http` (credentialed http), `mcp:public`.
- `src/mcp-server.md`, `skills/add-cuassistant/SKILL.md` — MODIFY: docs/skill refresh.
- `test/mcp-http-auth.test.ts`, `test/ms365-sender.test.ts` — CREATE.

---

## Phase 1 — Security-class server split + HTTP transport

### Task 1: Split the tool barrels

**Files:**
- Modify: `src/mcp-tools/index.ts`
- Create: `src/mcp-tools/index-public.ts`

- [ ] **Step 1: Remove the Clemson import from the credentialed barrel**

In `src/mcp-tools/index.ts`, delete the line `import "./clemson-classes.js";` (leave the MS365 + orchestration imports). Add a comment at top: `// credentialed barrel — Clemson tools live in index-public.ts`.

- [ ] **Step 2: Create the public barrel**

```ts
// src/mcp-tools/index-public.ts
// Public Clemson class-schedule barrel — no credentials. Imported by the
// cuassistant-public entry point (src/mcp-public.ts).
import "./clemson-classes.js";
```

- [ ] **Step 3: Verify it still typechecks**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-tools/index.ts src/mcp-tools/index-public.ts
git commit -m "refactor(mcp): split tool barrels into credentialed + public"
```

---

### Task 2: Add config for transport + auth

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Append the MCP transport/auth config**

Add near the other exports in `src/config.ts`:

```ts
// --- MCP server transport (credentialed server) ---
// MCP_TRANSPORT: "stdio" (default, local/dev) or "http" (containerized agent).
export const MCP_TRANSPORT = (
  process.env.MCP_TRANSPORT === "http" ? "http" : "stdio"
) as "stdio" | "http";
export const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";
export const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 8765);
// When set, the HTTP transport requires `Authorization: Bearer <token>`.
// When unset, the server is loopback-open (interim mode). The value is read
// from the environment, which OneCLI can populate from its vault at spawn.
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(mcp): config for http transport + bearer auth"
```

---

### Task 3: Parameterize `startMcpServer` and add the HTTP transport

**Files:**
- Modify: `src/mcp-tools/server.ts`
- Test: `test/mcp-http-auth.test.ts`

- [ ] **Step 1: Write the failing test (bearer auth gate)**

```ts
// test/mcp-http-auth.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { checkBearer } from "../src/mcp-tools/server.ts";

test("checkBearer: open when no token configured", () => {
  assert.equal(checkBearer(undefined, ""), true);
  assert.equal(checkBearer("Bearer anything", ""), true);
});

test("checkBearer: enforced when token configured", () => {
  assert.equal(checkBearer("Bearer s3cret", "s3cret"), true);
  assert.equal(checkBearer("Bearer wrong", "s3cret"), false);
  assert.equal(checkBearer(undefined, "s3cret"), false);
  assert.equal(checkBearer("s3cret", "s3cret"), false); // missing "Bearer "
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test test/mcp-http-auth.test.ts`
Expected: FAIL — `checkBearer` is not exported.

- [ ] **Step 3: Refactor `server.ts` — exported `checkBearer` + options-based `startMcpServer`**

Replace the imports and `startMcpServer` in `src/mcp-tools/server.ts` with:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";

import type { McpToolDefinition } from "./types.js";
import { isMcpOperationExposed } from "./permissions.js";

// (keep the existing log(), allTools, toolMap, shouldRegisterMcpTool,
//  registerTools unchanged)

/** Constant-time-ish bearer check. Open when expected is empty. */
export function checkBearer(authHeader: string | undefined, expected: string): boolean {
  if (!expected) return true;
  return authHeader === `Bearer ${expected}`;
}

export interface StartOptions {
  name: string;
  transport?: "stdio" | "http";
  httpHost?: string;
  httpPort?: number;
  authToken?: string;
}

function buildServer(name: string): Server {
  const server = new Server(
    { name, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    return tool.handler(args ?? {});
  });
  return server;
}

export async function startMcpServer(opts: StartOptions): Promise<void> {
  if ((opts.transport ?? "stdio") === "http") {
    const host = opts.httpHost ?? "127.0.0.1";
    const port = opts.httpPort ?? 8765;
    const expected = opts.authToken ?? "";
    const server = buildServer(opts.name);
    // Stateless streamable HTTP: one transport handles every request.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const httpServer = http.createServer((req, res) => {
      if (!checkBearer(req.headers.authorization, expected)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // Buffer the body and hand the request to the SDK transport.
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: unknown = undefined;
        if (chunks.length) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            /* GET / no-body requests: leave undefined */
          }
        }
        void transport.handleRequest(req, res, body);
      });
    });
    httpServer.listen(port, host, () => {
      log(
        `${opts.name} http on ${host}:${port} ` +
          `(auth ${expected ? "required" : "OPEN-loopback"}) ` +
          `tools: ${allTools.map((t) => t.tool.name).join(", ")}`,
      );
    });
    return;
  }

  const server = buildServer(opts.name);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    `${opts.name} stdio started with ${allTools.length} tools: ` +
      allTools.map((t) => t.tool.name).join(", "),
  );
}
```

> Note: confirm the installed SDK's `handleRequest(req, res, parsedBody?)` signature in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts`. If it differs, adjust the body-passing line; the auth gate and `buildServer` are independent of it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/mcp-http-auth.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. (Callers of `startMcpServer()` will now error — fixed in Tasks 4–5.)

If the two entry points haven't been updated yet, this is expected; proceed to Task 4 before committing.

- [ ] **Step 6: (deferred commit — commit after Task 5 so the tree compiles)**

---

### Task 4: Create the public entry point

**Files:**
- Create: `src/mcp-public.ts`

- [ ] **Step 1: Write the entry**

```ts
// src/mcp-public.ts
// Public Clemson class-schedule MCP server (no credentials). stdio only — it
// can run as a subprocess inside a NanoClaw container since it holds no secrets
// and only reaches Clemson's public Banner API.
import "./mcp-tools/index-public.js";
import { startMcpServer } from "./mcp-tools/server.js";

startMcpServer({ name: "cuassistant-public", transport: "stdio" }).catch(
  (err) => {
    process.stderr.write(
      `[cuassistant-public] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
```

- [ ] **Step 2: (verified together with Task 5 typecheck)**

---

### Task 5: Update the credentialed entry to select transport by env

**Files:**
- Modify: `src/mcp-server.ts`

- [ ] **Step 1: Update imports + the `startMcpServer()` call**

In `src/mcp-server.ts`:
- Change the barrel import to the credentialed barrel: it currently is `import "./mcp-tools/index.js";` — keep it (index.ts is now the credentialed barrel).
- Add config imports: `import { MCP_TRANSPORT, MCP_HTTP_HOST, MCP_HTTP_PORT, MCP_AUTH_TOKEN } from "./config.js";`
- Replace the final `startMcpServer().catch(...)` with:

```ts
initApprovalGate();
startMcpServer({
  name: "cuassistant-credentialed",
  transport: MCP_TRANSPORT,
  httpHost: MCP_HTTP_HOST,
  httpPort: MCP_HTTP_PORT,
  authToken: MCP_AUTH_TOKEN,
}).catch((err) => {
  log(`server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck the whole tree**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Full test + format**

Run: `npm test` (expect all pass) and `npx prettier --write "src/**/*.ts" "test/*.ts"` then `npm run format:check`.

- [ ] **Step 4: Commit Phase-1 server code**

```bash
git add src/mcp-tools/server.ts src/mcp-server.ts src/mcp-public.ts test/mcp-http-auth.test.ts
git commit -m "feat(mcp): dual stdio/http transport + bearer auth; split m365/clemson entries"
```

---

### Task 6: package.json scripts + live smoke

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update scripts**

In `package.json` `scripts`, set:

```json
"mcp": "tsx src/mcp-server.ts",
"mcp:http": "MCP_TRANSPORT=http tsx src/mcp-server.ts",
"mcp:public": "tsx src/mcp-public.ts",
```

- [ ] **Step 2: Live smoke — HTTP transport answers and enforces auth**

Run (no auth token → loopback-open):
```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=8765 npm run --silent mcp:http &
sleep 2
curl -s -X POST http://127.0.0.1:8765/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
kill %1
```
Expected: HTTP 200 and a JSON-RPC body — either a tools list, or an
`initialize`-required error (the stateless transport may require the MCP
handshake first). Either confirms the HTTP transport is live; the real client
(NanoClaw's bridge) performs the handshake. Auth is verified separately in
Step 3.

- [ ] **Step 3: Live smoke — auth enforced when token set**

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=8766 MCP_AUTH_TOKEN=t0p npm run --silent mcp:http &
sleep 2
echo "no-auth:";  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8766/ -d '{}'
echo "good-auth:"; curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8766/ -H 'authorization: Bearer t0p' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
kill %1
```
Expected: `no-auth: 401`, `good-auth: 200`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(mcp): npm scripts: credentialed stdio/http + public"
```

---

## Phase 2 — Send-tool disambiguation + MS365 sender

### Task 7: MS365 Graph `sendMail` backend

**Files:**
- Create: `src/approval/ms365-sender.ts`
- Test: `test/ms365-sender.test.ts`

- [ ] **Step 1: Write the failing test (payload shape; inject fetch)**

```ts
// test/ms365-sender.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildSendMailPayload } from "../src/approval/ms365-sender.ts";

test("buildSendMailPayload maps recipients + body", () => {
  const p = buildSendMailPayload({
    account: "ms365",
    to: ["a@x.edu", "b@x.edu"],
    cc: ["c@x.edu"],
    subject: "Hi",
    body: "Body text",
  });
  assert.equal(p.message.subject, "Hi");
  assert.equal(p.message.body.contentType, "Text");
  assert.equal(p.message.body.content, "Body text");
  assert.deepEqual(
    p.message.toRecipients.map((r) => r.emailAddress.address),
    ["a@x.edu", "b@x.edu"],
  );
  assert.equal(p.message.ccRecipients[0].emailAddress.address, "c@x.edu");
  assert.equal(p.saveToSentItems, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test test/ms365-sender.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sender**

```ts
// src/approval/ms365-sender.ts
// MS365 Graph sendMail backend for the approval gate. Host-side; uses the
// GCassistant token (Mail.Send consented). Only invoked by the gate after
// human approval — never reachable directly by the agent.
import { getMs365AccessToken } from "../ms365.js";
import type { SendArtifact, SentResult } from "./types.js";

export function buildSendMailPayload(a: SendArtifact) {
  const rcpt = (addr: string) => ({ emailAddress: { address: addr } });
  return {
    message: {
      subject: a.subject,
      body: { contentType: "Text", content: a.body },
      toRecipients: a.to.map(rcpt),
      ccRecipients: (a.cc ?? []).map(rcpt),
    },
    saveToSentItems: true,
  };
}

export async function ms365Send(a: SendArtifact): Promise<SentResult> {
  const token = await getMs365AccessToken();
  if (!token) throw new Error("ms365 send: no access token");
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSendMailPayload(a)),
  });
  if (!r.ok) {
    throw new Error(
      `ms365 sendMail failed: ${r.status} ${(await r.text()).slice(0, 200)}`,
    );
  }
  // Graph sendMail returns 202 Accepted with no id.
  return { id: "sent" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/ms365-sender.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/approval/ms365-sender.ts test/ms365-sender.test.ts
git commit -m "feat(approval): MS365 Graph sendMail backend"
```

---

### Task 8: Wire the ms365 backend into the gate

**Files:**
- Modify: `src/mcp-server.ts` (the `makeSender` call inside `initApprovalGate`)

- [ ] **Step 1: Import and pass the backend**

In `src/mcp-server.ts`, add `import { ms365Send } from "./approval/ms365-sender.js";` and change:

```ts
const sender = makeSender({ gmail: gwsSend });
```
to:
```ts
const sender = makeSender({ gmail: gwsSend, ms365: ms365Send });
```

(`makeSender` in `src/approval/sender.ts` already supports an optional `ms365` backend — no change needed there.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat(approval): enable ms365 sender in the gate"
```

---

### Task 9: Split send tool into per-vendor tools

**Files:**
- Modify: `src/mcp-tools/mail-send.ts`

- [ ] **Step 1: Replace the single tool with two vendor-explicit tools**

In `src/mcp-tools/mail-send.ts`, replace the `requestSendMail` definition with two definitions that hardcode the account (both still go through `gate.submit`), keeping `getSendStatus` and the `__setGate` export unchanged:

```ts
function sendTool(
  name: string,
  account: SendAccount,
  vendor: string,
): McpToolDefinition {
  return {
    operation: "mail.send_with_approval",
    tool: {
      name, // "send-outlook-mail" | "send-gmail"
      description:
        `Request that a ${vendor} email be sent. Returns a request_id ` +
        "immediately; the email is NOT sent until the user approves it " +
        "out-of-band. Poll get-send-status for the outcome.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
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
      const artifact: SendArtifact = {
        account,
        to,
        cc: asStringArray(args.cc),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
      };
      try {
        return okJson(await gate.submit(artifact, "agent"));
      } catch (e) {
        return err(String(e));
      }
    },
  };
}

export const sendOutlookMail = sendTool("send-outlook-mail", "ms365", "Outlook");
export const sendGmail = sendTool("send-gmail", "gmail", "Gmail");
```

Update the `getSendStatus` tool's name to `get-send-status` (hyphenated, consistent), and change the final `registerTools([...])` to:

```ts
registerTools([sendOutlookMail, sendGmail, getSendStatus]);
```

- [ ] **Step 2: Update the gate-wiring import in `src/mcp-server.ts`**

`src/mcp-server.ts` imports `__setGate` from `./mcp-tools/mail-send.js` — unchanged. Confirm it still resolves.

- [ ] **Step 3: Typecheck + test + format**

Run: `npm run typecheck` (exit 0), `npm test` (all pass), `npx prettier --write src/mcp-tools/mail-send.ts` then `npm run format:check`.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-tools/mail-send.ts
git commit -m "feat(mcp): split send into send-outlook-mail + send-gmail"
```

---

## Phase 3 — Ops + docs

### Task 10: launchd plist for the host HTTP server

**Files:**
- Create: `launchd/com.cuassistant.mcp-http.plist`

- [ ] **Step 1: Create the plist** (mirror `launchd/com.cuassistant.clemson-refresh.plist`; placeholders `REPO_PATH`/`NPM_PATH`/`HOME_PATH`, `RunAtLoad` true, `KeepAlive` true, runs `npm run mcp:http`, logs to `HOME_PATH/Library/Logs/cuassistant.mcp.{out,err}.log`). Header comment documents that `MCP_AUTH_TOKEN` should be provided by OneCLI vault injection, not written into the plist.

- [ ] **Step 2: Commit**

```bash
git add launchd/com.cuassistant.mcp-http.plist
git commit -m "chore(mcp): launchd plist for host http server"
```

---

### Task 11: Refresh `mcp-server.md` and the `add-cuassistant` skill

**Files:**
- Modify: `src/mcp-server.md`
- Modify: `skills/add-cuassistant/SKILL.md`

- [ ] **Step 1: Update `src/mcp-server.md`** — document the two servers (`cuassistant-credentialed` credentialed HTTP/stdio; `cuassistant-public` public stdio), the bearer-auth model (env/vault, loopback-open interim), and the current tool inventory (GCassistant Graph backend, active mail/calendar writes, the 5 Clemson tools, `send-outlook-mail`/`send-gmail`, snapshots). Remove all Codex/graph-cli references.

- [ ] **Step 2: Rewrite `skills/add-cuassistant/SKILL.md`** to register, in NanoClaw **user/local** config (never `.mcp.json`):
  - `cuassistant-credentialed` as a `{ url: "http://host.docker.internal:8765", headers: { Authorization: "Bearer ${CUASSISTANT_MCP_TOKEN}" } }` server (vault-referenced; see spec Auth model).
  - `cuassistant-public` as a stdio server (`tsx src/mcp-public.ts`).
  - Keep all write/send tools off the NanoClaw allowlist (always prompt).
  - Drop the stale prerequisites (Codex Outlook, graph-cli login); add: host MCP server running (`npm run mcp:http` or the launchd job), `MS365_REFRESH_TOKEN` present, optional `MCP_AUTH_TOKEN`.

- [ ] **Step 3: Prettier + commit**

```bash
npx prettier --write "*.md" "src/mcp-server.md" "skills/add-cuassistant/SKILL.md" 2>/dev/null || true
git add src/mcp-server.md skills/add-cuassistant/SKILL.md
git commit -m "docs(mcp): refresh manifest + add-cuassistant skill for split/http"
```

---

## Final verification

- [ ] `npm run typecheck` → exit 0
- [ ] `npm test` → all pass (existing 40 + `mcp-http-auth` + `ms365-sender`)
- [ ] `npm run format:check` → clean
- [ ] HTTP smoke (Task 6) → 401 without bearer, 200 with; credentialed tools only
- [ ] stdio still works: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npm run --silent mcp` lists credentialed tools
- [ ] `npm run mcp:public` lists only the 5 Clemson tools
