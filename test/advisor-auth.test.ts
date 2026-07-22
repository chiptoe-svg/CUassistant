import assert from "node:assert/strict";
import test from "node:test";

import { checkPassword, parseCookies, authenticate, SESSION_COOKIE } from "../src/advisor-auth.ts";

test("parseCookies handles absent, single, and multiple cookies", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("advisor_sid=abc"), { advisor_sid: "abc" });
  assert.deepEqual(parseCookies("a=1; advisor_sid=xyz; b=2"), {
    a: "1",
    advisor_sid: "xyz",
    b: "2",
  });
});

// Fail closed: an unset ADVISOR_PASSWORD must not mean "accept anything".
test("an unconfigured password rejects every attempt", () => {
  assert.equal(checkPassword("", ""), false);
  assert.equal(checkPassword("guess", ""), false);
});

test("a configured password accepts only an exact match", () => {
  assert.equal(checkPassword("hunter2", "hunter2"), true);
  assert.equal(checkPassword("hunter3", "hunter2"), false);
  assert.equal(checkPassword("", "hunter2"), false);
});

// A length mismatch must not throw out of timingSafeEqual, and a long guess
// against a short secret must not be accepted.
test("mismatched lengths are rejected, not thrown", () => {
  assert.equal(checkPassword("hunter2-and-then-some", "hunter2"), false);
  assert.equal(checkPassword("h", "hunter2"), false);
});

test("authenticate reads the session cookie and carries an advisorId", () => {
  assert.equal(SESSION_COOKIE, "advisor_sid");
  assert.equal(authenticate({ headers: {} } as never), null);
  assert.equal(
    authenticate({ headers: { cookie: "other=1" } } as never),
    null,
  );
  assert.deepEqual(
    authenticate({ headers: { cookie: `${SESSION_COOKIE}=abc` } } as never),
    { advisorId: "shared" },
  );
});
