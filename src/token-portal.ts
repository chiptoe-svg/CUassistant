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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
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
    sendHtml(res, 400, errorPage(`Google OAuth error: ${error}`));
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
          `You signed in as ${email || "(unknown)"}. ` +
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
  return shell(`<h1>Error</h1><p>${escHtml(msg)}</p>`);
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
