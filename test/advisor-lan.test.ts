// Regression coverage for the two things that make a non-loopback advisor bind
// survivable: the fail-closed startup guard, and the /login rate limit.

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { execFile } from "node:child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";

// config.ts reads env at module load, so this must precede the import.
process.env.ADVISOR_PASSWORD = "test-password";

const {
  assertAdvisorAuthConfig,
  clientIp,
  createAdvisorServer,
  loginRateOk,
  resetLoginRateLimitForTest,
} = await import("../src/advisor-server.ts");
const { resetSessionsForTest } = await import("../src/advisor-session.ts");

// --- fail closed --------------------------------------------------------

// REGRESSION: the bind host became configurable, so "no password" and "reachable
// from the LAN" became a combination that can be expressed. It must be refused
// at startup rather than served.
test("assertAdvisorAuthConfig: a passwordless non-loopback bind is refused", () => {
  assert.throws(
    () => assertAdvisorAuthConfig("", "0.0.0.0"),
    /ADVISOR_PASSWORD is required/,
  );
  assert.throws(
    () => assertAdvisorAuthConfig("", "130.127.162.67"),
    /ADVISOR_PASSWORD is required/,
  );
});

test("assertAdvisorAuthConfig: loopback without a password, and any host with one, are allowed", () => {
  assert.doesNotThrow(() => assertAdvisorAuthConfig("", "127.0.0.1"));
  assert.doesNotThrow(() => assertAdvisorAuthConfig("", "::1"));
  assert.doesNotThrow(() => assertAdvisorAuthConfig("", "localhost"));
  assert.doesNotThrow(() => assertAdvisorAuthConfig("pw", "0.0.0.0"));
});

// The guard is only worth anything if the real entrypoint runs it. Asserting on
// the exported function alone would still pass if startAdvisorServer never
// called it, so this drives the actual process.
test("the advisor process exits rather than serving an unauthenticated LAN door", async () => {
  const port = await freePort();
  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve) => {
      execFile(
        "npx",
        ["tsx", "src/advisor-server.ts"],
        {
          cwd: new URL("..", import.meta.url).pathname,
          env: {
            ...process.env,
            ADVISOR_HTTP_HOST: "0.0.0.0",
            ADVISOR_PASSWORD: "",
            ADVISOR_PORT: String(port),
          },
          timeout: 60_000,
        },
        (err, _stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : err
                ? 1
                : 0;
          resolve({ code, stderr });
        },
      );
    },
  );
  assert.notEqual(result.code, 0, "expected a non-zero exit");
  assert.match(result.stderr, /ADVISOR_PASSWORD is required/);
  // And it must not have left a listener behind on the way out.
  assert.equal(await portOpen(port), false, `port ${port} should be closed`);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net
      .connect(port, "127.0.0.1")
      .on("connect", () => {
        s.destroy();
        resolve(true);
      })
      .on("error", () => resolve(false));
  });
}

// --- /login rate limit --------------------------------------------------

test("loginRateOk allows 15 attempts per IP per minute, then refuses", () => {
  resetLoginRateLimitForTest();
  const t0 = 1_000_000;
  for (let i = 0; i < 15; i++) {
    assert.equal(loginRateOk("10.0.0.1", t0 + i), true, `attempt ${i + 1}`);
  }
  assert.equal(loginRateOk("10.0.0.1", t0 + 15), false);
  // Buckets are per-IP, not global.
  assert.equal(loginRateOk("10.0.0.2", t0 + 15), true);
  // And the window slides.
  assert.equal(loginRateOk("10.0.0.1", t0 + 60_001), true);
});

test("clientIp prefers the first X-Forwarded-For element, else the socket", () => {
  const withHeader = {
    headers: { "x-forwarded-for": "203.0.113.9, 70.1.1.1" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Parameters<typeof clientIp>[0];
  assert.equal(clientIp(withHeader), "203.0.113.9");
  const bare = {
    headers: {},
    socket: { remoteAddress: "130.127.162.5" },
  } as unknown as Parameters<typeof clientIp>[0];
  assert.equal(clientIp(bare), "130.127.162.5");
});

const server = createAdvisorServer({
  runTurn: async (_session, input) => ({
    text: `answered: ${input}`,
    toolCalls: 0,
    outcome: "complete" as const,
  }),
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  resetSessionsForTest();
  server.close();
});

beforeEach(() => resetLoginRateLimitForTest());

function login(password: string, ip: string): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": ip,
    },
    body: new URLSearchParams({ password }).toString(),
    redirect: "manual",
  });
}

// REGRESSION: with no limiter a short shared password is one unthrottled
// guessing loop away from a session cookie.
test("repeated bad logins from one IP start returning 429", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 17; i++)
    codes.push((await login("wrong", "10.1.1.1")).status);
  assert.deepEqual(codes.slice(0, 15), Array(15).fill(401));
  assert.deepEqual(codes.slice(15), [429, 429]);
});

// The limiter must not follow the advisor into the conversation: /chat is the
// tool being used normally, and throttling it would be a bug, not a control.
test("an authenticated /chat is never rate-limited", async () => {
  const res = await login("test-password", "10.2.2.2");
  assert.equal(res.status, 302);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  for (let i = 0; i < 30; i++) {
    const chat = await fetch(`${base}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Forwarded-For": "10.2.2.2",
      },
      body: JSON.stringify({ message: `turn ${i}` }),
    });
    assert.equal(chat.status, 200, `chat turn ${i + 1} was throttled`);
  }
});
