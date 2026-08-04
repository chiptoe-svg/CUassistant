# CUassistant — working notes

## `.env` is irreplaceable — back it up before ANY edit

`.env` holds unrecoverable secrets (LLM/OpenAI keys, MCP auth tokens, the advisor
password, MS365/Telegram tokens) and is gitignored — there is **no `git checkout`
fallback**. It has been destroyed once by `some_cmd > .env` where `some_cmd`
produced no output: the shell truncated `.env` to empty *before* the command ran.

Rules — non-negotiable:

- **Before any command that writes, edits, appends to, or truncates `.env`**, run
  `bash scripts/backup-env.sh` and confirm it printed a success line. It refuses
  when `.env` looks truncated, so a broken file can never overwrite good backups.
- **Never** use `> .env` (truncation) or pipe a possibly-empty command into it.
  Never `perl -i` / `sed -i` on `.env`. Edit via a temp file, verify it, then
  `mv tmp .env` (atomic).
- **Always end `.env` with a newline** before `>>`-appending, or the new line
  glues onto the previous value (this has corrupted tokens here too).
- Recovery of last resort: a running Node daemon holds the values in
  `process.env`; `sudo lldb -p <server-child-pid>` →
  `expr -l objc -- (void)[[[NSProcessInfo processInfo] environment] writeToFile:@"/tmp/e.plist" atomically:YES]`
  dumps them. Do NOT restart a daemon before `.env` is whole — the live process
  is the only remaining copy.

Backups live in `~/.cuassistant/env-backups/` (last 30, 0600). The real fix is a
proper secret store; until then, this script is the guard.

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
