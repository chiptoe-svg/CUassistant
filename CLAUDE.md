# CUassistant — working notes

## MCP servers are long-lived daemons — restart after any tool/policy change

The three MCP servers (`8765` credentialed, `8766` public, `8767` catalog) run as
launchd daemons that load their tool registry and `policy/action-policy.yaml`
**once at process start**. Editing the source does NOT update a running server —
it keeps serving the old build and fails silently (the new tool simply never
appears in `tools/list`).

**Any change that adds, removes, renames, or reshapes an MCP tool — or edits
`permissions.ts` / `action-policy.yaml` — is not "done" until the affected
service is restarted and the tool list is verified.** Treat this as the final
step of shipping the functionality, alongside typecheck and tests.

Restart commands, the code→server map, and the verification probe are in
`src/mcp-server.md` → "Deploying tool or policy changes — RESTART REQUIRED".
The `mcp-public-bridge` forwarder does not need restarting.

The advisor chat (`com.cuassistant.advisor`, port 8770) is a fourth long-lived
service. It consumes the public MCP servers over loopback and adds no MCP tools
of its own, so tool/policy changes do not require restarting it — but it holds
every session in memory, so restarting it ends all in-flight conversations.
