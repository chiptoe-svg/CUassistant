import path from "path";
import fs from "fs";

import type {
  OutlookMailProvider,
  ResidualClassifier,
  ScanMode,
  TaskProvider,
} from "./types.js";

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

function outlookMailProvider(raw: string | undefined): OutlookMailProvider {
  const value = raw || "graph";
  if (value === "graph" || value === "codex") return value;
  throw new Error(
    `Invalid OUTLOOK_MAIL_PROVIDER=${value}. Use graph or codex.`,
  );
}

function taskProvider(raw: string | undefined): TaskProvider {
  const value = raw || "graph";
  if (value === "graph" || value === "graph-cli") return value;
  throw new Error(`Invalid TASK_PROVIDER=${value}. Use graph or graph-cli.`);
}

export const OUTLOOK_MAIL_PROVIDER = outlookMailProvider(
  process.env.OUTLOOK_MAIL_PROVIDER,
);
export const TASK_PROVIDER = taskProvider(process.env.TASK_PROVIDER);

export const DRY_RUN = process.env.DRY_RUN === "1";

export const CONFIG_DIR = path.resolve(
  process.env.CONFIG_DIR || path.join(process.cwd(), "config"),
);
export const STATE_DIR = path.resolve(
  process.env.STATE_DIR || path.join(process.cwd(), "state"),
);

export const TIMEZONE = process.env.TZ || "America/New_York";

export const CODEX_BIN = process.env.CODEX_BIN || "codex";
export const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4-mini";
export const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 90_000);
export const OUTLOOK_CODEX_TIMEOUT_MS = Number(
  process.env.OUTLOOK_CODEX_TIMEOUT_MS || CODEX_TIMEOUT_MS,
);
export const OUTLOOK_CODEX_MAX_RESULTS = Number(
  process.env.OUTLOOK_CODEX_MAX_RESULTS || 50,
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

export const GRAPH_CLI_CLIENT_ID =
  process.env.GRAPH_CLI_CLIENT_ID || "14d82eec-204b-4c2f-b7e8-296a70dab67e";
export const GRAPH_CLI_TENANT_ID = process.env.GRAPH_CLI_TENANT_ID || "common";
export const GRAPH_CLI_REFRESH_TOKEN =
  process.env.GRAPH_CLI_REFRESH_TOKEN || "";

export const GWS_BIN = process.env.GWS_BIN || "";
