import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_CONSECUTIVE_POLL_ERRORS,
  RECEIVER_DOWN_WARN_MS,
  WATCHDOG_COOLDOWN_MS,
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
