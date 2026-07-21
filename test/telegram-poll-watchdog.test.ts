import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_CONSECUTIVE_POLL_ERRORS,
  RECEIVER_DOWN_WARN_MS,
  WATCHDOG_COOLDOWN_MS,
  maybeWarnReceiverDown,
  nextBackoffMs,
  shouldRestartAfterPollErrors,
  shouldWarnReceiverDown,
} from "../src/notifiers/telegram-approval.ts";

const N = MAX_CONSECUTIVE_POLL_ERRORS;

test("exits when errors hit the threshold, network is healthy, and cooled down", () => {
  assert.equal(shouldRestartAfterPollErrors(N, true, null), true);
  assert.equal(
    shouldRestartAfterPollErrors(N, true, WATCHDOG_COOLDOWN_MS + 1),
    true,
  );
});

test("does NOT exit when the network is unreachable — the churn case", () => {
  // This is the regression the 13-restart outage cluster produced.
  assert.equal(shouldRestartAfterPollErrors(N, false, null), false);
  assert.equal(shouldRestartAfterPollErrors(N * 10, false, null), false);
});

test("does NOT exit twice inside the cooldown window — the rate limit", () => {
  assert.equal(shouldRestartAfterPollErrors(N, true, 60_000), false);
  assert.equal(
    shouldRestartAfterPollErrors(N, true, WATCHDOG_COOLDOWN_MS - 1),
    false,
  );
});

test("does NOT exit below the error threshold", () => {
  assert.equal(shouldRestartAfterPollErrors(N - 1, true, null), false);
  assert.equal(shouldRestartAfterPollErrors(0, true, null), false);
});

test("backoff doubles from the base and saturates at the cap", () => {
  assert.equal(nextBackoffMs(1), BACKOFF_BASE_MS);
  assert.equal(nextBackoffMs(2), BACKOFF_BASE_MS * 2);
  assert.equal(nextBackoffMs(3), BACKOFF_BASE_MS * 4);
  assert.equal(nextBackoffMs(50), BACKOFF_CAP_MS);
  assert.ok(nextBackoffMs(0) >= BACKOFF_BASE_MS);
});

test("receiver-down warning fires when stale and not recently warned", () => {
  assert.equal(
    shouldWarnReceiverDown(RECEIVER_DOWN_WARN_MS + 1, RECEIVER_DOWN_WARN_MS + 1),
    true,
  );
  assert.equal(shouldWarnReceiverDown(1_000, 10 * RECEIVER_DOWN_WARN_MS), false);
  assert.equal(shouldWarnReceiverDown(RECEIVER_DOWN_WARN_MS + 1, 1_000), false);
});

test("maybeWarnReceiverDown fires and advances lastWarn when stale and not recently warned", () => {
  const lastSuccess = 0;
  const now = RECEIVER_DOWN_WARN_MS + 1;
  const lastWarn = 0; // "recent" relative to lastSuccess, but stale relative to now
  const next = maybeWarnReceiverDown(now, lastSuccess, lastWarn);
  assert.equal(next, now, "warn fired, so lastWarn advances to now");
});

test("maybeWarnReceiverDown is a no-op (returns lastWarn unchanged) when gated", () => {
  const lastSuccess = 0;
  // Not stale yet.
  assert.equal(
    maybeWarnReceiverDown(1_000, lastSuccess, 0),
    0,
    "below RECEIVER_DOWN_WARN_MS since lastSuccess — no warn",
  );
  // Stale, but we already warned recently.
  const now = RECEIVER_DOWN_WARN_MS + 1;
  const lastWarn = now - 1_000;
  assert.equal(
    maybeWarnReceiverDown(now, lastSuccess, lastWarn),
    lastWarn,
    "warned recently — gated, lastWarn untouched",
  );
});

test("an HTTP-level failure (never incrementing consecutiveErrors) can never trigger the watchdog", () => {
  // This is the crux of the fix: the HTTP-failure path in pollLoop leaves
  // consecutiveErrors at whatever it was (never increments it), so no
  // matter how "healthy" the network probe reports or how long since the
  // last exit, shouldRestartAfterPollErrors must stay false at 0 errors.
  assert.equal(shouldRestartAfterPollErrors(0, true, null), false);
  assert.equal(
    shouldRestartAfterPollErrors(0, true, WATCHDOG_COOLDOWN_MS + 1),
    false,
  );
});

test("HTTP-failure staleness is expressible through shouldWarnReceiverDown: repeated 401s eventually trip RECEIVER DOWN even though consecutiveErrors never moves", () => {
  // Simulates pollLoop's HTTP-failure branch: lastSuccess is frozen (never
  // updated on !r.ok) while time passes across repeated auth failures.
  const lastSuccess = 0;
  let lastWarn = 0;

  // Shortly after the last real success — not stale yet.
  assert.equal(shouldWarnReceiverDown(60_000 - lastSuccess, 60_000 - lastWarn), false);

  // Enough silent HTTP failures accumulate that we cross the staleness
  // threshold: the warning must be able to fire even though this path
  // never touches consecutiveErrors.
  const now = RECEIVER_DOWN_WARN_MS + 1;
  assert.equal(shouldWarnReceiverDown(now - lastSuccess, now - lastWarn), true);
  lastWarn = now;

  // Immediately after warning, a subsequent 401 must not re-warn.
  const soonAfter = now + 1_000;
  assert.equal(
    shouldWarnReceiverDown(soonAfter - lastSuccess, soonAfter - lastWarn),
    false,
  );
});

test("the watchdog reads its cooldown from the store, surviving restarts", () => {
  // The last-exit timestamp lives in ApprovalStore, so the rate limit governs
  // the very restart it triggers. Simulated here: exit recorded 10 minutes ago.
  const now = 10_000_000;
  const lastExit = now - 600_000;
  assert.equal(
    shouldRestartAfterPollErrors(N, true, now - lastExit),
    false,
    "10 minutes since the last exit is inside the 1h cooldown",
  );
  const older = now - (WATCHDOG_COOLDOWN_MS + 1);
  assert.equal(shouldRestartAfterPollErrors(N, true, now - older), true);
});
