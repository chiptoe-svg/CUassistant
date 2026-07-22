# CUassistant Token Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-service web portal where Clemson faculty/staff authenticate with their Google g.clemson.edu account and receive a scoped bearer token they can paste into their MCP client to access the public CUassistant catalog and schedule tools.

**Architecture:** A new `src/token-portal.ts` HTTP server (Node.js built-in `http`, no new npm deps) runs on `127.0.0.1:8769`. It implements raw Google OAuth2 — `/auth/login` redirects to Google, `/auth/callback` exchanges the code, verifies `hd=g.clemson.edu`, then calls the existing `generateToken()` / `loadConsumers()` / `saveConsumers()` from `src/mcp-tools/consumers.ts` to mint a token scoped to `clemson`. The token is shown once in a plain HTML page. Caddy handles HTTPS termination for external access; `http://localhost:8769` is valid for development/testing (Google explicitly allows loopback redirect URIs without HTTPS).

**Tech Stack:** Node.js built-in `http`, `crypto`; built-in `fetch` for token exchange; Google OAuth2 (raw). Zero new npm dependencies.

**Security notes:**
- `hd=g.clemson.edu` in the OAuth redirect is a UX hint but is **not** the authorization check. The check is `payload.hd === "g.clemson.edu"` on the ID token returned by Google — Google signs this and CUassistant verifies it.
- The JWT `payload` is extracted without local signature verification because it is received directly from `oauth2.googleapis.com` (no third-party relay) — the TLS connection IS the verification.
- Tokens are scoped to `clemson` (read-only public catalog + schedule). They cannot access mail, calendar, or any credentialed data.
- CSRF protection: per-request `state` nonce stored in-memory, expires in 10 minutes.
- Token is shown once and never stored in plaintext — only the SHA-256 hash lives on disk.

---

## Prerequisites — do this before coding

1. **Create a Google Cloud project** (if you don't already have one for CUassistant).
2. **Enable the Google Identity API** (formerly "Google Sign-In" / "OAuth 2.0").
3. **Create an OAuth 2.0 Client ID** — Application type: **Web application**.
4. **Add redirect URIs:**
   - `http://localhost:8769/auth/callback` (for local testing)
   - Your production HTTPS URL, e.g. `https://portal.gcworkflow.clemson.edu/auth/callback` (add once Caddy+DNS are configured)
5. Copy the **Client ID** and **Client Secret** to `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Google allows `http://localhost` redirect URIs without HTTPS — this is explicitly documented in their OAuth 2.0 loopback IP flow.

---

## File Map

| Action | Path |
|--------|------|
| Create | `CUassistant/src/token-portal.ts` |
| Modify | `CUassistant/src/config.ts` — add 4 new exports |
| Modify | `CUassistant/package.json` — add `portal` and `portal:start` scripts |
| Create | `CUassistant/launchd/com.cuassistant.token-portal.plist` |
| Modify | `/opt/homebrew/etc/Caddyfile` — add reverse proxy block |
| Modify | `~/.dev-ports.yaml` — add `token_portal: 8769` |
| Modify | `CUassistant/.env.example` — add 4 new variables |

---

### Task 1: Add config exports

**Files:**
- Modify: `/Users/admin/projects/CUassistant/src/config.ts`

- [ ] **Step 1: Append the four new exports at the bottom of config.ts**

```typescript
// --- Token portal (Google OAuth2 → bearer token issuance) ---
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const TOKEN_PORTAL_PORT = Number(process.env.TOKEN_PORTAL_PORT || 8769);
// Base URL must be HTTPS for production. Defaults to localhost for dev.
export const TOKEN_PORTAL_BASE_URL =
  process.env.TOKEN_PORTAL_BASE_URL || `http://localhost:${process.env.TOKEN_PORTAL_PORT || 8769}`;
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/admin/projects/CUassistant
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/projects/CUassistant
git add src/config.ts
git commit -m "feat(portal): add Google OAuth + token portal config exports"
```

---

### Task 2: Write the token portal server

**Files:**
- Create: `/Users/admin/projects/CUassistant/src/token-portal.ts`

- [ ] **Step 1: Create src/token-portal.ts**

```typescript
// Self-service bearer token portal for Clemson faculty.
// Google OAuth2 flow (raw, no npm deps): /auth/login → Google → /auth/callback.
// On success: verifies hd=g.clemson.edu, mints a clemson-scoped bearer token,
// shows it once. Nothing sends to external services except Google OAuth endpoints.
import http from "node:http";
import crypto from "node:crypto";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  TOKEN_PORTAL_PORT,
  TOKEN_PORTAL_BASE_URL,
} from "./config.js";
import {
  generateToken,
  hashToken,
  loadConsumers,
  saveConsumers,
  type Consumer,
} from "./mcp-tools/consumers.js";

// Per-request nonce → expiry (ms). Prevents CSRF and replay.
const nonces = new Map<string, number>();
const NONCE_TTL_MS = 10 * 60 * 1000;

function pruneNonces() {
  const now = Date.now();
  for (const [k, exp] of nonces) {
    if (now > exp) nonces.delete(k);
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── /auth/login ──────────────────────────────────────────────────────────────

function handleLogin(res: http.ServerResponse): void {
  pruneNonces();
  const state = crypto.randomBytes(16).toString("base64url");
  nonces.set(state, Date.now() + NONCE_TTL_MS);
  const redirectUri = `${TOKEN_PORTAL_BASE_URL}/auth/callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    hd: "g.clemson.edu",
    state,
    access_type: "online",
  });
  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  });
  res.end();
}

// ── /auth/callback ───────────────────────────────────────────────────────────

async function handleCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const error = url.searchParams.get("error");
  if (error) {
    sendHtml(res, 400, errorPage(`Google OAuth error: ${escHtml(error)}`));
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !nonces.has(state)) {
    sendHtml(res, 400, errorPage("Invalid or missing state. Please try again."));
    return;
  }
  if (Date.now() > (nonces.get(state) ?? 0)) {
    nonces.delete(state);
    sendHtml(res, 400, errorPage("Login session expired. Please try again."));
    return;
  }
  nonces.delete(state);

  // Exchange code for tokens
  const redirectUri = `${TOKEN_PORTAL_BASE_URL}/auth/callback`;
  let idToken: string;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      throw new Error(`${tokenRes.status} ${body}`);
    }
    const data = (await tokenRes.json()) as { id_token?: string };
    if (!data.id_token) throw new Error("No id_token in response");
    idToken = data.id_token;
  } catch (e) {
    sendHtml(res, 500, errorPage("Token exchange failed. Please try again."));
    console.error("token-portal: token exchange error:", e);
    return;
  }

  // Decode the JWT payload (received directly from Google over TLS — no separate sig verify needed)
  let email: string;
  let hd: string | undefined;
  try {
    const payloadB64 = idToken.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8"),
    ) as { email?: string; hd?: string };
    email = payload.email ?? "";
    hd = payload.hd;
  } catch (e) {
    sendHtml(res, 500, errorPage("Could not decode identity token."));
    return;
  }

  // Enforce hosted domain: must be g.clemson.edu
  if (hd !== "g.clemson.edu" || !email.endsWith("@g.clemson.edu")) {
    sendHtml(
      res,
      403,
      errorPage(
        `Access restricted to g.clemson.edu accounts. ` +
          `You signed in as ${escHtml(email || "(unknown)")}. ` +
          `Please use your Clemson Google Workspace account (@g.clemson.edu).`,
      ),
    );
    return;
  }

  // Mint a token scoped to clemson (read-only public data)
  const id = `portal-${email.replace("@", "-at-").replace(/\./g, "-")}`;
  const token = generateToken();
  const consumers = loadConsumers();
  const existing = consumers.findIndex((c) => c.id === id);
  const entry: Consumer = {
    id,
    token_hash: hashToken(token),
    created_at: new Date().toISOString(),
    note: `Google OAuth portal — ${email}`,
    provider: "openai_api",
    scopes: ["clemson"],
  };
  if (existing >= 0) {
    consumers[existing] = { ...consumers[existing], ...entry };
  } else {
    consumers.push(entry);
  }
  saveConsumers(consumers);

  sendHtml(res, 200, tokenPage(email, token));
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function shell(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CUassistant — Clemson Catalog Access</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:1rem;line-height:1.5}
    pre{background:#f4f4f4;padding:1rem;border-radius:4px;overflow-x:auto;word-break:break-all;white-space:pre-wrap}
    .warn{color:#c00;font-weight:bold}
    a.btn{display:inline-block;margin-top:1rem;padding:.5rem 1.25rem;background:#522D80;color:#fff;text-decoration:none;border-radius:4px}
  </style>
</head>
<body>${body}</body>
</html>`;
}

function errorPage(msg: string): string {
  return shell(`<h1>Error</h1><p>${msg}</p>`);
}

function tokenPage(email: string, token: string): string {
  return shell(`
<h1>Your CUassistant Token</h1>
<p>Signed in as <strong>${escHtml(email)}</strong>.</p>
<p class="warn">Copy this token now — it will not be shown again.</p>
<pre>${escHtml(token)}</pre>
<p>This token grants read-only access to Clemson public catalog and class schedule data (<code>clemson</code> scope). It does not access your email, calendar, or any personal data.</p>
<p>Paste it as the Bearer value in your MCP client's CUassistant connection config under <code>CUASSISTANT_MCP_TOKEN</code>.</p>
<p>To revoke: contact the system administrator (the token ID is <code>${escHtml(`portal-${email.replace("@", "-at-").replace(/\./g, "-")}`)}</code>).</p>`);
}

function homePage(): string {
  return shell(`
<h1>CUassistant — Clemson Faculty Access</h1>
<p>Sign in with your Clemson Google Workspace account to get a bearer token for the CUassistant catalog and class schedule tools.</p>
<p>You must use a <strong>@g.clemson.edu</strong> account.</p>
<a class="btn" href="/auth/login">Sign in with Google</a>`);
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (pathname === "/auth/login") return handleLogin(res);
  if (pathname === "/auth/callback") return handleCallback(req, res);
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (pathname === "/" || pathname === "") {
    sendHtml(res, 200, homePage());
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error("token-portal unhandled error:", e);
    if (!res.headersSent) {
      sendHtml(res, 500, errorPage("Internal server error."));
    }
  }
});

server.listen(TOKEN_PORTAL_PORT, "127.0.0.1", () => {
  console.log(
    `token-portal running on http://127.0.0.1:${TOKEN_PORTAL_PORT}`,
  );
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn(
      "WARNING: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set — OAuth will fail",
    );
  }
});
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/admin/projects/CUassistant
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/projects/CUassistant
git add src/token-portal.ts
git commit -m "feat(portal): token portal server — Google OAuth2 + clemson-scoped token issuance"
```

---

### Task 3: Add npm scripts

**Files:**
- Modify: `/Users/admin/projects/CUassistant/package.json`

- [ ] **Step 1: Add portal scripts**

In the `"scripts"` block, add after the `mcp:catalog:http` line:

```json
"portal": "tsx src/token-portal.ts",
"portal:start": "TOKEN_PORTAL_BASE_URL=http://localhost:8769 tsx src/token-portal.ts",
```

- [ ] **Step 2: Verify it starts (without valid creds)**

```bash
cd /Users/admin/projects/CUassistant
npm run portal:start &
sleep 1
curl -s http://127.0.0.1:8769/health
kill %1
```

Expected: `{"ok":true}` and a `WARNING: GOOGLE_CLIENT_ID...` message in stderr.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/projects/CUassistant
git add package.json
git commit -m "feat(portal): add portal and portal:start npm scripts"
```

---

### Task 4: Update .env.example

**Files:**
- Modify: `/Users/admin/projects/CUassistant/.env.example`

- [ ] **Step 1: Add portal vars**

Find the block in `.env.example` and add a portal section:

```
# --- Token portal (Google OAuth2 self-service) ---
# Create an OAuth2 client at console.cloud.google.com
# Add redirect URI: http://localhost:8769/auth/callback (dev)
# Add redirect URI: https://portal.gcworkflow.clemson.edu/auth/callback (prod)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TOKEN_PORTAL_PORT=8769
# Set to HTTPS URL for production (default: http://localhost:8769)
TOKEN_PORTAL_BASE_URL=
```

- [ ] **Step 2: Commit**

```bash
cd /Users/admin/projects/CUassistant
git add .env.example
git commit -m "docs(portal): add portal env vars to .env.example"
```

---

### Task 5: Create the launchd plist

**Files:**
- Create: `/Users/admin/projects/CUassistant/launchd/com.cuassistant.token-portal.plist`

- [ ] **Step 1: Create the template plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  CUassistant token portal service for launchd.

  Runs the Google OAuth2 self-service portal on 127.0.0.1:8769.
  Caddy must proxy HTTPS traffic to this port for external access.

  Setup (one time):
    1. Edit this file: replace NPM_PATH, REPO_PATH, HOME_PATH.
       - NPM_PATH  → run `which npm`
       - REPO_PATH → /Users/admin/projects/CUassistant
       - HOME_PATH → /Users/admin
    2. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (or EnvironmentVariables below).
    3. cp launchd/com.cuassistant.token-portal.plist ~/Library/LaunchAgents/
    4. launchctl load ~/Library/LaunchAgents/com.cuassistant.token-portal.plist
    5. curl http://127.0.0.1:8769/health
-->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cuassistant.token-portal</string>

  <key>ProgramArguments</key>
  <array>
    <string>NPM_PATH</string>
    <string>run</string>
    <string>portal</string>
  </array>

  <key>WorkingDirectory</key>
  <string>REPO_PATH</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>HOME_PATH</string>
    <!-- TOKEN_PORTAL_BASE_URL must be your public HTTPS URL once Caddy+DNS are set up -->
    <!-- <key>TOKEN_PORTAL_BASE_URL</key> -->
    <!-- <string>https://portal.gcworkflow.clemson.edu</string> -->
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>HOME_PATH/Library/Logs/cuassistant.token-portal.out.log</string>
  <key>StandardErrorPath</key>
  <string>HOME_PATH/Library/Logs/cuassistant.token-portal.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Commit the template**

```bash
cd /Users/admin/projects/CUassistant
git add launchd/com.cuassistant.token-portal.plist
git commit -m "feat(portal): add launchd plist for token portal (port 8769)"
```

---

### Task 6: Caddy reverse proxy for HTTPS

This task exposes the portal at an HTTPS URL so Google OAuth accepts it as a production redirect URI. Skip this task if you're only testing locally (`http://localhost:8769` works without Caddy for local dev).

**Files:**
- Modify: `/opt/homebrew/etc/Caddyfile`

- [ ] **Step 1: Decide on public hostname**

Options (pick one):
- **Tailscale Funnel** (recommended — already used by voicelab): `tailscale funnel --bg 8769` then use the `<machine>.tailnet.ts.net` URL as `TOKEN_PORTAL_BASE_URL`.
- **Caddy + real subdomain**: Add a DNS record for e.g. `portal.gcworkflow.clemson.edu` pointing at your public IP, then let Caddy auto-provision TLS via Let's Encrypt.

For the Caddy approach (if you have DNS):

- [ ] **Step 2: Add portal block to Caddyfile**

Read `/opt/homebrew/etc/Caddyfile` first, then append:

```caddyfile
portal.gcworkflow.clemson.edu {
    reverse_proxy 127.0.0.1:8769
}
```

Replace `portal.gcworkflow.clemson.edu` with your actual subdomain. Caddy will obtain a Let's Encrypt certificate automatically (port 80/443 must be reachable from the internet).

- [ ] **Step 3: Reload Caddy**

```bash
/opt/homebrew/bin/caddy reload --config /opt/homebrew/etc/Caddyfile
```

Expected: no errors. Caddy validates the config before reloading.

- [ ] **Step 4: Test HTTPS redirect**

```bash
curl -s https://portal.gcworkflow.clemson.edu/health
```

Expected: `{"ok":true}`

- [ ] **Step 5: Update TOKEN_PORTAL_BASE_URL in .env and launchd plist**

In `.env`:
```
TOKEN_PORTAL_BASE_URL=https://portal.gcworkflow.clemson.edu
```

In the installed launchd plist, uncomment the `TOKEN_PORTAL_BASE_URL` key and set the HTTPS URL, then reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.cuassistant.token-portal.plist
launchctl load ~/Library/LaunchAgents/com.cuassistant.token-portal.plist
```

- [ ] **Step 6: Add production redirect URI in Google Cloud Console**

Go to your OAuth2 Client ID settings and add:
```
https://portal.gcworkflow.clemson.edu/auth/callback
```

---

### Task 7: Update dev-ports.yaml

**Files:**
- Modify: `/Users/admin/.dev-ports.yaml`

- [ ] **Step 1: Add portal port to the cuassistant section**

Find the `cuassistant:` section and add under services:

```yaml
      token_portal:  8769   # 127.0.0.1, Google OAuth2 portal (g.clemson.edu auth → bearer token)
```

And update the notes to mention the portal:

```yaml
    notes: "MS365/Clemson MCP provider for nanoclaw_personal. Four services: three MCP servers (8765/8766/8767) + token portal (8769). Token portal issues scoped bearer tokens to g.clemson.edu faculty via Google OAuth2."
```

- [ ] **Step 2: Verify no conflict**

```bash
grep "8769" ~/.dev-ports.yaml
```

Expected: only the new line.

---

## End-to-End Verification (local dev)

```bash
# 1. Set up .env (requires real Google OAuth credentials)
# GOOGLE_CLIENT_ID=<from Google Cloud Console>
# GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
# TOKEN_PORTAL_BASE_URL=http://localhost:8769

# 2. Start the portal
cd /Users/admin/projects/CUassistant
npm run portal:start

# 3. Health check
curl -s http://127.0.0.1:8769/health   # {"ok":true}

# 4. Browser test
# Open http://localhost:8769 in a browser
# Click "Sign in with Google"
# Sign in with a @g.clemson.edu account
# You should see a token like cma_<base64url>
# Attempting with a non-g.clemson.edu account should show the 403 domain error

# 5. Verify token was registered
npm run mcp:consumers -- --list
# Should show portal-<email> entry with scopes: ["clemson"]

# 6. Verify token works against the public MCP server
MCP_TRANSPORT=http npm run mcp:catalog:http &
sleep 1
curl -s -H "Authorization: Bearer <token from step 4>" \
  http://127.0.0.1:8767/   # MCP catalog endpoint
# (Or use the mcp CLI / a tool call)
kill %1
```

## Rollback

Tokens issued through the portal can be revoked individually:

```bash
npm run mcp:consumers -- --revoke portal-<email-id>
```

Or revoke all portal-prefixed tokens:

```bash
npm run mcp:consumers -- --list | grep portal-
# Then revoke each one by its id
```
