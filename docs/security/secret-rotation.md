# Secret Rotation & Handling Runbook

Covers the three secrets CUassistant holds and the portable bundle that carries
them. Audience: the operator (single-user host). Companion to the IT-review
hardening in `src/mcp-tools/consumers.ts`, `src/mcp-tools/server.ts`, and the
machine-bundle scripts.

## Secrets at a glance

| Secret                                      | Where                                  | Lifetime                            | Rotate when                                                                |
| ------------------------------------------- | -------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| MS365 refresh token (`MS365_REFRESH_TOKEN`) | `.env` (host, `0600`)                  | long-lived (delegated, self-scoped) | suspected exposure; offboarding; periodic (e.g. yearly)                    |
| Per-agent MCP tokens                        | `state/mcp-consumers.json` (hash only) | until revoked                       | suspected exposure; agent decommissioned; `mcp:consumers --check` flags it |
| `OPENAI_API_KEY` (optional)                 | `.env` (host, `0600`)                  | per provider                        | provider policy / exposure                                                 |

## 1. MS365 refresh token

This delegated token can do only what _you_ can do to _your own_ mailbox/
calendar/tasks, and IT can revoke it tenant-side at any time. Every call is
attributable to your identity in the **M365 unified audit log — the
authoritative audit trail** (not `state/decisions.jsonl`, which is a local
convenience copy).

**Rotate / revoke:**

1. Re-run the login flow to mint a fresh refresh token:
   `npm run ms365-login` → paste the new value into `.env` as `MS365_REFRESH_TOKEN`.
2. Restart any running services (`launchctl kickstart -k …` for the scan +
   MCP launchd jobs) so the new token is picked up.
3. To **revoke** instead: have IT remove/disable the GCassistant app consent,
   or reset the account — this kills the token immediately. Then clear it from
   `.env`.

## 2. Per-agent MCP tokens (credentialed server access)

Each agent authorized to reach the credentialed MCP server has its **own**
bearer token; only its SHA-256 hash is stored. Access is granted by
provisioning and denied by omission — an un-provisioned agent gets nothing, and
the credentialed HTTP server **fails closed** (refuses to start) with no
registered consumers.

```sh
# Grant / rotate a specific agent's token (prints the token ONCE):
npm run mcp:pair -- --id <agent-id> [--note "what this agent is"]

# List authorized agents (id, created, last_seen, hash prefix):
npm run mcp:consumers -- --list

# Revoke an agent:
npm run mcp:consumers -- --revoke <agent-id>

# Staleness check (warn-only; rotate candidates by age/idle):
npm run mcp:consumers -- --check [--max-age-days 365] [--max-idle-days 90]
```

**Rotation = re-pair:** `mcp:pair --id <same-id>` mints a new token (and resets
`last_seen`). Then re-inject the new token into that agent's container env
(`CUASSISTANT_MCP_TOKEN`, via OneCLI vault — never a literal in committed
config) and restart the MCP server so it reloads the registry. Tokens do **not**
expire on a timer (an expiry would silently sever the agent); rotate
deliberately, guided by `--check`.

## 3. Machine bundle (`scripts/export-machine-bundle.sh`)

The bundle carries `.env` (refresh token + keys), live config, and `state/`.
By default it is **encrypted** (openssl AES-256, PBKDF2) into a single
`<name>.tar.gz.enc` and the plaintext staging dir is removed:

```sh
scripts/export-machine-bundle.sh /Volumes/Drive            # encrypted (prompts for passphrase)
scripts/install-machine-bundle.sh /Volumes/Drive/cuassistant-machine-bundle.tar.gz.enc
```

- Choose a strong passphrase; store it separately from the media.
- `--plaintext` exists for emergencies only and prints a loud warning — it
  leaves the refresh token in cleartext on the destination.
- After restoring onto a new host, **rotate the refresh token** (§1) if the old
  media left your control, and treat the encrypted file as a secret at rest.

## Notes

- Local `state/decisions.jsonl` integrity can be checked with
  `npm run audit:verify`; set `AUDIT_APPEND_ONLY=1` to mark it OS-append-only.
  Neither is a substitute for the M365 unified audit log.
- Never inject the MS365 token into any agent container — agents call tools; the
  credential stays host-side.
