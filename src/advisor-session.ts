// In-memory session store for the advisor chat.
//
// Nothing persists server-side. Each session owns two directories:
//
//   workDir        - the agent's working directory; holds uploaded files
//   piSessionRoot  - JsonlSessionRepo's sessionsRoot for this session
//
// piSessionRoot is per session because Pi WRITES there: JsonlSessionRepo
// persists the conversation as JSONL. A shared root would quietly put
// conversation content - possibly including student information - on disk,
// making "nothing persists" false. Both directories are removed together on
// clear or expiry.
//
// The Codex SDK had the same hazard through CODEX_HOME. A runner that
// remembers is a runner that writes somewhere; the fix is the same either way.

import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ADVISOR_SESSION_TTL_MS } from "./config.js";
import { log } from "./log.js";
import type { CheckedSchedule } from "./advisor-schedule-verify.js";

export interface TurnRecord {
  role: "advisor" | "agent";
  text: string;
  at: number;
}

export interface AdvisorSession {
  id: string;
  /** Always "shared" until Phase 2 wires per-advisor identity. */
  advisorId: string;
  workDir: string;
  piSessionRoot: string;
  history: TurnRecord[];
  /**
   * The most recent schedule the agent proposed through propose_schedule, if
   * any. It lives on the session rather than in a module-level map so it is
   * disposed with everything else on clear or expiry — a proposed schedule
   * describes a specific student's term and must not outlive the session that
   * produced it.
   */
  lastSchedule?: CheckedSchedule;
  lastTouched: number;
}

const sessions = new Map<string, AdvisorSession>();

export function createSession(advisorId: string): AdvisorSession {
  const id = crypto.randomBytes(24).toString("base64url");
  const session: AdvisorSession = {
    id,
    advisorId,
    workDir: mkdtempSync(path.join(tmpdir(), "advisor-work-")),
    piSessionRoot: mkdtempSync(path.join(tmpdir(), "advisor-pi-")),
    history: [],
    lastTouched: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string | undefined): AdvisorSession | undefined {
  if (!id) return undefined;
  const s = sessions.get(id);
  if (s) s.lastTouched = Date.now();
  return s;
}

function disposeDirs(s: AdvisorSession): void {
  for (const dir of [s.workDir, s.piSessionRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Loud, because a directory surviving disposal means transcript content
      // stayed on disk after the advisor asked for it to be gone.
      log.warn("advisor session dir not removed", { dir, err: String(err) });
    }
  }
}

export function clearSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  disposeDirs(s);
}

export function sweepExpired(now = Date.now()): number {
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - s.lastTouched > ADVISOR_SESSION_TTL_MS) {
      sessions.delete(id);
      disposeDirs(s);
      removed++;
    }
  }
  return removed;
}

export function sessionCount(): number {
  return sessions.size;
}

/**
 * Remove every live session's directories. Called on SIGTERM/SIGINT.
 *
 * Without this, a restart stranded each live session's workDir and
 * piSessionRoot in os.tmpdir() with nothing left to reap them — the sweeper
 * lives in the process that just died. The plist sets KeepAlive=true, so
 * restarts are routine, and those directories hold JSONL transcripts that can
 * contain student information. "Nothing persists" has to survive a restart to
 * mean anything.
 *
 * Synchronous on purpose: it runs from a signal handler, and an async unlink
 * loses the race against process exit.
 */
export function disposeAllSessions(): number {
  const n = sessions.size;
  for (const [id, s] of sessions) {
    sessions.delete(id);
    disposeDirs(s);
  }
  return n;
}

/** Test seam: drop all sessions and their directories. */
export function resetSessionsForTest(): void {
  for (const id of [...sessions.keys()]) clearSession(id);
}
