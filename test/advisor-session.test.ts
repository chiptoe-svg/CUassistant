import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";

import {
  createSession,
  getSession,
  clearSession,
  sweepExpired,
  sessionCount,
  resetSessionsForTest,
  disposeAllSessions,
} from "../src/advisor-session.ts";

test("a session gets its own working directory and Pi session root", () => {
  resetSessionsForTest();
  const s = createSession("shared");
  assert.ok(existsSync(s.workDir), "workDir must exist");
  assert.ok(existsSync(s.piSessionRoot), "piSessionRoot must exist");
  assert.notEqual(s.workDir, s.piSessionRoot, "must be separate directories");
  clearSession(s.id);
});

// Isolation matters more than usual: the shared password makes two advisors
// indistinguishable at the auth layer, so the cookie is the ONLY thing keeping
// their conversations apart.
test("two sessions never resolve to each other", () => {
  resetSessionsForTest();
  const a = createSession("shared");
  const b = createSession("shared");
  assert.notEqual(a.id, b.id);
  assert.equal(getSession(a.id)?.id, a.id);
  assert.equal(getSession(b.id)?.id, b.id);
  assert.notEqual(a.workDir, b.workDir);
  assert.notEqual(a.piSessionRoot, b.piSessionRoot);
});

test("getSession returns undefined for unknown or missing ids", () => {
  resetSessionsForTest();
  assert.equal(getSession(undefined), undefined);
  assert.equal(getSession("nope"), undefined);
});

// Clear is a data-disposal control, not a convenience: Pi's JsonlSessionRepo
// writes transcripts under piSessionRoot, so both directories must be gone.
test("clear removes the entry and BOTH directories from disk", () => {
  resetSessionsForTest();
  const s = createSession("shared");
  const { workDir, piSessionRoot } = s;
  clearSession(s.id);
  assert.equal(getSession(s.id), undefined);
  assert.equal(existsSync(workDir), false, "workDir must be deleted");
  assert.equal(existsSync(piSessionRoot), false, "piSessionRoot must be deleted");
});

test("sweep expires idle sessions and leaves active ones", () => {
  resetSessionsForTest();
  const old = createSession("shared");
  const fresh = createSession("shared");
  const now = Date.now();
  old.lastTouched = now - 3 * 60 * 60 * 1000; // 3h idle, TTL is 2h
  const removed = sweepExpired(now);
  assert.equal(removed, 1);
  assert.equal(getSession(old.id), undefined);
  assert.equal(getSession(fresh.id)?.id, fresh.id);
  assert.equal(existsSync(old.workDir), false);
  assert.equal(existsSync(old.piSessionRoot), false);
  assert.equal(sessionCount(), 1);
});

// --- disposal on shutdown ---------------------------------------------------
//
// SIGTERM/SIGINT used to close only the MCP tool bridge, leaving every live
// session's workDir and piSessionRoot in os.tmpdir(). The plist sets
// KeepAlive=true, so restarts are routine, and the sweeper that would have
// reaped them dies with the process. Those directories hold JSONL transcripts
// that can contain student information — "nothing persists" has to survive a
// restart to mean anything.

test("disposeAllSessions removes every live session's directories", () => {
  resetSessionsForTest();
  const a = createSession("shared");
  const b = createSession("shared");
  const dirs = [a.workDir, a.piSessionRoot, b.workDir, b.piSessionRoot];
  assert.ok(dirs.every((d) => existsSync(d)), "sanity: all four dirs exist");

  const removed = disposeAllSessions();

  assert.equal(removed, 2, "both sessions must be reported disposed");
  assert.equal(sessionCount(), 0, "the store must be empty");
  for (const d of dirs) {
    assert.equal(existsSync(d), false, `${d} survived shutdown disposal`);
  }
});

test("disposeAllSessions is safe with no live sessions", () => {
  resetSessionsForTest();
  assert.equal(disposeAllSessions(), 0);
});
