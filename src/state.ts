// All persistent state IO: progress.yaml, decisions.jsonl,
// usage.jsonl, pending_residuals.jsonl, and the scan lock.

import fs from "fs";
import path from "path";

import YAML from "yaml";

import { STATE_DIR } from "./config.js";
import { log } from "./log.js";
import type { Account, PendingResidual, Progress, ScanMode } from "./types.js";

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {
    /* best effort */
  }
}

function lockDownFile(p: string): void {
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
}

export function emailKey(
  account: Account | string | undefined,
  id: string,
): string {
  return account ? `${account}:${id}` : id;
}

// --- progress.yaml ---

const PROGRESS_PATH = (): string => path.join(STATE_DIR, "progress.yaml");

export function loadProgress(): Progress {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH(), "utf-8");
    return (YAML.parse(raw) ?? {}) as Progress;
  } catch {
    return {};
  }
}

export function writeProgress(prog: Progress): void {
  ensureStateDir();
  fs.writeFileSync(PROGRESS_PATH(), YAML.stringify(prog, { lineWidth: 0 }));
  lockDownFile(PROGRESS_PATH());
}

// --- decisions.jsonl ---

const DECISIONS_PATH = (): string => path.join(STATE_DIR, "decisions.jsonl");

export function appendDecision(entry: Record<string, unknown>): void {
  ensureStateDir();
  fs.appendFileSync(
    DECISIONS_PATH(),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    { mode: 0o600 },
  );
  lockDownFile(DECISIONS_PATH());
}

export function loadResolvedEmailIds(daysBack = 30): Set<string> {
  const out = new Set<string>();
  const p = DECISIONS_PATH();
  if (!fs.existsSync(p)) return out;
  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        ts?: string;
        email_id?: string;
        account?: Account;
        pass?: string;
        decision?: string;
      };
      if (!entry.email_id) continue;
      if (entry.decision && entry.decision.endsWith("-intent")) continue;
      if (entry.pass === "compare") continue;
      if (entry.ts) {
        const t = Date.parse(entry.ts);
        if (!Number.isNaN(t) && t < cutoffMs) continue;
      }
      out.add(emailKey(entry.account, entry.email_id));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// --- usage.jsonl ---

const USAGE_PATH = (): string => path.join(STATE_DIR, "usage.jsonl");

export interface UsageRecord {
  scan_run_id: string;
  email_ids: string[]; // multiple ids when a single LLM call batches several
  mode: ScanMode;
  caller: "codex" | "openai";
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  latency_ms: number;
  cost_usd: number;
}

export function appendUsage(rec: UsageRecord): void {
  ensureStateDir();
  fs.appendFileSync(
    USAGE_PATH(),
    JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n",
    { mode: 0o600 },
  );
  lockDownFile(USAGE_PATH());
}

export function readUsageRecords(
  sinceIso?: string,
): Array<UsageRecord & { ts: string }> {
  const p = USAGE_PATH();
  if (!fs.existsSync(p)) return [];
  const cutoffMs = sinceIso ? Date.parse(sinceIso) : 0;
  const out: Array<UsageRecord & { ts: string }> = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as UsageRecord & { ts: string };
      if (cutoffMs && Date.parse(r.ts) < cutoffMs) continue;
      out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

// --- pending_residuals.jsonl ---

const PENDING_PATH = (): string =>
  path.join(STATE_DIR, "pending_residuals.jsonl");

export function loadPendingResiduals(): PendingResidual[] {
  const p = PENDING_PATH();
  if (!fs.existsSync(p)) return [];
  const out: PendingResidual[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const raw = JSON.parse(line) as Partial<PendingResidual> & {
        scan_run_id: string;
        email_id: string;
        account: "gmail" | "outlook";
        from: string;
        subject: string;
        handoff_ts: string;
      };
      out.push({
        scan_run_id: raw.scan_run_id,
        email_id: raw.email_id,
        account: raw.account,
        from: raw.from,
        subject: raw.subject,
        handoff_ts: raw.handoff_ts,
        first_handoff_ts: raw.first_handoff_ts ?? raw.handoff_ts,
        attempt_count: raw.attempt_count ?? 1,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function writePendingResiduals(entries: PendingResidual[]): void {
  ensureStateDir();
  const body =
    entries.map((e) => JSON.stringify(e)).join("\n") +
    (entries.length > 0 ? "\n" : "");
  fs.writeFileSync(PENDING_PATH(), body);
  lockDownFile(PENDING_PATH());
}

// --- scan lock ---
//
// Cron and a manual run can race on state files. The lock serializes them.
// Stale-lock recovery handles a scan that crashed without releasing.

const LOCK_PATH = (): string => path.join(STATE_DIR, "scan_in_progress.lock");
const LOCK_STALE_MS = 10 * 60_000;

export function acquireScanLock(): boolean {
  ensureStateDir();
  const p = LOCK_PATH();
  try {
    fs.writeFileSync(p, String(process.pid), { flag: "wx" });
    lockDownFile(p);
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(p).mtimeMs;
      if (age > LOCK_STALE_MS) {
        log.warn("stale scan lock — recovering", { ageMs: age });
        fs.unlinkSync(p);
        fs.writeFileSync(p, String(process.pid), { flag: "wx" });
        lockDownFile(p);
        return true;
      }
    } catch {
      /* race with another runner — treat as held */
    }
    return false;
  }
}

export function releaseScanLock(): void {
  try {
    fs.unlinkSync(LOCK_PATH());
  } catch {
    /* already gone */
  }
}
