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
