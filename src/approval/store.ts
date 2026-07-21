// src/approval/store.ts
// Durable backing for ApprovalGate state.
//
// Synchronous by contract (better-sqlite3): the gate's getStatus()/reject()
// are sync, so an async store would change their signatures.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { STATE_DIR } from "../config.js";
import type { ApprovalStore, PendingSend, SendStatus } from "./types.js";

export function approvalDbPath(): string {
  return path.join(STATE_DIR, "approvals.db");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pending_sends (
    request_id      TEXT PRIMARY KEY,
    artifact        TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    proposer        TEXT NOT NULL,
    status          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    sent_message_id TEXT,
    error           TEXT,
    feedback        TEXT
  );
  CREATE TABLE IF NOT EXISTS submit_times (
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submit_times_ts ON submit_times(ts);
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

interface SendRow {
  request_id: string;
  artifact: string;
  content_hash: string;
  proposer: string;
  status: string;
  created_at: number;
  expires_at: number;
  sent_message_id: string | null;
  error: string | null;
  feedback: string | null;
}

/** SQLite NULL reads back as null; PendingSend uses optional/undefined. */
function undef<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

export function openApprovalStore(dbPath: string): ApprovalStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const upsertStmt = db.prepare(`
    INSERT INTO pending_sends
      (request_id, artifact, content_hash, proposer, status,
       created_at, expires_at, sent_message_id, error, feedback)
    VALUES
      (@request_id, @artifact, @content_hash, @proposer, @status,
       @created_at, @expires_at, @sent_message_id, @error, @feedback)
    ON CONFLICT(request_id) DO UPDATE SET
      status          = excluded.status,
      sent_message_id = excluded.sent_message_id,
      error           = excluded.error,
      feedback        = excluded.feedback
  `);
  const allStmt = db.prepare(`SELECT * FROM pending_sends`);
  const submitInsert = db.prepare(`INSERT INTO submit_times (ts) VALUES (?)`);
  const submitSelect = db.prepare(
    `SELECT ts FROM submit_times WHERE ts >= ? ORDER BY ts`,
  );
  const submitPrune = db.prepare(`DELETE FROM submit_times WHERE ts < ?`);
  const metaGet = db.prepare(`SELECT value FROM meta WHERE key = ?`);
  const metaSet = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  /**
   * Builds the PendingSend, adding each optional field only when it has a
   * value. SQLite reads an absent column back as `null`; if we assigned
   * `sent_message_id: undefined` etc. via an object literal, the key would
   * still exist (with value `undefined`), which is NOT the same shape as a
   * PendingSend that never set that key — deepEqual against a freshly built
   * PendingSend (which omits unset optional keys) would then fail. Omitting
   * the key entirely keeps the round-trip shape identical.
   */
  function rowToPendingSend(r: SendRow): PendingSend {
    const req: PendingSend = {
      request_id: r.request_id,
      artifact: JSON.parse(r.artifact),
      content_hash: r.content_hash,
      proposer: r.proposer,
      status: r.status as SendStatus,
      created_at: r.created_at,
      expires_at: r.expires_at,
    };
    const sentMessageId = undef(r.sent_message_id);
    if (sentMessageId !== undefined) req.sent_message_id = sentMessageId;
    const error = undef(r.error);
    if (error !== undefined) req.error = error;
    const feedback = undef(r.feedback);
    if (feedback !== undefined) req.feedback = feedback;
    return req;
  }

  return {
    loadAll(): PendingSend[] {
      return (allStmt.all() as SendRow[]).map(rowToPendingSend);
    },
    upsert(req: PendingSend): void {
      upsertStmt.run({
        request_id: req.request_id,
        artifact: JSON.stringify(req.artifact),
        content_hash: req.content_hash,
        proposer: req.proposer,
        status: req.status,
        created_at: req.created_at,
        expires_at: req.expires_at,
        sent_message_id: req.sent_message_id ?? null,
        error: req.error ?? null,
        feedback: req.feedback ?? null,
      });
    },
    loadSubmitTimes(sinceMs: number): number[] {
      return (submitSelect.all(sinceMs) as Array<{ ts: number }>).map(
        (r) => r.ts,
      );
    },
    recordSubmitTime(ts: number): void {
      submitInsert.run(ts);
      // The rate limiter only ever looks back one hour; keep a day of slack.
      submitPrune.run(ts - 86_400_000);
    },
    getLastWatchdogExit(): number | null {
      const row = metaGet.get("last_watchdog_exit") as
        | { value: string }
        | undefined;
      return row ? Number(row.value) : null;
    },
    recordWatchdogExit(ts: number): void {
      metaSet.run("last_watchdog_exit", String(ts));
    },
  };
}
