import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONSECUTIVE_POLL_ERRORS,
  shouldRestartAfterPollErrors,
} from "../src/notifiers/telegram-approval.ts";

test("shouldRestartAfterPollErrors triggers at or above the threshold", () => {
  assert.equal(
    shouldRestartAfterPollErrors(
      MAX_CONSECUTIVE_POLL_ERRORS - 1,
      MAX_CONSECUTIVE_POLL_ERRORS,
    ),
    false,
  );
  assert.equal(
    shouldRestartAfterPollErrors(
      MAX_CONSECUTIVE_POLL_ERRORS,
      MAX_CONSECUTIVE_POLL_ERRORS,
    ),
    true,
  );
  assert.equal(
    shouldRestartAfterPollErrors(
      MAX_CONSECUTIVE_POLL_ERRORS + 5,
      MAX_CONSECUTIVE_POLL_ERRORS,
    ),
    true,
  );
});

test("a single transient error does not trigger a restart", () => {
  assert.equal(shouldRestartAfterPollErrors(1), false);
  assert.equal(shouldRestartAfterPollErrors(0), false);
});

test("MAX_CONSECUTIVE_POLL_ERRORS is a sane positive threshold", () => {
  assert.ok(MAX_CONSECUTIVE_POLL_ERRORS >= 3);
});
