# CUassistant ↔ NanoClaw MCP Integration — Design

**Date:** 2026-06-08
**Status:** Proposed (brainstorm complete, pending review)

## Summary

Give a NanoClaw v2 containerized agent access to CUassistant's capabilities
**without merging the two repos** and **without the MS365 credential ever
entering the container**. CUassistant stays an independent, IT-reviewable MCP
capability provider; NanoClaw stays the agent runtime. They connect over MCP.

The credential boundary forces the transport choice: a third-party MCP server
registered with NanoClaw runs as a **stdio subprocess inside the container**, so
a stdio CUassistant server would put the token in the container. To keep the
token host-side, the credentialed server must speak **Streamable HTTP** on the
host and the agent must reach it over the network. NanoClaw's bridge already
imports an HTTP client but only uses it for its own host server; we extend it to
reach a third-party server by URL.

## Decisions (resolved during brainstorm)

1. **Keep both repos** — do not fold either into the other (CUassistant must
   stay independently reviewable/shareable).
2. **Transport:** dual. **stdio** for local/dev/tests; **Streamable HTTP** for
   the containerized agent.
3. **Split by security class, not vendor-domain:**
   - **Credentialed server** (`cuassistant-credentialed`): **all** credentialed
     accounts — MS365 mail/calendar/tasks today, Clemson Gmail (`gws`) and future
     credentialed services next — plus host orchestration + the send-gate, with
     **vendor-namespaced** tools (`outlook-*` / `gmail-*`). One
     `action-policy.yaml`, one audit log, one host-HTTP + bearer boundary.
   - **Public server** (`cuassistant-public`): the Clemson class-schedule
     tools. No credentials, public data → served over **loopback HTTP on :8766**
     (no bearer); reached from the container via `host.docker.internal:8766`.
     Stdio-in-container was found not to work during the NanoClaw integration
     test: the container lacks the host path, CUassistant repo, and node/tsx.
4. **Writes/sends always prompt** and stay off NanoClaw's allowlist; reads may
   be allowlisted later.
5. **No plaintext credentials:** pluggable secret source — `.env` for standalone
   use, OneCLI vault injection under NanoClaw. The HTTP bearer secret is
   vault-injected, never a literal in config.
6. **Config placement:** the credentialed server entry lives in NanoClaw's
   user/local (gitignored) config, never the committed `.mcp.json`.

## Architecture

```
┌─ NanoClaw container ───────────────┐        ┌─ Host (macOS / Docker Desktop) ──────────┐
│ Claude agent + chat channels       │        │                                          │
│ pi-mcp-bridge                       │        │ cuassistant-credentialed                 │
│   • cuassistant-credentialed (url, bearer) ─┼─HTTP──▶│   Streamable HTTP @ 127.0.0.1:8765       │
│       host.docker.internal:8765     │+secret │   bearer auth · policy · audit · gate    │
│   • cuassistant-public (url)        │        │   MS365 token (vault/.env, host only) ───┼─▶ Graph
│       host.docker.internal:8766    ─┼─HTTP──▶│                                          │
│       (no bearer, public data)      │        │ cuassistant-public (public)              │
│                                     │        │   Streamable HTTP @ 127.0.0.1:8766       │
│                                     │        │   no bearer · loopback-only ─────────────┼─▶ Clemson Banner
└─────────────────────────────────────┘        └────────────────────────────────────────┘
```

- **Loopback + `host.docker.internal`:** both servers bind `127.0.0.1` (not
  network-exposed). The container reaches each via Docker Desktop's
  `host.docker.internal` hostname. The credentialed server's bearer guards
  against other host-local processes; the public server is loopback-open
  (public data, no secret).
- **Public Clemson server:** served over loopback HTTP on `:8766` — no bearer.
  Stdio-in-container was the original plan but was ruled out during the NanoClaw
  integration test: the Bun container image has no host path, no CUassistant
  repo, and no node/tsx to spawn.

## CUassistant repo changes

1. **Split the MCP registration into two servers.** Today `src/mcp-tools/` is
   one server. Refactor into two entry points sharing the tool modules:
   - `cuassistant-credentialed`: MS365 mail-read/write, calendar-read/write,
     todo-tasks, host-orchestration, send-gate — and Clemson Gmail (`gws`) plus
     future credentialed vendors as they're added, all vendor-namespaced. The
     server is a vendor-neutral tool registry; new vendors register here, they
     don't get their own server.
   - `cuassistant-public`: clemson-classes (already a distinct
     `external-http` / `public_data_only` backend, so the seam is natural).
2. **Add a Streamable HTTP transport** (`StreamableHTTPServerTransport`) to the
   credentialed server, alongside stdio. New script `mcp:http`; bind
   `127.0.0.1:${MCP_HTTP_PORT||8765}`. stdio entry (`mcp`) retained for
   local/dev/tests.
3. **Inbound auth:** require `Authorization: Bearer ${MCP_AUTH_TOKEN}` on the
   HTTP transport; reject missing/wrong. stdio path needs no token (no port).
4. **Pluggable secret source:** read `MS365_REFRESH_TOKEN` and `MCP_AUTH_TOKEN`
   from a resolver that prefers a OneCLI-vault command when configured, falling
   back to `.env` for standalone use. Keeps the IT-reviewable standalone path
   while satisfying NanoClaw's no-plaintext rule when integrated.
5. **Disambiguate sends:** replace `request_send_mail(account)` with explicit
   `send-outlook-mail` and `send-gmail` tools (both through the approval gate);
   keep `get-send-status`. (Wiring the MS365 Graph `sendMail` backend into
   `makeSender` is a prerequisite for `send-outlook-mail`.)
6. **Run-as-service:** launchd plist for the host HTTP credentialed server
   (mirrors the scan / clemson-refresh plists).
7. **Docs:** update `src/mcp-server.md` (two servers, transports, auth) and
   **rewrite `skills/add-cuassistant/SKILL.md`** to the current reality:
   - GCassistant Graph backend (not Codex/graph-cli), active mail/calendar
     writes, the 5 Clemson tools, send-via-approval-gate, snapshots/refresh.
   - Register `cuassistant-credentialed` as an HTTP server (url + vault-injected bearer)
     in NanoClaw **user/local** config; register `cuassistant-public` as an HTTP server
     (`url: "http://host.docker.internal:8766/"`, no bearer).
   - Keep write/send tools off the NanoClaw allowlist.

## nanoclaw-personal repo changes (the contract)

Additive and idempotent, but **wider than one interface** — the
`{command,args,env}` config shape is redeclared in five places and threaded
CLI → DB → container.json → harness. Miss one and `url`/`headers` are silently
dropped at the `index.ts` passthrough (a known schema-sweep failure mode in
this repo).

1. **Config-type sweep — extend all five to allow `{ url, headers? }` and make
   `command` optional:**
   - `src/container-config.ts` (host materialization type)
   - `container/agent-runner/src/harnesses/types.ts` (`McpServerConfig`)
   - `container/agent-runner/src/config.ts` (inline runner-config type)
   - `container/agent-runner/src/index.ts` (inline map type that rebuilds the dict)
   - `pi-mcp-bridge.ts` (bridge type)
2. **Config entry points — relax `command`-required, accept `url`/`headers`:**
   - `ncl groups config add-mcp-server` (`groups.ts`, ~line 186)
   - the `add_mcp_server` self-mod tool schema (`self-mod.ts`, ~line 104)
   - Both write the entry to user/local (gitignored) config, **never** the
     committed `.mcp.json`.
3. **Bridge — add an HTTP branch _inside_ the `for…of servers` loop.** Do NOT
   reuse `createPiHttpMcpBridge`: it hardcodes the `nanoclaw` server name and
   the `x-nanoclaw-session` header and takes a bare url+sessionId. Reuse the
   transport class, not the bridge function:
   ```ts
   for (const [serverName, config] of Object.entries(servers)) {
     if (hasHttpNanoclaw && serverName === "nanoclaw") continue;
     const transport = config.url
       ? new StreamableHTTPClientTransport(new URL(config.url), {
           requestInit: { headers: resolveHeaders(config.headers) },
         })
       : new StdioClientTransport({
           command: config.command!,
           args: config.args,
           env: config.env,
         });
     // …existing connect + loadToolsFromClient(serverName, client)…
   }
   ```
4. **`resolveHeaders`** — expand `${ENV_VAR}` references in header values from
   the container env at connect time, so persisted config holds only a
   reference, never the token (see Auth model).
5. **Networking — effectively a no-op.** `container-runtime.ts` already injects
   `--add-host=host.docker.internal:host-gateway` on Linux; macOS resolves it
   natively. It matters only because our credentialed server is a host-local
   proxy; public `https://` endpoints wouldn't need it at all.

## Auth model

NanoClaw persists a server's `headers` into the `mcp_servers` column of
`data/v2.db` and rewrites them into `groups/<folder>/container.json` on every
spawn — in plaintext. A literal bearer in `headers` would therefore sit at rest
on disk, reintroducing exactly what OneCLI exists to prevent.

- **Target — vault-referenced bearer.** `headers` holds a _reference_, not the
  secret: `Authorization: "Bearer ${CUASSISTANT_MCP_TOKEN}"`. OneCLI injects the
  real token into the container env at spawn (the `/add-gmail-tool` stub
  pattern); the bridge's `resolveHeaders` expands `${…}` from env at connect
  time. Only the reference is persisted; the secret stays in the vault +
  transient container env.
- **Interim (until vault injection is wired) — no bearer.** Bind the
  credentialed server to `127.0.0.1`; rely on loopback + the policy allow-list +
  the human-approval gate. Nothing secret is written at rest, which is strictly
  better than a plaintext token on disk. Residual risk: a host-local process
  could call the read tools (mailbox/calendar reads); acceptable on a
  single-user machine and closed by the target model.
- **Never** inline a literal secret into `headers` / `.mcp.json` /
  `container.json`.

CUassistant's HTTP server enforces bearer when `MCP_AUTH_TOKEN` is set and is
loopback-open when it isn't, so interim → target is just "wire the vault
injection" — no tool or transport changes.

## Security model (defense in depth)

| Layer           | Control                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Agent runtime   | NanoClaw container / filesystem isolation                                                       |
| Network         | credentialed server binds loopback; not exposed to LAN                                          |
| Caller auth     | vault-referenced env-expanded bearer (target); loopback-only (interim)                          |
| Capability      | `action-policy.yaml` allow-list; per-call constraint validators                                 |
| Destructive ops | delete/RSVP/trigger-scan = `human_required`, unexposed                                          |
| Sends           | Telegram approval gate (frozen until approved) **and** off NanoClaw's allowlist (always prompt) |
| Audit           | append-only `decisions.jsonl`                                                                   |
| Credential      | MS365 token host-only (vault/.env); never in the container                                      |
| Public tools    | isolated in a no-credential server                                                              |

## Rollout

1. Stand up `cuassistant-public` (public, read-only) first; confirm.
2. Stand up `cuassistant-credentialed` read-only (reads only); confirm auth + reach.
3. Enable writes (already policy-gated); confirm sends prompt via the gate.
4. After stabilization, run `/fewer-permission-prompts` to allowlist the
   read-only `mcp__*` calls — leave every write/send prompting.

## Testing

- **CUassistant:** auth gate (401 without/with bad bearer); HTTP exposes the
  same tool list as stdio; the two servers expose disjoint, expected tool sets.
  (Existing 40 tests stay green.)
- **NanoClaw:** extend `pi-mcp-bridge.test.ts` — a `url` config selects the HTTP
  transport (mock), a `command` config selects stdio.

## Open questions / follow-ups

- Wiring the MS365 `sendMail` backend into `makeSender` (prereq for
  `send-outlook-mail`) — separate, already-noted work.
- Sequencing across the two repos: CUassistant-side (HTTP transport, split,
  skill) and nanoclaw-side (5-type sweep, bridge HTTP branch, vault stub) can
  land independently against this shared contract; the interim no-bearer mode
  lets CUassistant be exercised before the vault stub exists.
