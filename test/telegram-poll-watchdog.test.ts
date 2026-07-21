import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { ApprovalGate } from "../src/approval/gate.ts";
import type {
  ApprovalChannel,
  ApprovalStore,
  Clock,
  GateConfig,
  IdGen,
  Sender,
} from "../src/approval/types.ts";
import type { Reachability } from "../src/notifiers/reachability.ts";
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
  startTelegramApproval,
  type FetchImpl,
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
    shouldWarnReceiverDown(
      RECEIVER_DOWN_WARN_MS + 1,
      RECEIVER_DOWN_WARN_MS + 1,
    ),
    true,
  );
  assert.equal(
    shouldWarnReceiverDown(1_000, 10 * RECEIVER_DOWN_WARN_MS),
    false,
  );
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

// --- pollLoop integration tests, driven through the fetchImpl seam ---
//
// These exercise the actual `!r.ok` branch inside pollLoop (via
// startTelegramApproval), not just the pure predicates it calls. A fake
// fetchImpl removes the socket; node:test's mock Date/setTimeout removes the
// need to wait on wall-clock time for backoffs and the 5-minute staleness
// window. The loop never terminates on its own, so once a test has observed
// what it needs, the fetchImpl "parks" the loop by returning a promise that
// never resolves — that doesn't hold the process open (no timer/handle is
// registered) so node:test can exit normally without pollLoop ever finishing.

const telegramCfg = {
  botToken: "test-token",
  authorizedUserId: "user-1",
  internalDomains: [] as string[],
};

function makeGate(): ApprovalGate {
  const sender: Sender = {
    async send() {
      return { id: "m1" };
    },
  };
  const channel: ApprovalChannel = {
    async post() {
      // no-op: these tests never reach the update-processing code, so the
      // channel is never actually called.
    },
  };
  const clock: Clock = { now: () => Date.now() };
  const idGen: IdGen = { generate: () => "req1" };
  const cfg: GateConfig = {
    ttlMs: 3_600_000,
    maxOutstanding: 5,
    rateLimitPerHour: 10,
    internalDomains: [],
    authorizedUserId: "user-1",
  };
  return new ApprovalGate({ sender, channel, clock, idGen }, cfg);
}

function makeNoopStore(onExit?: () => void): ApprovalStore {
  return {
    loadAll: () => [],
    upsert: () => {},
    loadSubmitTimes: () => [],
    recordSubmitTime: () => {},
    getLastWatchdogExit: () => null,
    recordWatchdogExit: () => onExit?.(),
  };
}

function fakeFailResponse(
  status: number,
  body: string,
  onTextRead?: () => void,
): Response {
  return {
    ok: false,
    status,
    text: async () => {
      onTextRead?.();
      return body;
    },
  } as unknown as Response;
}

function fakeOkResponse(result: unknown[] = []): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result }),
  } as unknown as Response;
}

/** A promise that never settles — parks pollLoop without holding the event loop open. */
function parked(): Promise<Response> {
  return new Promise<Response>(() => {});
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

/**
 * Replaces process.exit for the duration of a test. A real exit(1) inside the
 * poll loop would silently truncate the whole suite, so no test may let one
 * run — including tests whose entire point is that an exit must NOT happen
 * (those must stay safe even when the fix under test is reverted).
 */
function captureExit(): { count: number; restore: () => void } {
  const state = { count: 0, restore: () => {} };
  const orig = process.exit;
  process.exit = ((): never => {
    state.count++;
    return undefined as never;
  }) as typeof process.exit;
  state.restore = () => {
    process.exit = orig;
  };
  return state;
}

/** Advance mocked Date/setTimeout by ms and let the resulting microtasks drain. */
async function tick(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await new Promise((res) => setImmediate(res));
}

test("!r.ok responses never feed the watchdog: many consecutive HTTP failures never probe reachability or record a watchdog exit", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  let reachabilityChecks = 0;
  const reachability: Reachability = {
    async check() {
      reachabilityChecks++;
      // Unhealthy regardless: a safety net so this test can never reach
      // process.exit even if the behavior under test were broken.
      return false;
    },
  };
  let watchdogExits = 0;
  const store = makeNoopStore(() => watchdogExits++);

  const FAIL_COUNT = MAX_CONSECUTIVE_POLL_ERRORS + 5;
  let calls = 0;
  const fetchImpl: FetchImpl = (async () => {
    calls++;
    if (calls <= FAIL_COUNT) {
      return fakeFailResponse(
        401,
        JSON.stringify({ description: "Unauthorized" }),
      );
    }
    return parked();
  }) as FetchImpl;

  const capture = captureStderr();
  try {
    startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      store,
      fetchImpl,
    });
    // This branch now backs off on its own httpFailures counter, so the delay
    // grows; BACKOFF_CAP_MS covers the worst case for any single iteration.
    for (let i = 0; i < FAIL_COUNT + 1; i++) {
      await tick(BACKOFF_CAP_MS);
    }
  } finally {
    capture.restore();
    mock.timers.reset();
  }

  assert.equal(
    calls,
    FAIL_COUNT + 1,
    "sanity: the loop actually ran through every failure",
  );
  assert.equal(
    reachabilityChecks,
    0,
    "!r.ok must never reach the reachability probe — consecutiveErrors never crosses the threshold",
  );
  assert.equal(watchdogExits, 0, "!r.ok must never record a watchdog exit");
});

test("!r.ok responses never refresh lastSuccess: staleness keeps accruing until RECEIVER DOWN fires", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  // Unhealthy: a safety net so this test can never reach process.exit.
  const reachability: Reachability = {
    async check() {
      return false;
    },
  };
  const store = makeNoopStore();

  const fetchImpl: FetchImpl = (async () =>
    fakeFailResponse(
      401,
      JSON.stringify({ description: "Unauthorized" }),
    )) as FetchImpl;

  const capture = captureStderr();
  try {
    startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      store,
      fetchImpl,
    });
    // Backoff on this path grows to BACKOFF_CAP_MS, so advance a full cap per
    // iteration and run enough iterations to cross the staleness window.
    const iterations = Math.ceil(RECEIVER_DOWN_WARN_MS / BACKOFF_CAP_MS) + 4;
    for (let i = 0; i < iterations; i++) {
      await tick(BACKOFF_CAP_MS);
    }
  } finally {
    capture.restore();
    mock.timers.reset();
  }

  assert.ok(
    capture.lines.some((l) => l.includes("RECEIVER DOWN")),
    "staleness accrued purely from HTTP failures (lastSuccess frozen) must eventually trip the warning",
  );
});

test("a successful response resets consecutiveErrors, so it does not carry over into a later burst of transport failures", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  let reachabilityChecks = 0;
  const reachability: Reachability = {
    async check() {
      reachabilityChecks++;
      // Unhealthy regardless — a safety net so this test can never reach
      // process.exit even if the reset behavior under test were broken.
      return false;
    },
  };
  const store = makeNoopStore();

  const PRE_RESET_THROWS = 5;
  const POST_RESET_THROWS = 5; // PRE + POST === MAX_CONSECUTIVE_POLL_ERRORS:
  // if the ok response failed to reset consecutiveErrors, this combined
  // burst would cross the threshold and reachability.check() would fire.
  let calls = 0;
  const fetchImpl: FetchImpl = (async () => {
    calls++;
    if (calls <= PRE_RESET_THROWS) throw new Error("transport blip");
    if (calls === PRE_RESET_THROWS + 1) return fakeOkResponse([]);
    if (calls <= PRE_RESET_THROWS + 1 + POST_RESET_THROWS) {
      throw new Error("transport blip");
    }
    return parked();
  }) as FetchImpl;

  const capture = captureStderr();
  try {
    startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      store,
      fetchImpl,
    });
    const totalIterations = PRE_RESET_THROWS + 1 + POST_RESET_THROWS + 1;
    for (let i = 0; i < totalIterations; i++) {
      // Backoff grows with consecutiveErrors within each burst;
      // BACKOFF_CAP_MS safely covers the worst case for any one iteration.
      await tick(BACKOFF_CAP_MS);
    }
  } finally {
    capture.restore();
    mock.timers.reset();
  }

  assert.equal(
    calls,
    PRE_RESET_THROWS + 1 + POST_RESET_THROWS + 1,
    "sanity: every fetch was consumed",
  );
  assert.equal(
    reachabilityChecks,
    0,
    "post-reset throws alone (5) never reach MAX_CONSECUTIVE_POLL_ERRORS (10) on their own — the ok response must have reset consecutiveErrors, otherwise 5+5=10 would have crossed the threshold and triggered a probe",
  );
});

test("the !r.ok branch drains the body, surfaces Telegram's description, and tolerates a non-JSON body", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  // Unhealthy: a safety net so this test can never reach process.exit.
  const reachability: Reachability = {
    async check() {
      return false;
    },
  };
  const store = makeNoopStore();

  let calls = 0;
  let textReads = 0;
  const fetchImpl: FetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      return fakeFailResponse(
        401,
        JSON.stringify({ description: "Unauthorized" }),
        () => textReads++,
      );
    }
    if (calls === 2) {
      return fakeFailResponse(
        429,
        "<html>rate limited</html>",
        () => textReads++,
      );
    }
    return parked();
  }) as FetchImpl;

  const capture = captureStderr();
  try {
    startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      store,
      fetchImpl,
    });
    await tick(BACKOFF_CAP_MS);
    await tick(BACKOFF_CAP_MS);
  } finally {
    capture.restore();
    mock.timers.reset();
  }

  assert.equal(
    textReads,
    2,
    "the body must be drained (read) on every !r.ok response",
  );
  assert.ok(
    capture.lines.some(
      (l) => l.includes("HTTP 401") && l.includes("Unauthorized"),
    ),
    "a JSON body's description must be surfaced in the log line",
  );
  assert.ok(
    capture.lines.some(
      (l) => l.includes("HTTP 429") && !l.includes("undefined"),
    ),
    "a non-JSON body must not throw and must still log a clean line without a bogus description",
  );
});

test("with NO store the watchdog never exits, even with the network healthy and the threshold exceeded", async () => {
  // Degraded mode (unwritable state dir): there is no place to record a
  // watchdog exit, so the once-per-hour restart rate limit is unenforceable.
  // The safe behavior is to never exit at all — otherwise this path silently
  // restores the unbounded restart churn the branch exists to remove.
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  let reachabilityChecks = 0;
  const reachability: Reachability = {
    async check() {
      reachabilityChecks++;
      // Healthy — this is the condition that WOULD authorize an exit if the
      // missing store were treated as "never exited before".
      return true;
    },
  };

  const THROWS = MAX_CONSECUTIVE_POLL_ERRORS + 3;
  let calls = 0;
  const fetchImpl: FetchImpl = (async () => {
    calls++;
    if (calls <= THROWS) throw new Error("transport blip");
    return parked();
  }) as FetchImpl;

  const exit = captureExit();
  const capture = captureStderr();
  try {
    startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      // store deliberately omitted — this IS the degraded mode.
      fetchImpl,
    });
    for (let i = 0; i < THROWS + 1; i++) {
      await tick(BACKOFF_CAP_MS);
    }
  } finally {
    capture.restore();
    exit.restore();
    mock.timers.reset();
  }

  assert.ok(
    reachabilityChecks > 0,
    "sanity: the error threshold was actually crossed and the watchdog block ran",
  );
  assert.equal(
    exit.count,
    0,
    "with no store there is no enforceable restart rate limit, so the watchdog must never exit",
  );
  assert.ok(
    capture.lines.some((l) => l.includes("watchdog restart DISABLED")),
    "the disabled watchdog must be stated once at startup, not left implicit",
  );
});

test("a store whose getLastWatchdogExit() throws must not exit and must not kill the loop", async () => {
  // SQLITE_BUSY / disk failure reading the cooldown must be treated the same
  // as "no store": the cooldown in condition (3) can't be confirmed, so the
  // safe behavior is to never exit. Before the fix, this throw rejects
  // pollLoop's promise; since pollLoop is invoked as `void pollLoop(...)`,
  // that rejection is unhandled and the receiver dies silently with no
  // further fetch calls and no process.exit.
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  const reachability: Reachability = {
    async check() {
      // Healthy — this is the condition that WOULD authorize an exit if the
      // read failure were not guarded.
      return true;
    },
  };
  let watchdogExits = 0;
  const store: ApprovalStore = {
    ...makeNoopStore(() => watchdogExits++),
    getLastWatchdogExit: () => {
      throw new Error("SQLITE_BUSY: database is locked");
    },
  };

  const THROWS = MAX_CONSECUTIVE_POLL_ERRORS + 3;
  let calls = 0;
  const fetchImpl: FetchImpl = (async () => {
    calls++;
    if (calls <= THROWS) throw new Error("transport blip");
    return parked();
  }) as FetchImpl;

  const exit = captureExit();
  const capture = captureStderr();
  let unhandledRejections = 0;
  const onUnhandled = () => unhandledRejections++;
  process.on("unhandledRejection", onUnhandled);
  try {
    startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      store,
      fetchImpl,
    });
    for (let i = 0; i < THROWS + 1; i++) {
      await tick(BACKOFF_CAP_MS);
    }
    // Give any unhandled rejection a chance to be reported before asserting.
    await new Promise((res) => setImmediate(res));
  } finally {
    capture.restore();
    exit.restore();
    process.off("unhandledRejection", onUnhandled);
    mock.timers.reset();
  }

  assert.ok(
    calls > THROWS,
    "the loop must still be running and polling after the read failure — it was not killed",
  );
  assert.equal(
    exit.count,
    0,
    "a cooldown that cannot be confirmed must never authorize an exit",
  );
  assert.equal(watchdogExits, 0, "no exit was recorded either");
  assert.equal(
    unhandledRejections,
    0,
    "the store read failure must not escape as an unhandled rejection",
  );
  assert.ok(
    capture.lines.some((l) => l.includes("STORE READ FAILED")),
    "the read failure must be logged loudly",
  );
});

test("repeated !r.ok responses back off with a GROWING delay, not a fixed base", async () => {
  // A persistent 401/429 polled every 3s forever is ~28k requests/day. The
  // HTTP-failure path needs its own counter feeding nextBackoffMs.
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  const reachability: Reachability = {
    async check() {
      return false;
    },
  };
  const store = makeNoopStore();

  let calls = 0;
  const fetchImpl: FetchImpl = (async () => {
    calls++;
    return fakeFailResponse(
      429,
      JSON.stringify({ description: "Too Many Requests" }),
    );
  }) as FetchImpl;

  const exit = captureExit();
  const capture = captureStderr();
  try {
    startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      store,
      fetchImpl,
    });
    await new Promise((res) => setImmediate(res));
    assert.equal(calls, 1, "sanity: the first poll ran");

    // 1st backoff is nextBackoffMs(1) === BACKOFF_BASE_MS.
    await tick(BACKOFF_BASE_MS);
    assert.equal(
      calls,
      2,
      "the first retry comes after exactly the base delay",
    );

    // 2nd backoff must be nextBackoffMs(2) === 2 * base. One base is not enough.
    await tick(BACKOFF_BASE_MS);
    assert.equal(
      calls,
      2,
      "the second backoff must EXCEED the base — a fixed 3s retry is the bug",
    );
    await tick(BACKOFF_BASE_MS);
    assert.equal(calls, 3, "…and it elapses at 2x the base");
  } finally {
    capture.restore();
    exit.restore();
    mock.timers.reset();
  }
});

test("channel.post goes through the injected fetchImpl seam", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });

  const reachability: Reachability = {
    async check() {
      return false;
    },
  };
  const urls: string[] = [];
  const fetchImpl: FetchImpl = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("getUpdates")) return parked();
    return fakeOkResponse([]);
  }) as FetchImpl;

  const exit = captureExit();
  const capture = captureStderr();
  try {
    const channel = startTelegramApproval(telegramCfg, makeGate(), {
      reachability,
      store: makeNoopStore(),
      fetchImpl,
    });
    await channel.post(
      {
        request_id: "req1",
        artifact: {
          account: "ms365",
          to: ["someone@example.com"],
          subject: "hi",
          body: "body",
        },
        content_hash: "h",
        proposer: "agent-1",
        status: "pending",
        created_at: 0,
        expires_at: 1,
      },
      [],
    );
  } finally {
    capture.restore();
    exit.restore();
    mock.timers.reset();
  }

  assert.ok(
    urls.some((u) => u.includes("sendMessage")),
    "post() must use the injected fetch, not global fetch — otherwise it is untestable through the seam",
  );
});
