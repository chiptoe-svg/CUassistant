// The advisor's numeric limits, read in a CHILD PROCESS.
//
// These are module-level constants resolved from the environment at config
// load. An in-process test cannot re-read them and a dynamic re-import returns
// the cached module, so a fresh process is the only way to test what a given
// environment actually produces.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const cwd = new URL("..", import.meta.url).pathname;

async function limitsWith(
  env: Record<string, string>,
): Promise<Record<string, number>> {
  const { stdout } = await run(
    "npx",
    ["tsx", "test/fixtures/advisor-config-print.ts"],
    { cwd, env: { ...process.env, ...env } },
  );
  return JSON.parse(stdout.trim()) as Record<string, number>;
}

// REGRESSION: `Number(env || 8)` turns a non-numeric value into NaN, and EVERY
// comparison against NaN is false. `rounds > NaN` is false forever, so the cap
// never fires and the loop is unbounded — on a typo in a unit file. It
// previously appeared to fail closed at a cap of zero, but that was luck: it
// depended on which direction the comparison happened to be written.
test("a non-numeric ADVISOR_MAX_ROUNDS falls back to the default, never NaN", async () => {
  const limits = await limitsWith({ ADVISOR_MAX_ROUNDS: "banana" });
  assert.ok(
    Number.isFinite(limits.ADVISOR_MAX_ROUNDS),
    `ADVISOR_MAX_ROUNDS is ${limits.ADVISOR_MAX_ROUNDS} — a NaN cap never fires`,
  );
  assert.equal(limits.ADVISOR_MAX_ROUNDS, 8);
});

test("an empty ADVISOR_MAX_ROUNDS falls back to the default", async () => {
  // Number("") is 0, which would be a cap of zero rather than the default.
  const limits = await limitsWith({ ADVISOR_MAX_ROUNDS: "" });
  assert.equal(limits.ADVISOR_MAX_ROUNDS, 8);
});

test("a negative or zero ADVISOR_MAX_ROUNDS falls back to the default", async () => {
  assert.equal((await limitsWith({ ADVISOR_MAX_ROUNDS: "-5" })).ADVISOR_MAX_ROUNDS, 8);
  assert.equal((await limitsWith({ ADVISOR_MAX_ROUNDS: "0" })).ADVISOR_MAX_ROUNDS, 8);
});

test("a valid ADVISOR_MAX_ROUNDS is honoured", async () => {
  assert.equal((await limitsWith({ ADVISOR_MAX_ROUNDS: "3" })).ADVISOR_MAX_ROUNDS, 3);
});

test("the same guard covers the turn timeout and the request budget", async () => {
  const limits = await limitsWith({
    ADVISOR_TURN_TIMEOUT_MS: "not-a-number",
    ADVISOR_MAX_REQUEST_TOKENS: "",
  });
  assert.equal(limits.ADVISOR_TURN_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(limits.ADVISOR_MAX_REQUEST_TOKENS, 45000);
});

// temperature needs its own guard: 0 is a LEGITIMATE temperature, so the
// positive-number check the other limits use would wrongly reject it.
test("ADVISOR_TEMPERATURE defaults to the documented 0.6 and accepts 0", async () => {
  assert.equal((await limitsWith({})).ADVISOR_TEMPERATURE, 0.6);
  assert.equal((await limitsWith({ ADVISOR_TEMPERATURE: "junk" })).ADVISOR_TEMPERATURE, 0.6);
  assert.equal((await limitsWith({ ADVISOR_TEMPERATURE: "0" })).ADVISOR_TEMPERATURE, 0);
  assert.equal((await limitsWith({ ADVISOR_TEMPERATURE: "0.9" })).ADVISOR_TEMPERATURE, 0.9);
});
