import path from "path";
import fs from "fs";

import type { ResidualClassifier, ScanMode } from "./types.js";

function loadDotEnv(): void {
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    if (m[0].trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    if (key in process.env) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
}
loadDotEnv();

function scanMode(raw: string | undefined): ScanMode {
  const value = raw || "agent";
  if (value === "agent" || value === "hybrid" || value === "compare") {
    return value;
  }
  throw new Error(`Invalid MODE=${value}. Use agent, hybrid, or compare.`);
}

export const MODE = scanMode(process.env.MODE);

function residualClassifier(raw: string | undefined): ResidualClassifier {
  const value = raw || "codex";
  if (value === "codex" || value === "openai") return value;
  throw new Error(`Invalid RESIDUAL_CLASSIFIER=${value}. Use codex or openai.`);
}

export const RESIDUAL_CLASSIFIER = residualClassifier(
  process.env.RESIDUAL_CLASSIFIER,
);

export const DRY_RUN = process.env.DRY_RUN === "1";
export const BACKFILL_FROM = process.env.BACKFILL_FROM || "";
export const BACKFILL_TO = process.env.BACKFILL_TO || "";
export const BACKFILL_ACTIVE = Boolean(BACKFILL_FROM || BACKFILL_TO);
export const BACKFILL_ADVANCE_PROGRESS =
  process.env.BACKFILL_ADVANCE_PROGRESS === "1";

export const CONFIG_DIR = path.resolve(
  process.env.CONFIG_DIR || path.join(process.cwd(), "config"),
);
export const STATE_DIR = path.resolve(
  process.env.STATE_DIR || path.join(process.cwd(), "state"),
);

// Opt-in: mark the audit log (state/decisions.jsonl) OS-append-only via chflags
// so casual/accidental rewrites fail. Off by default to avoid surprising
// `rm`/rotate friction. The M365 unified audit log is the authoritative trail.
export const AUDIT_APPEND_ONLY = process.env.AUDIT_APPEND_ONLY === "1";

export const TIMEZONE = process.env.TZ || "America/New_York";

export const CODEX_BIN = process.env.CODEX_BIN || "codex";
export const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4-mini";
export const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 90_000);
export const CLASSIFIER_BATCH_SIZE = Math.max(
  1,
  Number(process.env.CLASSIFIER_BATCH_SIZE || 10),
);

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
export const OPENAI_CLASSIFIER_MODEL =
  process.env.OPENAI_CLASSIFIER_MODEL || "gpt-5.4-mini";
export const OPENAI_CLASSIFIER_TIMEOUT_MS = Number(
  process.env.OPENAI_CLASSIFIER_TIMEOUT_MS || 20_000,
);

export const MS365_CLIENT_ID = process.env.MS365_CLIENT_ID || "";
export const MS365_TENANT_ID = process.env.MS365_TENANT_ID || "common";
export const MS365_REFRESH_TOKEN = process.env.MS365_REFRESH_TOKEN || "";

export const GWS_BIN = process.env.GWS_BIN || "";

// --- Send-mail approval gate ---
export const SEND_APPROVAL_TTL_MS = Number(
  process.env.SEND_APPROVAL_TTL_MS || 3_600_000,
);
export const SEND_APPROVAL_MAX_OUTSTANDING = Number(
  process.env.SEND_APPROVAL_MAX_OUTSTANDING || 5,
);
export const SEND_APPROVAL_RATE_PER_HOUR = Number(
  process.env.SEND_APPROVAL_RATE_PER_HOUR || 10,
);
export const SEND_INTERNAL_DOMAINS = (
  process.env.SEND_INTERNAL_DOMAINS || "clemson.edu"
)
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_APPROVER_USER_ID =
  process.env.TELEGRAM_APPROVER_USER_ID || "";

// --- MCP server transport (credentialed server) ---
// MCP_TRANSPORT: "stdio" (default, local/dev) or "http" (containerized agent).
export const MCP_TRANSPORT = (
  process.env.MCP_TRANSPORT === "http" ? "http" : "stdio"
) as "stdio" | "http";
export const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST || "127.0.0.1";
export const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 8765);
export const MCP_PUBLIC_HTTP_PORT = Number(
  process.env.MCP_PUBLIC_HTTP_PORT || 8766,
);
// When set, the HTTP transport requires `Authorization: Bearer <token>`.
// When unset, the server is loopback-open (interim mode). The value is read
// from the environment, which OneCLI can populate from its vault at spawn.
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
export const MCP_AUTH_TOKEN_PROVIDER =
  process.env.MCP_AUTH_TOKEN_PROVIDER || "";

// --- GC catalog bridge (gc_advisor project, same machine) ---
// The catalog MCP server shells out to gc_advisor's query.py (JSON out),
// keeping gc_advisor's CatalogAccess the single source of truth.
export const GC_ADVISOR_PYTHON =
  process.env.GC_ADVISOR_PYTHON ||
  "/Users/admin/projects/gc_advisor/.venv/bin/python";
export const GC_ADVISOR_QUERY =
  process.env.GC_ADVISOR_QUERY ||
  "/Users/admin/projects/gc_advisor/scripts/query.py";
export const GC_ADVISOR_AUDIT =
  process.env.GC_ADVISOR_AUDIT ||
  "/Users/admin/projects/gc_advisor/scripts/audit.py";
export const GC_ADVISOR_DB =
  process.env.GC_ADVISOR_DB ||
  "/Users/admin/projects/gc_advisor/db/gc_advisor.db";

// Public GC catalog MCP server port (loopback HTTP transport).
export const MCP_CATALOG_HTTP_PORT = Number(
  process.env.MCP_CATALOG_HTTP_PORT || 8767,
);

// --- Token portal (Google OAuth2 → bearer token issuance) ---
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const TOKEN_PORTAL_PORT = Number(
  process.env.TOKEN_PORTAL_PORT || 8769,
);
// Base URL must be HTTPS for production. Defaults to localhost for dev.
export const TOKEN_PORTAL_BASE_URL =
  process.env.TOKEN_PORTAL_BASE_URL ||
  `http://localhost:${process.env.TOKEN_PORTAL_PORT || 8769}`;

// --- Advisor chat service (port 8770) ---
export const ADVISOR_PORT = Number(process.env.ADVISOR_PORT || 8770);
export const ADVISOR_PASSWORD = process.env.ADVISOR_PASSWORD || "";
export const ADVISOR_SESSION_TTL_MS = Number(
  process.env.ADVISOR_SESSION_TTL_MS || 2 * 60 * 60 * 1000,
);
/**
 * Tried in order: on-prem first, paid fallback (mirrors ask_gc). Every entry
 * reached must map to an authorized destination in policy/action-policy.yaml —
 * see CHAIN_EGRESS_PROVIDER in advisor-agent.ts. This list is what the egress
 * gate checks; there is no separate provider setting.
 */
export const ADVISOR_PROVIDER_CHAIN = (
  process.env.ADVISOR_PROVIDER_CHAIN || "spark,openai"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "qwen3.6-35b-a3b";
export const ADVISOR_BASE_URL =
  process.env.ADVISOR_BASE_URL || "http://gcspark.clemson.edu:8080/v1";
/**
 * Read a positive-number env var, falling back on anything that is not one.
 *
 * `Number(env || d)` is NOT safe here: a non-numeric value yields NaN, and
 * EVERY comparison against NaN is false. A cap of NaN is a cap that never
 * fires — an unbounded loop against a provider, on a typo in a unit file.
 */
function positiveNumberEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max tool-call rounds per turn. Unattended service: must be bounded. */
export const ADVISOR_MAX_ROUNDS = positiveNumberEnv(
  process.env.ADVISOR_MAX_ROUNDS,
  8,
);
/**
 * Wall-clock ceiling for one turn. The round cap bounds how many times the
 * model may be asked; this bounds how long a single turn may take regardless.
 * Without it a stalled provider holds a session's directories and the request
 * open indefinitely — only a client disconnect ends the turn.
 */
export const ADVISOR_TURN_TIMEOUT_MS = positiveNumberEnv(
  process.env.ADVISOR_TURN_TIMEOUT_MS,
  10 * 60 * 1000,
);
/**
 * Sampling temperature for the chat-completions target. The endpoint docs for
 * qwen3.6-35b-a3b give 0.6 as the canonical value; 0 was our own invention and
 * is not what this model is tuned for.
 */
export const ADVISOR_TEMPERATURE = (() => {
  const n = Number(process.env.ADVISOR_TEMPERATURE);
  // 0 is a legitimate temperature, so this cannot use positiveNumberEnv.
  return Number.isFinite(n) && n >= 0 ? n : 0.6;
})();
/**
 * Ceiling on the estimated token size of one provider request. The window is
 * 64K; requests are held near 45K so a long answer plus the model's own
 * thinking still fit. Tool results are the unbounded term.
 */
export const ADVISOR_MAX_REQUEST_TOKENS = positiveNumberEnv(
  process.env.ADVISOR_MAX_REQUEST_TOKENS,
  45000,
);
/**
 * Ceiling on the tokens the model may GENERATE in one provider request — the
 * output half of the budget, and a different limit from
 * ADVISOR_MAX_REQUEST_TOKENS above. Both must fit the 64K window together:
 * 45000 in + 8192 out = 53192, leaving headroom rather than racing the wall.
 *
 * This is declared on the model as `maxTokens: 8192` too, but that field never
 * reached the wire. pi-agent-core builds the stream options it passes to pi-ai
 * from an explicit allowlist (harness/agent-harness.js createStreamFn) and
 * `maxTokens` is not in it, so `options.maxTokens` is always undefined; pi-ai
 * emits `max_tokens` only `if (options?.maxTokens)`
 * (providers/openai-completions.js:410). Verified on the wire with a capturing
 * proxy: neither `max_tokens` nor `max_completion_tokens` was present, so
 * generation was bounded only by the server's own default.
 *
 * The advisor therefore injects it into the payload directly, the same way
 * temperature is injected, and this constant is what it injects.
 */
export const ADVISOR_MAX_OUTPUT_TOKENS = positiveNumberEnv(
  process.env.ADVISOR_MAX_OUTPUT_TOKENS,
  8192,
);
export const ADVISOR_MCP_PUBLIC_URL =
  process.env.ADVISOR_MCP_PUBLIC_URL || "http://127.0.0.1:8766/";
export const ADVISOR_MCP_CATALOG_URL =
  process.env.ADVISOR_MCP_CATALOG_URL || "http://127.0.0.1:8767/";
export const ADVISOR_MCP_WIKI_URL =
  process.env.ADVISOR_MCP_WIKI_URL || "http://127.0.0.1:3000/api/mcp";
/** Bearer token for the curriculum wiki MCP, which requires auth (401 without). */
export const ADVISOR_MCP_WIKI_TOKEN = process.env.ADVISOR_MCP_WIKI_TOKEN || "";
