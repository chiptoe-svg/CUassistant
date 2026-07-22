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
/** Egress provider name; must be authorized in policy/action-policy.yaml. */
export const ADVISOR_PROVIDER = process.env.ADVISOR_PROVIDER || "local_vllm";
/** Tried in order: on-prem first, paid fallback (mirrors ask_gc). */
export const ADVISOR_PROVIDER_CHAIN = (
  process.env.ADVISOR_PROVIDER_CHAIN || "spark,openai"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "qwen3.6-35b-a3b";
export const ADVISOR_BASE_URL =
  process.env.ADVISOR_BASE_URL || "http://gcspark.clemson.edu:8080/v1";
/** Max tool-call rounds per turn. Unattended service: must be bounded. */
export const ADVISOR_MAX_ROUNDS = Number(process.env.ADVISOR_MAX_ROUNDS || 8);
export const ADVISOR_MCP_PUBLIC_URL =
  process.env.ADVISOR_MCP_PUBLIC_URL || "http://127.0.0.1:8766/";
export const ADVISOR_MCP_CATALOG_URL =
  process.env.ADVISOR_MCP_CATALOG_URL || "http://127.0.0.1:8767/";
export const ADVISOR_MCP_WIKI_URL =
  process.env.ADVISOR_MCP_WIKI_URL || "http://127.0.0.1:3000/api/mcp";
/** Bearer token for the curriculum wiki MCP, which requires auth (401 without). */
export const ADVISOR_MCP_WIKI_TOKEN = process.env.ADVISOR_MCP_WIKI_TOKEN || "";
