// CUassistant MCP server — stdio transport, host-side execution.
//
// SCOPE
// =====
// Tool surface mirrors CUagent's MS365 MCP server (which used the
// @softeria/ms-365-mcp-server upstream package via MSAL + Graph API direct
// calls and a custom Azure AD app). Tools, names, and shapes are kept
// identical where possible for NanoClaw v2 client compatibility. The backend
// is the GCassistant Azure AD app (Mail.ReadWrite + Tasks.ReadWrite +
// Calendars.ReadWrite) reached through the shared MCP Graph helper
// (getMs365AccessToken). Mail/calendar reads, To Do read/write, and the
// approval=none mail/calendar writes (move, mark-read, draft, create/update
// event) are active; destructive or affects-others actions (mail/event delete,
// RSVP, task delete) stay policy-blocked (approval=human_required) until policy
// is widened.
//
// CREDENTIALS
// ===========
// The GCassistant refresh token (MS365_REFRESH_TOKEN in .env) is host-only.
// It is read from the host process environment and never crosses any
// boundary. NanoClaw v2 containers connect to this MCP server via stdio
// transport; they request operations through tools, they never hold or
// receive credentials directly. Do not mount the host's .env or
// ~/.cuassistant token directories into any NanoClaw container under any
// circumstances.
//
// FUTURE STEPS (deliberately not implemented now)
// ===============================================
// - SSO / per-caller authentication on the MCP server. The current model
//   trusts the local stdio transport: the agent runtime that spawns this
//   server inherits the host's identity. Adding SSO is a separate review
//   step (token-on-tool-call, audience binding, refresh strategy).
// - Per-tool rate limiting. Today the host-process gate is the only
//   throttle. Adding rate limits — per tool, per minute, per origin —
//   is a separate review step.
//
// STARTUP HAS NO SIDE EFFECTS
// ===========================
// This entry point only loads tool modules (which call registerTools) and
// connects the stdio transport. It does not trigger a scan, refresh tokens,
// or read any state file. The first state read happens when a client
// actually invokes a tool. When the Telegram approval gate is configured
// (TELEGRAM_BOT_TOKEN and TELEGRAM_APPROVER_USER_ID set), startup also
// starts a background Telegram long-poll receiver — the only startup side
// effect, and only when those env vars are set.

import { randomUUID } from "crypto";
import "./mcp-tools/index.js";
import "./mcp-tools/index-public.js";
import "./mcp-tools/index-catalog.js";
import { startMcpServer } from "./mcp-tools/server.js";
import { setSkillExposure } from "./mcp-tools/skills.js";
import { recordSeen } from "./mcp-tools/consumers.js";
import { ApprovalGate } from "./approval/gate.js";
import { makeSender } from "./approval/sender.js";
import { gwsSend } from "./approval/gws-sender.js";
import { ms365Send } from "./approval/ms365-sender.js";
import { startTelegramApproval } from "./notifiers/telegram-approval.js";
import type { ApprovalChannel } from "./approval/types.js";
import { __setGate } from "./mcp-tools/mail-send.js";
import { makeGateAuditSink } from "./approval/audit-sink.js";
import { approvalDbPath, openApprovalStore } from "./approval/store.js";
import {
  SEND_APPROVAL_TTL_MS,
  SEND_APPROVAL_MAX_OUTSTANDING,
  SEND_APPROVAL_RATE_PER_HOUR,
  SEND_INTERNAL_DOMAINS,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_APPROVER_USER_ID,
  MCP_TRANSPORT,
  MCP_HTTP_HOST,
  MCP_HTTP_PORT,
  MCP_AUTH_TOKEN,
  MCP_AUTH_TOKEN_PROVIDER,
} from "./config.js";

function log(msg: string): void {
  process.stderr.write(`[cuassistant-mcp] ${msg}\n`);
}

function initApprovalGate(): void {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_APPROVER_USER_ID) {
    process.stderr.write(
      "[cuassistant-mcp] send-approval disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_APPROVER_USER_ID unset)\n",
    );
    return;
  }
  const sender = makeSender({ gmail: gwsSend, ms365: ms365Send });
  const noop: ApprovalChannel = { async post() {} };
  const dbPath = approvalDbPath();
  let approvalStore: ReturnType<typeof openApprovalStore> | undefined;
  try {
    approvalStore = openApprovalStore(dbPath);
  } catch (err) {
    process.stderr.write(
      `[cuassistant-mcp] FAILED to open approval store at "${dbPath}": ${String(err)}. ` +
        "Continuing WITHOUT persistence — approvals will not survive a restart, " +
        "and the watchdog cooldown will not persist.\n",
    );
    approvalStore = undefined;
  }
  const gate = new ApprovalGate(
    {
      sender,
      channel: noop,
      clock: { now: () => Date.now() },
      idGen: { generate: () => randomUUID() },
      audit: makeGateAuditSink(),
      store: approvalStore,
    },
    {
      ttlMs: SEND_APPROVAL_TTL_MS,
      maxOutstanding: SEND_APPROVAL_MAX_OUTSTANDING,
      rateLimitPerHour: SEND_APPROVAL_RATE_PER_HOUR,
      internalDomains: SEND_INTERNAL_DOMAINS,
      authorizedUserId: TELEGRAM_APPROVER_USER_ID,
    },
  );
  const channel = startTelegramApproval(
    {
      botToken: TELEGRAM_BOT_TOKEN,
      authorizedUserId: TELEGRAM_APPROVER_USER_ID,
      internalDomains: SEND_INTERNAL_DOMAINS,
    },
    gate,
    { store: approvalStore },
  );
  gate.setChannel(channel);
  __setGate(gate);
}

// Throttle last-seen writes to at most once per hour per consumer, so an active
// agent doesn't rewrite the registry on every call.
const lastTouchMs = new Map<string, number>();
function touchConsumer(id: string): void {
  if (id === "env-token") return;
  const now = Date.now();
  if (now - (lastTouchMs.get(id) ?? 0) < 3_600_000) return;
  lastTouchMs.set(id, now);
  recordSeen(id, new Date(now).toISOString());
}

// This server is loopback-only and per-agent credentialed, so it serves every
// skill — including the private-path ones (`triage`, `add-cuassistant`) that
// the public server's allowlist withholds. The skill tools default to the
// public allowlist (see mcp-tools/skills.ts), so the full set is an explicit
// opt-in here rather than something a new server inherits by accident.
setSkillExposure("all");

initApprovalGate();
startMcpServer({
  name: "cuassistant-credentialed",
  transport: MCP_TRANSPORT,
  httpHost: MCP_HTTP_HOST,
  httpPort: MCP_HTTP_PORT,
  auth: {
    kind: "registry",
    envToken: MCP_AUTH_TOKEN,
    envTokenProvider: MCP_AUTH_TOKEN_PROVIDER,
    onSeen: touchConsumer,
  },
}).catch((err) => {
  log(`server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
