// CUassistant MCP server — stdio transport, host-side execution.
//
// SCOPE
// =====
// Tool surface mirrors CUagent's MS365 MCP server (which used the
// @softeria/ms-365-mcp-server upstream package via MSAL + Graph API direct
// calls and a custom Azure AD app). Tools, names, and shapes are kept
// identical where possible for NanoClaw v2 client compatibility. The backend
// is different — Codex CLI's Outlook connector for mail/calendar reads, and
// the Graph CLI first-party client (Tasks.ReadWrite refresh token already in
// CUassistant's .env) for task r/w. Mail and calendar writes are present as
// stubs and activate when IT grants the corresponding Graph permissions.
//
// CREDENTIALS
// ===========
// The Graph CLI refresh token (GRAPH_CLI_REFRESH_TOKEN in .env) is host-only.
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
// actually invokes a tool.

import "./mcp-tools/index.js";
import { startMcpServer } from "./mcp-tools/server.js";

function log(msg: string): void {
  process.stderr.write(`[cuassistant-mcp] ${msg}\n`);
}

startMcpServer().catch((err) => {
  log(`server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
