// Device-code login for the Microsoft Graph Command Line Tools first-party
// client. Run once to populate GRAPH_CLI_REFRESH_TOKEN in .env.
//
//   npm run graph-cli-tasks-login
//
// This path is useful when Clemson has already consented Tasks.ReadWrite for
// the Graph CLI client but has not restored consent for the GCassistant app.

import { existsSync, readFileSync, promises as fs } from "fs";
import { resolve } from "path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (!(k in process.env)) process.env[k] = v.replace(/^['"]|['"]$/g, "");
  }
}

const CLIENT_ID =
  process.env.GRAPH_CLI_CLIENT_ID || "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const TENANT_ID = process.env.GRAPH_CLI_TENANT_ID || "common";
const SCOPE = "https://graph.microsoft.com/Tasks.ReadWrite offline_access";
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;

interface DeviceCodeResponse {
  user_code: string;
  device_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function main() {
  const dcResp = await fetch(`${AUTHORITY}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!dcResp.ok) {
    console.error("device code request failed:", await dcResp.text());
    process.exit(1);
  }
  const dc = (await dcResp.json()) as DeviceCodeResponse;
  console.log("\n1. Open:", dc.verification_uri);
  console.log("2. Enter code:", dc.user_code);
  console.log(
    "3. Sign in with the account whose To Do tasks should be used.\n",
  );
  console.log(
    `Polling every ${dc.interval}s (expires in ${Math.round(dc.expires_in / 60)}m)...`,
  );

  const deadlineMs = Date.now() + dc.expires_in * 1000;
  let interval = (dc.interval || 5) * 1000;

  while (Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, interval));
    const tResp = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: dc.device_code,
      }),
    });
    const t = (await tResp.json()) as TokenResponse;
    if (t.access_token && t.refresh_token) {
      console.log("\nGot refresh token. Updating .env...");
      await updateEnv(t.refresh_token);
      console.log("Done. Set TASK_PROVIDER=graph-cli to use it.");
      return;
    }
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") {
      interval += 5000;
      continue;
    }
    console.error("\ntoken request failed:", t.error, "-", t.error_description);
    process.exit(1);
  }
  console.error("\ndevice code expired before authorization completed");
  process.exit(1);
}

async function updateEnv(refreshToken: string) {
  let body = "";
  try {
    body = await fs.readFile(envPath, "utf8");
  } catch {
    body = "";
  }
  const line = `GRAPH_CLI_REFRESH_TOKEN=${refreshToken}`;
  const replaced = /^GRAPH_CLI_REFRESH_TOKEN=.*$/m.test(body)
    ? body.replace(/^GRAPH_CLI_REFRESH_TOKEN=.*$/m, line)
    : body.replace(/\n?$/, `\n${line}\n`);
  await fs.writeFile(envPath, replaced, { mode: 0o600 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
