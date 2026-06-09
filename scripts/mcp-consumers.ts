// Manage the per-agent credential registry for the credentialed MCP server.
//
//   npm run mcp:pair   -- --id <agent> [--note "..."]   mint/rotate a token
//   npm run mcp:consumers -- --list                      list authorized agents
//   npm run mcp:consumers -- --revoke <agent>            revoke an agent
//   npm run mcp:consumers -- --check [--max-age-days N] [--max-idle-days N]
//
// Only the SHA-256 hash of each token is stored. The raw token is printed ONCE
// at pair time — copy it into the target agent's container env then.

import {
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
  staleConsumers,
  type Consumer,
} from "../src/mcp-tools/consumers.js";

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
    console.error('usage: mcp:pair -- --id <agent> [--note "..."]');
    process.exit(1);
  }
  const note = arg("--note");
  const token = generateToken();
  const list = loadConsumers();
  const existing = list.find((c) => c.id === id);
  if (existing) {
    existing.token_hash = hashToken(token);
    existing.last_seen_at = undefined;
    if (note !== undefined) existing.note = note;
    console.log(`Rotated token for existing consumer "${id}".`);
  } else {
    const c: Consumer = {
      id,
      token_hash: hashToken(token),
      created_at: nowIso(),
    };
    if (note !== undefined) c.note = note;
    list.push(c);
    console.log(`Registered new consumer "${id}".`);
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
    console.log(
      `- ${c.id}  created=${c.created_at}  last_seen=${c.last_seen_at ?? "never"}` +
        `  hash=${c.token_hash.slice(0, 8)}…${c.note ? `  note=${c.note}` : ""}`,
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

function check(): void {
  const maxAgeDays = Number(arg("--max-age-days") ?? 365);
  const maxIdleDays = Number(arg("--max-idle-days") ?? 90);
  const flagged = staleConsumers(loadConsumers(), {
    nowMs: Date.now(),
    maxAgeDays,
    maxIdleDays,
  });
  if (flagged.length === 0) {
    console.log(
      `No stale consumers (age>${maxAgeDays}d or idle>${maxIdleDays}d). ` +
        `Nothing to rotate.`,
    );
    return;
  }
  console.log("Consider rotating (warn-only — nothing is severed):");
  for (const f of flagged) {
    console.log(
      `- ${f.id}: ${f.reason} (age=${f.ageDays}d, idle=${f.idleDays}d)`,
    );
  }
}

if (has("--list")) list();
else if (has("--revoke")) revoke();
else if (has("--check")) check();
else pair();
