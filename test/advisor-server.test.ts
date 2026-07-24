import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import type { AddressInfo } from "node:net";

// config.ts reads env at module load, so the password has to be in place
// before advisor-server pulls it in. Hence the dynamic import.
process.env.ADVISOR_PASSWORD = "test-password";

const { createAdvisorServer, resetLoginRateLimitForTest, resetLastModeForTest } =
  await import("../src/advisor-server.ts");

const { resetSessionsForTest, sessionCount } =
  await import("../src/advisor-session.ts");

// Every test here logs in, all from loopback, so they share one /login rate
// bucket and would otherwise start 429ing partway through the file. The limiter
// itself is covered in advisor-lan.test.ts; here it is just noise.
//
// resetLastModeForTest keeps a fresh login defaulting to "private": lastMode
// is keyed by advisorId ("shared" for every login in this file), so without
// resetting it, an earlier test's /mode switch to "openai" would leak into a
// later test's login default and make PII-gate tests order-dependent.
beforeEach(() => {
  resetLoginRateLimitForTest();
  resetLastModeForTest();
});

// Stand-in for runAdvisorTurn. Records the sessions it saw so the isolation
// test can prove two cookies never share one conversation.
const seen: string[] = [];
let turnBehaviour: "complete" | "aborted" | "throw" = "complete";

const server = createAdvisorServer({
  runTurn: async (session, input) => {
    seen.push(session.id);
    if (turnBehaviour === "throw")
      throw new Error("provider blew up: STUDENT SECRET");
    if (turnBehaviour === "aborted") {
      return { text: "half an ans", toolCalls: 1, outcome: "aborted" as const };
    }
    return {
      text: `answered: ${input}`,
      toolCalls: 2,
      outcome: "complete" as const,
    };
  },
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  resetSessionsForTest();
  server.close();
});

async function login(password = "test-password"): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
    redirect: "manual",
  });
}

function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie");
  assert.ok(set, "expected a Set-Cookie header");
  return set.split(";")[0]!;
}

// Two-track tests below spin up their own server per test (mirrors the
// stoppable/withSchedule/raceServer pattern above) rather than sharing the
// module-level `server`, so /mode switches in one test cannot bleed into
// another via the shared session store.
async function startTestServer(): Promise<{
  server: ReturnType<typeof createAdvisorServer>;
  base: string;
}> {
  const testServer = createAdvisorServer({
    runTurn: async (_session, input) => ({
      text: `answered: ${input}`,
      toolCalls: 1,
      outcome: "complete" as const,
    }),
  });
  await new Promise<void>((r) => testServer.listen(0, "127.0.0.1", r));
  const p = (testServer.address() as AddressInfo).port;
  return { server: testServer, base: `http://127.0.0.1:${p}` };
}

async function loginCookie(
  base: string,
  password = "test-password",
): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
    redirect: "manual",
  });
  return cookieFrom(res);
}

test("the root path serves the login page to an unauthenticated visitor", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const page = await res.text();
  // Relative so the form still posts inside the /advisor/ prefix behind Caddy.
  assert.match(page, /action="login"/);
  assert.doesNotMatch(page, /id="composer"/);
});

test("an unauthenticated POST /chat is rejected with 401", async () => {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(res.status, 401);
  assert.equal(
    seen.length,
    0,
    "an unauthenticated request must never reach the agent",
  );
});

test("a wrong password is rejected and sets no cookie", async () => {
  const res = await login("not-the-password");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

// The login error is the first thing rendered back after a failed POST. If any
// of it came from the request body this would be reflected XSS.
test("a failed login never reflects request-supplied text into the page", async () => {
  const res = await login("<script>alert(1)</script>");
  const page = await res.text();
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.match(page, /Incorrect password/);
});

test("a correct password sets an HttpOnly session cookie and redirects", async () => {
  const res = await login();
  assert.equal(res.status, 302);
  // Relative, not "/". The app is also mounted under Caddy's /advisor/ prefix,
  // where an absolute "/" would redirect the browser out of the app entirely
  // (onto the capture tool sharing that vhost). "./" is correct at both mounts.
  assert.equal(res.headers.get("location"), "./");
  const set = res.headers.get("set-cookie")!;
  assert.match(set, /advisor_sid=/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
});

test("an authenticated chat turn returns the agent's answer", async () => {
  const cookie = cookieFrom(await login());
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ message: "what room fits 30?" }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { text: string; outcome: string };
  assert.equal(data.text, "answered: what room fits 30?");
  assert.equal(data.outcome, "complete");

  const page = await (await fetch(base, { headers: { cookie } })).text();
  assert.match(page, /id="composer"/);
});

// Sessions are keyed by cookie, never by password. Two advisors share the one
// password, so a password-scoped session would let each read the other's chat.
test("two logins with the same password get separate sessions", async () => {
  seen.length = 0;
  const a = cookieFrom(await login());
  const b = cookieFrom(await login());
  assert.notEqual(a, b);

  for (const cookie of [a, b]) {
    await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ message: "hello" }),
    });
  }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "each cookie must drive its own session");

  const exportA = await (
    await fetch(`${base}/export`, { headers: { cookie: a } })
  ).text();
  assert.doesNotMatch(exportA, /answered: hello[\s\S]*answered: hello/);
});

test("a stale cookie is rejected rather than silently re-authenticated", async () => {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: "advisor_sid=nope" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(res.status, 401);
});

test("a failed turn returns a generic error and leaks no provider text", async () => {
  const cookie = cookieFrom(await login());
  turnBehaviour = "throw";
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ message: "hi" }),
  });
  turnBehaviour = "complete";
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.doesNotMatch(body, /STUDENT SECRET/);
});

// A partial answer presented as a finished one is the failure AdvisorTurnResult
// exists to prevent, and the page has no other channel for the distinction.
test("an aborted turn is marked partial and is not recorded as history", async () => {
  const cookie = cookieFrom(await login());
  turnBehaviour = "aborted";
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ message: "hi" }),
  });
  turnBehaviour = "complete";
  const data = (await res.json()) as { text: string; outcome: string };
  assert.equal(data.outcome, "aborted");
  assert.match(data.text, /partial/i);

  const md = await (
    await fetch(`${base}/export`, { headers: { cookie } })
  ).text();
  assert.doesNotMatch(md, /half an ans/);
});

test("clearing the active track disposes it without issuing a new cookie", async () => {
  const cookie = cookieFrom(await login());
  await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ message: "remember me" }),
  });
  const before = sessionCount();
  const res = await fetch(`${base}/clear`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("set-cookie"),
    null,
    "client id is stable across /clear",
  );
  assert.equal(sessionCount(), before, "one session out, one session in");

  const md = await (
    await fetch(`${base}/export`, { headers: { cookie } })
  ).text();
  assert.doesNotMatch(md, /remember me/);
});

test("the transcript export renders the session history as markdown", async () => {
  const cookie = cookieFrom(await login());
  await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ message: "capacity of Hardin 101?" }),
  });
  const res = await fetch(`${base}/export`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  const md = await res.text();
  assert.match(md, /capacity of Hardin 101\?/);
  assert.match(md, /answered: capacity of Hardin 101\?/);
});

test("an in-flight turn can be stopped through /stop", async () => {
  const cookie = cookieFrom(await login());
  let sawAbort = false;
  const stoppable = createAdvisorServer({
    runTurn: (_session, _input, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          resolve({
            text: "stopped",
            toolCalls: 0,
            outcome: "aborted" as const,
          });
        });
      }),
  });
  await new Promise<void>((r) => stoppable.listen(0, "127.0.0.1", r));
  const p = (stoppable.address() as AddressInfo).port;
  const c = cookieFrom(
    await fetch(`http://127.0.0.1:${p}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    }),
  );

  const chat = fetch(`http://127.0.0.1:${p}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: c },
    body: JSON.stringify({ message: "long one" }),
  });
  // Give the turn a moment to register itself as in flight.
  await new Promise((r) => setTimeout(r, 50));
  const stop = await fetch(`http://127.0.0.1:${p}/stop`, {
    method: "POST",
    headers: { cookie: c },
  });
  assert.equal(stop.status, 200);
  const data = (await (await chat).json()) as { outcome: string };
  assert.equal(sawAbort, true, "/stop must reach the turn's AbortSignal");
  assert.equal(data.outcome, "aborted");
  stoppable.close();
  void cookie;
});

// The document is served by the HOST from validated data the agent supplied
// through propose_schedule — the agent never renders it and never writes it.
test("/export/schedule serves a document only after one has been proposed", async () => {
  const cookie = cookieFrom(await login());
  const before = await fetch(`${base}/export/schedule`, {
    headers: { cookie },
  });
  assert.equal(before.status, 404, "no schedule proposed yet");

  const withSchedule = createAdvisorServer({
    runTurn: async (session) => {
      session.lastSchedule = {
        term: "202608",
        notes: null,
        // This route test injects a schedule directly; verification is exercised
        // in advisor-artifacts.test.ts against the real snapshot.
        verifiedAgainst: "2026-07-21T23:27:08.673Z",
        sections: [
          {
            crn: "80833",
            subjectCourse: "GC4060",
            section: "001",
            title: "Advanced Packaging",
            creditHours: 3,
            days: "TR",
            beginTime: "1100",
            endTime: "1150",
            building: "Godfrey Hall",
            room: "201",
          },
        ],
      };
      return { text: "proposed", toolCalls: 1, outcome: "complete" as const };
    },
  });
  await new Promise<void>((r) => withSchedule.listen(0, "127.0.0.1", r));
  const p = (withSchedule.address() as AddressInfo).port;
  const c = cookieFrom(
    await fetch(`http://127.0.0.1:${p}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    }),
  );

  const chat = await fetch(`http://127.0.0.1:${p}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: c },
    body: JSON.stringify({ message: "make me a schedule" }),
  });
  const body = (await chat.json()) as { schedule?: boolean };
  assert.equal(body.schedule, true, "the UI needs to know a document exists");

  const doc = await fetch(`http://127.0.0.1:${p}/export/schedule`, {
    headers: { cookie: c },
  });
  assert.equal(doc.status, 200);
  assert.match(doc.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await doc.text(), /GC4060/);
  withSchedule.close();
});

test("an unauthenticated GET /export/schedule is rejected", async () => {
  const res = await fetch(`${base}/export/schedule`);
  assert.equal(res.status, 401);
});

// --- /clear must not race the in-flight turn --------------------------------
//
// /clear used to abort without awaiting, then remove piSessionRoot. A turn
// already past its abort check finishes non-aborted and runs
// `cp(attemptRoot, session.piSessionRoot)` (advisor-agent.ts), RECREATING the
// directory after the session has left the map — a transcript on disk that
// nothing will ever remove, because the sweeper only knows about sessions still
// in the map.
//
// This models exactly that shape: a turn that keeps writing to piSessionRoot
// after the abort signal fires.
test("/clear waits for an in-flight turn that would recreate the session directory", async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const path = await import("node:path");

  let capturedDir = "";
  let turnStarted: () => void;
  const started = new Promise<void>((r) => (turnStarted = r));

  const raceServer = createAdvisorServer({
    runTurn: async (session, _input, signal) => {
      capturedDir = session.piSessionRoot;
      turnStarted();
      // Wait for the abort, then do what the real commit step does: write the
      // conversation back into piSessionRoot.
      await new Promise<void>((r) => {
        if (signal?.aborted) return r();
        signal?.addEventListener("abort", () => r(), { once: true });
      });
      await new Promise((r) => setTimeout(r, 50));
      mkdirSync(session.piSessionRoot, { recursive: true });
      writeFileSync(
        path.join(session.piSessionRoot, "session.jsonl"),
        '{"role":"user","text":"student information"}\n',
      );
      return { text: "partial", toolCalls: 1, outcome: "complete" as const };
    },
  });
  await new Promise<void>((r) => raceServer.listen(0, "127.0.0.1", r));
  const racePort = (raceServer.address() as AddressInfo).port;
  const raceBase = `http://127.0.0.1:${racePort}`;

  try {
    const res = await fetch(`${raceBase}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    });
    const cookie = cookieFrom(res);

    const chat = fetch(`${raceBase}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "hi" }),
    }).catch(() => undefined);

    await started;
    await fetch(`${raceBase}/clear`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    await chat;

    assert.ok(capturedDir, "sanity: the turn never ran");
    assert.equal(
      existsSync(capturedDir),
      false,
      "the in-flight turn recreated piSessionRoot after /clear — a transcript nothing will ever remove",
    );
  } finally {
    resetSessionsForTest();
    raceServer.close();
  }
});

// --- final review I3: /chat must not race the turn it just aborted ----------
//
// /chat aborted a prior in-flight turn but did not await it, while /clear does.
// A prior turn past its abort checks still runs its commit step —
// `rm(piSessionRoot)` then `cp(attemptRoot, piSessionRoot)` (advisor-agent.ts) —
// so the new turn could be copying FROM piSessionRoot while the old turn was
// deleting and rewriting it: ENOENT, or a half-copied conversation committed as
// history. Double-submitting in the UI reaches this.
//
// The ordering IS the property, so the test asserts the ordering: the second
// turn must not begin until the first turn's commit step has finished.
test("/chat waits for the aborted prior turn to finish its commit before starting the next", async () => {
  const events: string[] = [];
  let firstStarted: () => void;
  const started = new Promise<void>((r) => (firstStarted = r));

  const raceServer = createAdvisorServer({
    runTurn: async (_session, input, signal) => {
      if (input === "first") {
        events.push("first:start");
        firstStarted();
        await new Promise<void>((r) => {
          if (signal?.aborted) return r();
          signal?.addEventListener("abort", () => r(), { once: true });
        });
        // The commit step: runs AFTER the abort check, and touches the same
        // transcript directory the next turn is about to copy from.
        await new Promise((r) => setTimeout(r, 50));
        events.push("first:commit");
        return { text: "partial", toolCalls: 1, outcome: "aborted" as const };
      }
      events.push("second:start");
      return {
        text: "second answer",
        toolCalls: 1,
        outcome: "complete" as const,
      };
    },
  });
  await new Promise<void>((r) => raceServer.listen(0, "127.0.0.1", r));
  const racePort = (raceServer.address() as AddressInfo).port;
  const raceBase = `http://127.0.0.1:${racePort}`;

  try {
    const res = await fetch(`${raceBase}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    });
    const cookie = cookieFrom(res);

    const send = (message: string) =>
      fetch(`${raceBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ message }),
      });

    const first = send("first").catch(() => undefined);
    await started;
    const second = await send("second");
    await first;

    assert.deepEqual(
      events,
      ["first:start", "first:commit", "second:start"],
      "the second turn started while the aborted first turn was still committing",
    );
    // And the second turn still produced its answer — the wait must not have
    // cost the caller the response.
    assert.equal(second.status, 200);
    assert.equal(
      ((await second.json()) as { text: string }).text,
      "second answer",
    );
  } finally {
    resetSessionsForTest();
    raceServer.close();
  }
});

// --- new outcomes must not render as finished answers ------------------------

test("a malformed-tool-call turn never renders its prose as an answer", async () => {
  const prose =
    "<cu_public__search-clemson-classes>{}</cu_public__search-clemson-classes>";
  const mServer = createAdvisorServer({
    runTurn: async () => ({
      text: prose,
      toolCalls: 0,
      outcome: "malformed_tool_call" as const,
    }),
  });
  await new Promise<void>((r) => mServer.listen(0, "127.0.0.1", r));
  const mBase = `http://127.0.0.1:${(mServer.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${mBase}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    });
    const cookie = cookieFrom(res);
    const chat = await fetch(`${mBase}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "hi" }),
    });
    const body = (await chat.json()) as { text: string; outcome: string };

    assert.equal(
      body.outcome,
      "malformed_tool_call",
      "the outcome must reach the client",
    );
    assert.ok(
      !body.text.includes(prose),
      "the malformed tool-call prose was rendered to the advisor as an answer",
    );
    assert.match(
      body.text,
      /restarted|malformed/i,
      "the advisor must be told the turn failed",
    );
  } finally {
    resetSessionsForTest();
    mServer.close();
  }
});

// A truncated turn is OURS to fix (raise the output budget, trim context) and a
// malformed one is the endpoint operator's. If the advisor cannot tell them
// apart, our budget bug gets escalated as a request to restart a shared server.
test("a truncated turn is marked partial and reads differently from a malformed one", async () => {
  const partial =
    "Fall 2026 CPSC 3000-level classes include CPSC 3300, CPSC 36";
  const tcServer = createAdvisorServer({
    runTurn: async () => ({
      text: partial,
      toolCalls: 1,
      outcome: "truncated" as const,
    }),
  });
  await new Promise<void>((r) => tcServer.listen(0, "127.0.0.1", r));
  const tcBase = `http://127.0.0.1:${(tcServer.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${tcBase}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    });
    const cookie = cookieFrom(res);
    const chat = await fetch(`${tcBase}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "hi" }),
    });
    const body = (await chat.json()) as { text: string; outcome: string };

    assert.equal(
      body.outcome,
      "truncated",
      "the outcome must reach the client",
    );
    assert.notEqual(
      body.outcome,
      "complete",
      "a cut-off turn must never present as a finished answer",
    );
    assert.ok(
      body.text.includes(partial),
      "genuine partial output should still be shown, unlike malformed prose",
    );
    assert.match(
      body.text,
      /cut off|length limit/i,
      "the advisor must be told the answer is unfinished",
    );
    // The remedy is ours; the advisor must not be sent to find an operator.
    assert.ok(
      !/restart/i.test(body.text),
      "a truncated turn must not suggest restarting the model server",
    );
  } finally {
    resetSessionsForTest();
    tcServer.close();
  }
});

test("a timed-out turn is marked partial rather than final", async () => {
  const tServer = createAdvisorServer({
    runTurn: async () => ({
      text: "as far as I got",
      toolCalls: 1,
      outcome: "timeout" as const,
    }),
  });
  await new Promise<void>((r) => tServer.listen(0, "127.0.0.1", r));
  const tBase = `http://127.0.0.1:${(tServer.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${tBase}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    });
    const cookie = cookieFrom(res);
    const chat = await fetch(`${tBase}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "hi" }),
    });
    const body = (await chat.json()) as { text: string; outcome: string };

    assert.equal(body.outcome, "timeout");
    assert.match(body.text, /partial/i, "a truncated answer must say so");
  } finally {
    resetSessionsForTest();
    tServer.close();
  }
});

// --- two-track: /mode swap, OpenAI PII consent gate, /clear active only -----

test("POST /mode swaps the active track and does not reset", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/mode", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ mode: "openai" }),
    });
    const data = (await r.json()) as { mode: string };
    assert.equal(r.status, 200);
    assert.equal(data.mode, "openai");
    assert.equal(r.headers.get("set-cookie"), null); // cookie (client id) is stable
  } finally { server.close(); }
});

test("POST /chat on the OpenAI track blocks flagged text without consent", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    await fetch(base + "/mode", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ mode: "openai" }) });
    const r = await fetch(base + "/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ message: "look at C12345678" }),
    });
    assert.equal(r.status, 409);
    const data = (await r.json()) as {
      needsConsent: boolean;
      flags: { category: string; sample: string }[];
    };
    assert.equal(data.needsConsent, true);
    assert.ok(data.flags.some((f) => f.category === "Clemson student ID"));
  } finally { server.close(); }
});

test("POST /chat on the OpenAI track proceeds with consent", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    await fetch(base + "/mode", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ mode: "openai" }) });
    const r = await fetch(base + "/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ message: "look at C12345678", consent: true }),
    });
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

test("POST /chat on the Private track never checks for PII", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: c },
      body: JSON.stringify({ message: "student C12345678 wants GC 3400" }),
    });
    assert.equal(r.status, 200); // private is FERPA-OK; no gate
  } finally { server.close(); }
});

// --- cleaner tab: auth-gated static serving ----------------------------------

test("GET /cleaner requires auth", async () => {
  const { server, base } = await startTestServer();
  try { assert.equal((await fetch(base + "/cleaner")).status, 401); }
  finally { server.close(); }
});

test("GET /cleaner serves HTML to an authed session", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/cleaner", { headers: { Cookie: c } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await r.text(), /cleaner/i);
  } finally { server.close(); }
});

test("GET /cleaner/modules/degree-works.js serves JS", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/cleaner/modules/degree-works.js", { headers: { Cookie: c } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
  } finally { server.close(); }
});

test("GET /cleaner/../ traversal is refused", async () => {
  const { server, base } = await startTestServer();
  try {
    const c = await loginCookie(base);
    const r = await fetch(base + "/cleaner/..%2f..%2fsrc%2fadvisor-agent.ts", { headers: { Cookie: c } });
    assert.ok(r.status === 400 || r.status === 404);
  } finally { server.close(); }
});

// --- POST /feedback: local-only feature-request / bug-report drop -----------

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("POST /feedback without a cookie is rejected with 401", async () => {
  const { server, base } = await startTestServer();
  try {
    const r = await fetch(base + "/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "add a dark mode toggle" }),
    });
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test("POST /feedback with auth but no description is rejected with 400", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "advisor-feedback-"));
  process.env.ADVISOR_FEEDBACK_DIR = tmp;
  try {
    const { server, base } = await startTestServer();
    try {
      const c = await loginCookie(base);
      const r = await fetch(base + "/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: c },
        body: JSON.stringify({ description: "   " }),
      });
      assert.equal(r.status, 400);
      const data = (await r.json()) as { error: string };
      assert.match(data.error, /description is required/);
    } finally { server.close(); }
  } finally {
    delete process.env.ADVISOR_FEEDBACK_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("POST /feedback with a description and screenshot saves both to disk", async () => {
  const { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } =
    await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "advisor-feedback-"));
  process.env.ADVISOR_FEEDBACK_DIR = tmp;
  try {
    const { server, base } = await startTestServer();
    try {
      const c = await loginCookie(base);
      const r = await fetch(base + "/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: c },
        body: JSON.stringify({
          description: "  the schedule export button is hard to find  ",
          screenshot: TINY_PNG,
        }),
      });
      assert.equal(r.status, 200);
      const data = (await r.json()) as { saved: boolean };
      assert.equal(data.saved, true);

      const entries = readdirSync(tmp);
      assert.equal(entries.length, 1, "expected one timestamped feedback directory");
      const dir = path.join(tmp, entries[0]!);
      assert.ok(existsSync(path.join(dir, "description.txt")));
      assert.ok(existsSync(path.join(dir, "screenshot.png")));
      assert.ok(existsSync(path.join(dir, "meta.json")));
      const text = readFileSync(path.join(dir, "description.txt"), "utf8");
      assert.equal(text, "the schedule export button is hard to find");
    } finally { server.close(); }
  } finally {
    delete process.env.ADVISOR_FEEDBACK_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
});
