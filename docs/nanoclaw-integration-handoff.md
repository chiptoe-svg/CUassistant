# NanoClaw ↔ CUassistant — Integration Handoff (VERIFIED)

**Date:** 2026-06-09
**From:** nanoclaw-personal side (consumer)

## Status

- **NanoClaw consumer side: DONE & merged** to `main` (`chiptoe-svg/nanoclaw-personal`, branch `feat/third-party-mcp-bridge`). Your hand-off items 1–5 (config-type sweep, entry points, HTTP bridge branch, `resolveHeaders`, networking no-op) are all implemented and tested.
- **Integration test: RUN and PASSING** (2026-06-09). I started `MCP_TRANSPORT=http npm run mcp:http` (interim no-bearer) and pointed the _real merged bridge_ at `http://127.0.0.1:8765`. After the one provider fix below, the bridge connects and lists **all 20** `cuassistant-credentialed__*` tools.

Naming reconciliation applied throughout: `cuassistant-credentialed` (was cuassistant-m365), `cuassistant-public` (was cuassistant-clemson). The bridge is name-agnostic; this is cosmetic.

---

## 🔴 CRITICAL — provider bug found, fix verified

Your HTTP server (`src/mcp-tools/server.ts:115-138`) builds **one shared `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` and reuses it for every request**. In stateless mode the MCP SDK requires a **fresh transport + server per request**.

**Symptom:** `initialize` (POST #1) succeeds, then the client's `notifications/initialized` (POST #2) returns **HTTP 500** (`Error POSTing to endpoint`), the handshake never completes, and **zero tools list**. The server logs nothing. This blocks _any_ MCP client, not just nanoclaw.

**Fix (verified — with it applied my bridge listed all 20 tools):** move `buildServer` + transport construction _inside_ the request handler, per request, and close on `res` `'close'`:

```diff
@@ export async function startMcpServer(opts: StartOptions): Promise<void> {
     const expected = opts.authToken ?? "";
     assertHttpAuthConfig(expected, host);
-    const server = buildServer(opts.name);
-    const transport = new StreamableHTTPServerTransport({
-      sessionIdGenerator: undefined,
-    });
-    await server.connect(transport);
     const httpServer = http.createServer((req, res) => {
       ...
-        void transport.handleRequest(req, res, body);
+        // Stateless: a fresh server+transport per request. Sharing one
+        // stateless transport across requests 500s on the post-initialize
+        // `notifications/initialized` POST. (MCP SDK stateless pattern.)
+        void (async () => {
+          const reqServer = buildServer(opts.name);
+          const reqTransport = new StreamableHTTPServerTransport({
+            sessionIdGenerator: undefined,
+          });
+          res.on("close", () => {
+            void reqTransport.close();
+            void reqServer.close();
+          });
+          await reqServer.connect(reqTransport);
+          await reqTransport.handleRequest(req, res, body);
+        })();
       });
     });
```

I applied this locally, verified, then **reverted your repo to pristine** (it's a reviewed codebase — land it through your own process). Full patch: `/tmp/cuassistant-server-fix.patch`. Same fix is needed on the `cuassistant-public` HTTP server if you take Option (a) below. Add a test: a real client `initialize` + `listTools` round-trip over HTTP (the existing tests don't exercise the live handshake — that's why this slipped through).

---

## 🟠 BLOCKER — `cuassistant-public` stdio registration won't run in the container

Your suggested registration:

```
{ name: "cuassistant-public",
  command: "npm",
  args: ["--prefix", "/Users/admin/projects/CUassistant", "run", "mcp:public"] }
```

A nanoclaw stdio MCP server is spawned **as a subprocess inside the agent container** (the Bun image). That container does **not** have: the host path `/Users/admin/projects/CUassistant`, the CUassistant repo, `npm`/`node`/`tsx`, or `node_modules`. So this command fails at spawn in production. (It only "works" if the agent runs uncontainerized — nanoclaw never does.)

**Options:**

- **(a) RECOMMENDED — serve `cuassistant-public` over HTTP too** (loopback, no bearer; public data): a second `startMcpServer({ name: "cuassistant-public", transport: "http", httpPort: 8766 })`. Register in nanoclaw with `url: http://host.docker.internal:8766/`. Zero in-container install; symmetric with credentialed. (Apply the same per-request fix.)
- **(b)** Publish the public server as an npm package, add it to the agent group's container config `packages_npm` (pinned), register `command: "npx", args: ["-y", "<pkg>"]`.
- **(c)** Mount the built dir + provide a Node runtime in the container (heaviest).

Until this is resolved, only `cuassistant-credentialed` (HTTP) is registrable.

---

## Registration (after the fix)

**`cuassistant-credentialed` (HTTP):**

```
ncl groups config add-mcp-server --id <agent-group> \
  --name cuassistant-credentialed \
  --url http://host.docker.internal:8765/ \
  --headers '{"Authorization":"Bearer ${CUASSISTANT_MCP_TOKEN}"}'
ncl groups restart --id <agent-group>
```

Register the `Bearer ${CUASSISTANT_MCP_TOKEN}` reference from day one (see Auth). **`cuassistant-public`:** pending the blocker above.

---

## Auth (interim → target) — confirmed compatible

- **Interim:** server with `MCP_AUTH_TOKEN` unset → loopback-open (your `checkBearer` returns open when expected is empty). nanoclaw sends no `Authorization` header (it drops a header whose `${VAR}` is unset). Verified working in this exact mode.
- **Target:** set `MCP_AUTH_TOKEN` on the server **and** OneCLI-inject `CUASSISTANT_MCP_TOKEN` into the container env **at the same time**. Half-flipping (server requires token, env var not injected) → nanoclaw drops the header → every call 401s.

## Gotchas (still apply)

1. **Headers fail closed** — drop-on-missing-ref, so interim→target must flip both sides together (above).
2. **`${VAR}` brace syntax only** — register exactly `Bearer ${CUASSISTANT_MCP_TOKEN}`; no bare `$VAR`, no escape for a literal `${...}`.
3. **Tool names are namespaced** (`cuassistant-credentialed__send-outlook-mail`) and double as nanoclaw's permission-allowlist keys → treat tool names as a **stable API**; keep all write/send tools **off** the allowlist (always prompt), in addition to your own approval/sender gate.
4. **Only `text` and `image` result content survives the bridge** — other content types (resource links, embedded resources) are silently dropped. Return text (JSON-as-text is fine) and optionally image.
5. **MCP SDK versions match (1.29.0 both sides)** — keep them aligned on any bump.

## 20 credentialed tools verified through the bridge

`create-calendar-event`, `create-draft-email`, `create-todo-task`, `get-calendar-event`, `get-calendar-view`, `get-mail-message`, `get-send-status`, `get-todo-task`, `get_pending_actions`, `get_scan_status`, `list-calendar-events`, `list-mail-messages`, `list-todo-task-lists`, `list-todo-tasks`, `move-mail-message`, `send-gmail`, `send-outlook-mail`, `update-calendar-event`, `update-mail-message`, `update-todo-task`.

(Policy-gated/destructive tools — delete/accept/decline/trigger_scan — were correctly _not_ registered. Send tools registered but `send-approval disabled` in this test env since `TELEGRAM_BOT_TOKEN`/`TELEGRAM_APPROVER_USER_ID` were unset — wire those before relying on the Telegram gate.)

## Quick reference

| Thing               | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Credentialed server | `127.0.0.1:8765`, root path, Streamable HTTP                                         |
| nanoclaw `url`      | `http://host.docker.internal:8765/`                                                  |
| nanoclaw header     | `Authorization: Bearer ${CUASSISTANT_MCP_TOKEN}` (reference)                         |
| Server names        | `cuassistant-credentialed` (HTTP), `cuassistant-public` (pending transport decision) |
| Agent-visible tools | `cuassistant-credentialed__<tool>`                                                   |
| Interim auth        | `MCP_AUTH_TOKEN` unset → loopback-open, no header sent                               |
| Target auth         | set `MCP_AUTH_TOKEN` **and** inject `CUASSISTANT_MCP_TOKEN` together                 |
