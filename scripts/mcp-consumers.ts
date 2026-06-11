// Manage the per-agent credential registry for the credentialed MCP server.
//
//   npm run mcp:pair -- --id <agent> --provider <p> [--scope a,b] [--note "..."]
//                                                        mint/rotate a token
//   npm run mcp:consumers -- --attest <agent> --provider <p> [--scope a,b]
//                                                        set provider/scope in
//                                                        place (token unchanged)
//   npm run mcp:consumers -- --list                      list authorized agents
//   npm run mcp:consumers -- --revoke <agent>            revoke an agent
//   npm run mcp:consumers -- --check [--max-age-days N] [--max-idle-days N]
//
// --provider must be authorized in policy/action-policy.yaml (data_egress.
// agent_backends); --scope tokens come from SCOPE_OPERATIONS (omit = full).
// Only the SHA-256 hash of each token is stored. The raw token is printed ONCE
// at pair time — copy it into the target agent's container env then.

import {
  attestConsumer,
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
  staleConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.js";
import {
  approvedProviders,
  invalidScopeTokens,
  providerIsApproved,
  validScopeTokens,
} from "./mcp-consumers-helpers.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Read + validate --provider against the policy approved list, or exit(1). */
function requireApprovedProvider(): string {
  const provider = arg("--provider");
  if (!provider) {
    console.error("error: --provider <p> is required.");
    console.error(`approved providers: ${approvedProviders().join(", ")}`);
    process.exit(1);
  }
  if (!providerIsApproved(provider)) {
    console.error(
      `error: provider "${provider}" is not authorized in ` +
        `policy/action-policy.yaml (data_egress.agent_backends).`,
    );
    console.error(`approved providers: ${approvedProviders().join(", ")}`);
    process.exit(1);
  }
  return provider;
}

/** Read + validate --scope (optional); undefined when absent; exit(1) on a bad token. */
function parseScopeArg(): string[] | undefined {
  const raw = arg("--scope");
  if (raw === undefined) return undefined;
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = invalidScopeTokens(tokens);
  if (bad.length) {
    console.error(`error: unknown scope token(s): ${bad.join(", ")}`);
    console.error(`valid tokens: ${validScopeTokens().join(", ")}`);
    process.exit(1);
  }
  return tokens;
}

function printRegistrationHelp(id: string, token: string): void {
  console.log(`\nToken for "${id}" (shown once — store it now):\n`);
  console.log(`  ${token}\n`);
  console.log("Provision this agent in NanoClaw:");
  console.log(
    `  1. Inject the token into ONLY this agent's container env via OneCLI vault as\n` +
      `     CUASSISTANT_MCP_TOKEN (do not write the literal into committed config).`,
  );
  console.log(
    `  2. Register the server for that group:\n` +
      `     ncl groups config add-mcp-server --id ${id} \\\n` +
      `       --name cuassistant-credentialed \\\n` +
      `       --url http://host.docker.internal:8765/ \\\n` +
      `       --headers '{"Authorization":"Bearer \${CUASSISTANT_MCP_TOKEN}"}'`,
  );
  console.log(
    `  3. Restart the credentialed MCP server so it reloads the registry.\n`,
  );
}

function pair(): void {
  const id = arg("--id");
  if (!id) {
    console.error(
      'usage: mcp:pair -- --id <agent> --provider <p> [--scope a,b] [--note "..."]',
    );
    process.exit(1);
  }
  const provider = requireApprovedProvider();
  const scopes = parseScopeArg();
  const note = arg("--note");
  const token = generateToken();
  const list = loadConsumers();
  const existing = list.find((c) => c.id === id);
  if (existing) {
    existing.token_hash = hashToken(token);
    existing.last_seen_at = undefined;
    existing.provider = provider;
    if (scopes !== undefined) existing.scopes = scopes;
    if (note !== undefined) existing.note = note;
    console.log(
      `Rotated token for "${id}" (provider=${provider}, scope=${existing.scopes?.join(",") ?? "full"}).`,
    );
  } else {
    const c: Consumer = {
      id,
      token_hash: hashToken(token),
      created_at: nowIso(),
      provider,
    };
    if (scopes !== undefined) c.scopes = scopes;
    if (note !== undefined) c.note = note;
    list.push(c);
    console.log(
      `Registered "${id}" (provider=${provider}, scope=${scopes?.join(",") ?? "full"}).`,
    );
  }
  saveConsumers(list);
  printRegistrationHelp(id, token);
}

function list(): void {
  const consumers = loadConsumers();
  if (consumers.length === 0) {
    console.log(
      "No authorized consumers. The credentialed HTTP server will refuse to " +
        "start until you run `npm run mcp:pair -- --id <agent>`.",
    );
    return;
  }
  for (const c of consumers) {
    const att = c.provider
      ? `provider=${c.provider}`
      : "UNATTESTED(run --attest)";
    const scope = c.scopes?.length ? c.scopes.join(",") : "full";
    console.log(
      `- ${c.id}  ${att}  scope=${scope}  created=${c.created_at}  ` +
        `last_seen=${c.last_seen_at ?? "never"}  hash=${c.token_hash.slice(0, 8)}…` +
        `${c.note ? `  note=${c.note}` : ""}`,
    );
  }
}

function revoke(): void {
  const id = arg("--revoke");
  if (!id) {
    console.error("usage: mcp:consumers -- --revoke <agent>");
    process.exit(1);
  }
  const before = loadConsumers();
  const after = before.filter((c) => c.id !== id);
  if (after.length === before.length) {
    console.error(`No consumer "${id}" found.`);
    process.exit(1);
  }
  saveConsumers(after);
  console.log(
    `Revoked "${id}". Restart the server to drop it immediately (or it lapses ` +
      `on the next per-request registry reload).`,
  );
}

function attest(): void {
  const id = arg("--attest");
  if (!id) {
    console.error(
      "usage: mcp:consumers -- --attest <agent> --provider <p> [--scope a,b]",
    );
    process.exit(1);
  }
  const provider = requireApprovedProvider();
  const scopes = parseScopeArg();
  const list = loadConsumers();
  try {
    attestConsumer(list, id, provider, scopes);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  saveConsumers(list);
  const c = list.find((x) => x.id === id);
  console.log(
    `Attested "${id}": provider=${provider}, scope=${c?.scopes?.join(",") ?? "full"} ` +
      `(token unchanged). Takes effect on the next request — the registry is ` +
      `reloaded per request, so no restart is needed. (A policy change to ` +
      `agent_backends still requires a server restart.)`,
  );
}

function check(): void {
  const maxAgeDays = Number(arg("--max-age-days") ?? 365);
  const maxIdleDays = Number(arg("--max-idle-days") ?? 90);
  const consumers = loadConsumers();
  const flagged = staleConsumers(consumers, {
    nowMs: Date.now(),
    maxAgeDays,
    maxIdleDays,
  });
  if (flagged.length === 0) {
    console.log(
      `No stale consumers (age>${maxAgeDays}d or idle>${maxIdleDays}d). ` +
        `Nothing to rotate.`,
    );
  } else {
    console.log("Consider rotating (warn-only — nothing is severed):");
    for (const f of flagged) {
      console.log(
        `- ${f.id}: ${f.reason} (age=${f.ageDays}d, idle=${f.idleDays}d)`,
      );
    }
  }
  // Always surface unattested consumers — they are rejected at runtime, so this
  // must show even when nothing is stale.
  const unattested = consumers.filter((c) => !c.provider).map((c) => c.id);
  if (unattested.length) {
    console.log(
      `Unattested (rejected at runtime — run ` +
        `\`mcp:consumers -- --attest <id> --provider <p>\`): ${unattested.join(", ")}`,
    );
  }
}

if (has("--list")) list();
else if (has("--revoke")) revoke();
else if (has("--attest")) attest();
else if (has("--check")) check();
else pair();
