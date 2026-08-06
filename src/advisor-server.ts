// Advisor chat HTTP service. Follows src/token-portal.ts: node:http,
// hand-rolled routes, no framework.
//
// Two things this module is responsible for that are easy to get wrong:
//
//  1. Session isolation is per-COOKIE, never per-password. Both advisors know
//     the same password, so the cookie is the only thing keeping one advisor's
//     conversation out of the other's window.
//  2. Nothing derived from a request is ever rendered back into HTML or echoed
//     into a log. Prompts, answers, and error bodies can all carry student
//     information, and the login page is the one HTML surface a failed request
//     can reach.

import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADVISOR_HEALTH_TOKEN,
  ADVISOR_HTTP_HOST,
  ADVISOR_PASSWORD,
  ADVISOR_PORT,
  ADVISOR_SESSION_TTL_MS,
  ADVISOR_WHISPER_KEY,
  ADVISOR_WHISPER_MODEL,
  ADVISOR_WHISPER_URL,
  STATE_DIR,
} from "./config.js";
import { log } from "./log.js";
import { isLoopbackHost } from "./mcp-tools/server.js";
import {
  SESSION_COOKIE,
  authenticate,
  checkPassword,
  parseCookies,
} from "./advisor-auth.js";
import {
  createClient,
  getActiveSession,
  switchActive,
  clearActive,
  disposeAllSessions,
  sweepExpired,
  type AdvisorMode,
  type AdvisorSession,
} from "./advisor-session.js";
import {
  initAdvisorTools,
  runAdvisorTurn,
  shutdownAdvisorTools,
  type AdvisorTurnResult,
} from "./advisor-agent.js";
import { renderChatPage, renderLoginPage } from "./advisor-ui.js";
import { renderSchedule } from "./advisor-artifacts.js";
import { renderScheduleGrid, scheduleGridHeightPx, checkedScheduleToView } from "./schedule-grid.js";
import { flagLikelyPrivate } from "./advisor-pii-detect.js";
import { lookupCourse } from "./advisor-catalog.js";
import { checkSystemHealth, type SystemHealth } from "./advisor-health.js";

const MAX_BODY_BYTES = 5_000_000;

// Local-only feedback drop: no network egress, just files on the advisor
// host. Env override so tests write to a temp dir instead of the real state
// directory.
const FEEDBACK_DIR =
  process.env.ADVISOR_FEEDBACK_DIR || path.join(STATE_DIR, "feedback");

const CLEANER_DIR = fileURLToPath(new URL("../advisor/cleaner", import.meta.url));
const CLEANER_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Serve a static asset from advisor/cleaner behind auth; traversal-safe. */
function serveCleanerAsset(res: http.ServerResponse, relPath: string): void {
  const resolved = path.resolve(CLEANER_DIR, "." + path.posix.normalize("/" + relPath));
  if (resolved !== CLEANER_DIR && !resolved.startsWith(CLEANER_DIR + path.sep)) {
    return json(res, 400, { error: "bad path" });
  }
  const type = CLEANER_MIME[path.extname(resolved).toLowerCase()];
  if (!type) return json(res, 404, { error: "not found" });
  let body: Buffer;
  try { body = readFileSync(resolved); }
  catch { return json(res, 404, { error: "not found" }); }
  res.writeHead(200, { "Content-Type": type });
  res.end(body);
}

/**
 * Fail closed: the only thing standing between this service and the network is
 * the shared password, so a non-loopback bind without one must not start.
 * Mirrors assertHttpAuthConfig in mcp-tools/server.ts, and deliberately reuses
 * its isLoopbackHost so there is exactly one host classifier in the codebase.
 */
export function assertAdvisorAuthConfig(expected: string, host: string): void {
  if (!expected && !isLoopbackHost(host)) {
    throw new Error(
      `ADVISOR_PASSWORD is required when ADVISOR_HTTP_HOST is not loopback (got "${host}")`,
    );
  }
}

// --- /login rate limit -------------------------------------------------
//
// Shape lifted from gc_alumni/ask_gc/app.py (_rate_ok): a per-IP deque of
// timestamps, pruned to a sliding window. Applied to /login ONLY. /chat is
// deliberately exempt — an advisor mid-conversation must never be throttled for
// using the tool normally, and the thing worth slowing down is password
// guessing, not advising.
const LOGIN_RATE_N = 15;
const LOGIN_RATE_WINDOW_MS = 60_000;
/** Bound on tracked IPs, so a spray of forged X-Forwarded-For cannot grow this map without limit. */
const LOGIN_RATE_MAX_IPS = 5_000;
const loginHits = new Map<string, number[]>();

/**
 * Client IP, X-Forwarded-For first element then the socket address — matching
 * ask_gc.
 *
 * As deployed this value is now trustworthy. The server binds 127.0.0.1
 * (ADVISOR_HTTP_HOST), so the only route in is Caddy's TLS vhost
 * gcworkflow.clemson.edu:8443/advisor/, and Caddy trusts no upstream proxies by
 * default: it REPLACES any client-sent X-Forwarded-For with the real peer
 * address rather than appending to it. Verified — a request carrying a forged
 * "X-Forwarded-For: 1.2.3.4" arrives here with the header rewritten to the
 * actual client IP. So the first element is the real client, and the /login
 * rate limiter is a genuine per-client bound, not merely a usability one.
 *
 * That guarantee rests on BOTH halves of the deployment. If the bind is ever
 * widened again (ADVISOR_HTTP_HOST=0.0.0.0), or a trusted_proxies directive is
 * added to the Caddy site, this header goes back to being client-controlled and
 * the limiter degrades to usability-only. The socket fallback stays for the
 * loopback path, where there is no proxy and no header.
 */
export function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  const first = raw?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "?";
}

export function loginRateOk(ip: string, now: number = Date.now()): boolean {
  if (loginHits.size > LOGIN_RATE_MAX_IPS) {
    for (const [k, v] of loginHits) {
      if (v.length === 0 || now - v[v.length - 1]! > LOGIN_RATE_WINDOW_MS) {
        loginHits.delete(k);
      }
    }
  }
  let dq = loginHits.get(ip);
  if (!dq) {
    dq = [];
    loginHits.set(ip, dq);
  }
  while (dq.length > 0 && now - dq[0]! > LOGIN_RATE_WINDOW_MS) dq.shift();
  if (dq.length >= LOGIN_RATE_N) return false;
  dq.push(now);
  return true;
}

export function resetLoginRateLimitForTest(): void {
  loginHits.clear();
}

/** Server-authored, fixed strings. Nothing from a request is ever rendered. */
const LOGIN_FAILED = "Incorrect password.";
const LOGIN_UNCONFIGURED =
  "Sign-in is not configured on this server. Contact the administrator.";

type RunTurn = (
  session: AdvisorSession,
  input: string,
  signal?: AbortSignal,
) => Promise<AdvisorTurnResult>;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Read the body as raw bytes. `readBody` decodes utf8, which corrupts binary —
 * the /transcribe route needs the audio blob intact to forward to Whisper.
 */
function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function html(res: http.ServerResponse, status: number, page: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Whether the client reached us over HTTPS, per Caddy's X-Forwarded-Proto. Same
 * trust model as clientIp: behind the TLS vhost Caddy sets this header (and
 * replaces any client-forged forwarding headers), so it is reliable; a direct
 * loopback dev request over plain http has no header. Used to gate the Secure
 * cookie attribute so production cookies are HTTPS-only without breaking local
 * http testing.
 */
function requestIsHttps(req: http.IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  const raw = Array.isArray(proto) ? proto[0] : proto;
  return (raw?.split(",")[0]?.trim().toLowerCase() ?? "") === "https";
}

/** Constant-time check of the GET /health bearer against ADVISOR_HEALTH_TOKEN.
 *  Fail closed: an empty configured token rejects everything (checkPassword). */
function healthTokenOk(req: http.IncomingMessage): boolean {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
  return m ? checkPassword(m[1]!.trim(), ADVISOR_HEALTH_TOKEN) : false;
}

function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${
    secure ? "; Secure" : ""
  }`;
}

/**
 * The UI has one text channel for the answer, so a turn that did NOT finish has
 * to say so inside it. Rendering a truncated answer as a final one is exactly
 * what AdvisorTurnResult's outcome field exists to prevent.
 */
const OUTCOME_NOTE: Record<
  Exclude<AdvisorTurnResult["outcome"], "complete">,
  string
> = {
  aborted: "[Stopped — this answer is partial.]",
  round_cap: "[The tool-round limit was reached — this answer is partial.]",
  timeout: "[This turn ran out of time — this answer is partial.]",
  // The text is a tool call rendered as prose, not an answer, so unlike the
  // other outcomes it is suppressed entirely rather than annotated. Showing it
  // invites the advisor to read invented prose as a sourced answer — the exact
  // failure this outcome exists to prevent.
  malformed_tool_call:
    "[The model service returned a malformed response and this turn produced no answer. Please try again; if it repeats, the model server needs to be restarted.]",
  // Deliberately worded so it can never be mistaken for malformed_tool_call
  // above: this one is a limit on OUR side, and it must not send the advisor
  // chasing an operator for a server restart that would fix nothing. The text
  // IS kept and annotated, unlike the malformed case — a truncated answer is
  // genuine partial output, not invented prose, so it is worth showing as long
  // as it is clearly marked as unfinished.
  truncated:
    "[This answer was cut off — the turn reached its length limit. Ask for a shorter answer, or ask a follow-up to continue.]",
};

function withOutcomeNote(result: AdvisorTurnResult): string {
  if (result.outcome === "complete") return result.text;
  const note = OUTCOME_NOTE[result.outcome];
  if (result.outcome === "malformed_tool_call") return note;
  return result.text ? `${result.text}\n\n${note}` : note;
}

// In-flight turns, keyed by session id, so /stop can reach the AbortSignal that
// Task 3 wired through the harness. Abort mid-tool-call is the reason a runner
// is used at all; without this the stop control would be decorative.
//
// `done` is tracked alongside the controller because aborting is not the same
// as having stopped. /clear used to abort and immediately remove piSessionRoot;
// a turn already past its abort check would then finish non-aborted and run
// `cp(attemptRoot, session.piSessionRoot)` (advisor-agent.ts), RECREATING the
// directory after the session had left the map — a transcript on disk that
// nothing would ever remove. Awaiting `done` closes that window.
interface InFlightTurn {
  controller: AbortController;
  done: Promise<unknown>;
}
const inFlight = new Map<string, InFlightTurn>();

// Last mode each advisor used, so a fresh login opens where they left off.
// In-memory: a restart resets to `private`, the safe default. The server is
// authoritative for routing; the banner is cosmetic and cannot disagree.
const lastMode = new Map<string, AdvisorMode>();

/** Test seam: drop last-used-mode tracking so a fresh login defaults to "private" again. */
export function resetLastModeForTest(): void {
  lastMode.clear();
}

export function createAdvisorServer(
  deps: {
    runTurn?: RunTurn;
    /** Injectable so tests exercise /health without live MCP connections. */
    checkHealth?: () => Promise<SystemHealth>;
  } = {},
): http.Server {
  const runTurn = deps.runTurn ?? runAdvisorTurn;
  const checkHealth = deps.checkHealth ?? checkSystemHealth;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && url.pathname === "/") {
        const cid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const active = getActiveSession(cid);
        return active
          ? html(res, 200, renderChatPage(active.session.mode))
          : html(res, 200, renderLoginPage());
      }

      if (method === "POST" && url.pathname === "/login") {
        if (!loginRateOk(clientIp(req))) {
          log.warn("advisor login rate-limited");
          return json(res, 429, {
            error: "too many sign-in attempts — wait a minute and try again",
          });
        }
        const form = new URLSearchParams(await readBody(req));
        if (!checkPassword(form.get("password") ?? "")) {
          // Only fixed, server-authored strings reach renderLoginPage. The
          // supplied password is never reflected.
          const page = renderLoginPage(
            ADVISOR_PASSWORD ? LOGIN_FAILED : LOGIN_UNCONFIGURED,
          );
          log.warn("advisor login rejected");
          return html(res, 401, page);
        }
        const { clientId } = createClient("shared", lastMode.get("shared") ?? "private");
        log.info("advisor login", { client: clientId });
        // Relative, not "/": behind the Caddy /advisor/ prefix an absolute "/"
        // would land the browser on the capture tool at :3000. "./" resolves
        // from /login to / and from /advisor/login to /advisor/ — correct at
        // both mount points, which is also why the UI uses relative URLs.
        res.writeHead(302, {
          Location: "./",
          "Set-Cookie": sessionCookie(clientId, requestIsHttps(req)),
        });
        return res.end();
      }

      // System health for an external monitor/agent. BEFORE the session-cookie
      // gate (a monitor has no login) but gated by its own bearer token so it is
      // not world-readable. 200 when every data source is reachable, 503 when
      // any is down, so a monitor can key on the status code alone.
      if (method === "GET" && url.pathname === "/health") {
        if (!healthTokenOk(req)) return json(res, 401, { error: "unauthorized" });
        const health = await checkHealth();
        return json(res, health.healthy ? 200 : 503, health);
      }

      const auth = authenticate(req);
      if (!auth) return json(res, 401, { error: "not authenticated" });
      const cid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const active = getActiveSession(cid);
      if (!active) return json(res, 401, { error: "session expired" });
      const session = active.session;

      // Course hover-card lookup. The client linkifies course codes in answers
      // and fetches title/credits/description here on hover. Public catalog data
      // (read-only gc_advisor.db), so it rides the session cookie but carries no
      // student information.
      if (method === "GET" && url.pathname.startsWith("/course/")) {
        const raw = decodeURIComponent(url.pathname.slice("/course/".length));
        const course = lookupCourse(raw);
        return course
          ? json(res, 200, course)
          : json(res, 404, { error: "no catalog entry" });
      }

      if (method === "GET" && url.pathname === "/cleaner") {
        // Redirect to the trailing-slash form so the page's RELATIVE asset URLs
        // (framework.js, ./modules/…, ./vendor/…) resolve under /cleaner/ rather
        // than the site root. "cleaner/" is relative, so it also works behind the
        // Caddy /advisor/ prefix — same reason /login redirects to "./".
        res.writeHead(302, { Location: "cleaner/" });
        return res.end();
      }
      if (method === "GET" && url.pathname === "/cleaner/") {
        return serveCleanerAsset(res, "index.html");
      }
      if (method === "GET" && url.pathname.startsWith("/cleaner/")) {
        return serveCleanerAsset(res, url.pathname.slice("/cleaner/".length));
      }

      // Voice input: the browser records mic audio and posts the blob here; we
      // forward it to OMLX's on-host Whisper (loopback) and return the text.
      // The audio never leaves the machine — no cloud STT. OMLX is `local_omlx`
      // (scope: local) in policy, reached over loopback, so this needs no egress
      // gate. Nothing about the audio or transcript is logged (it may name a
      // student).
      if (method === "POST" && url.pathname === "/transcribe") {
        if (!ADVISOR_WHISPER_KEY) {
          return json(res, 503, { error: "voice input is not configured" });
        }
        const audio = await readBodyBuffer(req);
        if (audio.length === 0) return json(res, 400, { error: "no audio" });
        const type = String(req.headers["content-type"] || "audio/webm");
        const ext = type.includes("mp4") || type.includes("mp4a")
          ? "mp4"
          : type.includes("wav")
            ? "wav"
            : type.includes("ogg")
              ? "ogg"
              : "webm";
        try {
          const fd = new FormData();
          fd.append("file", new Blob([audio], { type }), `audio.${ext}`);
          fd.append("model", ADVISOR_WHISPER_MODEL);
          const wr = await fetch(ADVISOR_WHISPER_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${ADVISOR_WHISPER_KEY}` },
            body: fd,
          });
          if (!wr.ok) throw new Error(`whisper ${wr.status}`);
          const data = (await wr.json()) as { text?: string };
          const text = (data.text || "").trim();
          log.info("advisor transcription", { chars: text.length }); // metadata only
          return json(res, 200, { text });
        } catch (err) {
          log.warn("advisor transcription failed", {
            err: err instanceof Error ? err.name : "unknown",
          });
          return json(res, 502, { error: "transcription failed" });
        }
      }

      if (method === "POST" && url.pathname === "/chat") {
        const parsed = JSON.parse(await readBody(req)) as {
          message?: string;
          consent?: boolean;
        };
        const message = parsed.message;
        if (!message) return json(res, 400, { error: "message is required" });

        // OpenAI track: rudimentary PII gate. Refuse to forward flagged text
        // without explicit consent — a 409 runs NO turn, so nothing egresses.
        // Private track is FERPA-OK and never checked.
        if (session.mode === "openai") {
          const flags = flagLikelyPrivate(message);
          if (flags.length > 0 && parsed.consent !== true) {
            return json(res, 409, { needsConsent: true, flags });
          }
          if (flags.length > 0) {
            // Override — metadata only, never the flagged content.
            log.info("advisor OpenAI turn sent with PII-flag override", {
              session: session.id,
              categories: flags.map((f) => f.category),
            });
          }
        }

        const controller = new AbortController();
        // Abort the prior turn, then WAIT for it — the same reason /clear waits.
        // A turn past its abort checks still runs its commit step, which does
        // `rm(piSessionRoot)` then `cp(attemptRoot, piSessionRoot)`. Starting the
        // new turn while that runs has it copying FROM a root that is being
        // deleted and rewritten underneath it: ENOENT, or a half-copied
        // conversation committed as history. Double-submitting in the UI reaches
        // this.
        const prior = inFlight.get(session.id);
        if (prior) {
          prior.controller.abort();
          await prior.done;
          if (inFlight.get(session.id) === prior) inFlight.delete(session.id);
        }
        // A closed connection is a stop too — the advisor navigated away and
        // nobody will ever read the answer being paid for.
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });

        const turn = runTurn(session, message, controller.signal);
        const entry: InFlightTurn = {
          controller,
          // Swallowed so awaiting `done` from /clear can never reject there;
          // the real outcome is still awaited below.
          done: turn.then(
            () => undefined,
            () => undefined,
          ),
        };
        inFlight.set(session.id, entry);

        let result: AdvisorTurnResult;
        try {
          result = await turn;
        } finally {
          if (inFlight.get(session.id) === entry) {
            inFlight.delete(session.id);
          }
        }

        // An aborted turn leaves no history, matching what Task 3 does to the
        // Pi conversation: the advisor cancelled, so the half-finished exchange
        // should not become permanent context or show up in an export.
        if (result.outcome !== "aborted") {
          session.history.push({
            role: "advisor",
            text: message,
            at: Date.now(),
          });
          session.history.push({
            role: "agent",
            text: withOutcomeNote(result),
            at: Date.now(),
          });
        }
        return json(res, 200, {
          text: withOutcomeNote(result),
          toolCalls: result.toolCalls,
          outcome: result.outcome,
          // Whether a document exists to download, not the document itself.
          // Prose stays the default; the button only lights up once the agent
          // has actually called propose_schedule.
          schedule: Boolean(session.lastSchedule),
          artifact: session.lastSchedule
            ? {
                kind: "schedule" as const,
                html: renderScheduleGrid(checkedScheduleToView(session.lastSchedule)),
                height: scheduleGridHeightPx(checkedScheduleToView(session.lastSchedule)),
              }
            : undefined,
        });
      }

      if (method === "POST" && url.pathname === "/stop") {
        const entry = inFlight.get(session.id);
        entry?.controller.abort();
        return json(res, 200, { stopped: Boolean(entry) });
      }

      if (method === "POST" && url.pathname === "/clear") {
        // Dispose the ACTIVE track only; the other track is untouched. Abort +
        // WAIT first, as before, so the turn's commit step cannot recreate
        // piSessionRoot after disposal.
        const entry = inFlight.get(session.id);
        if (entry) {
          entry.controller.abort();
          await entry.done;
          inFlight.delete(session.id);
        }
        clearActive(cid);
        log.info("advisor active track cleared", { client: cid });
        return json(res, 200, { cleared: true }); // client id is stable — no Set-Cookie
      }

      if (method === "POST" && url.pathname === "/feedback") {
        const parsed = JSON.parse(await readBody(req)) as {
          description?: string;
          screenshot?: string;
        };
        const description = (parsed.description ?? "").trim();
        if (!description) {
          return json(res, 400, { error: "description is required" });
        }

        // Read the env var fresh (not the module-load-time FEEDBACK_DIR
        // constant): tests set ADVISOR_FEEDBACK_DIR per-run, after this
        // module has already been imported once for the whole suite.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dir = path.join(process.env.ADVISOR_FEEDBACK_DIR || FEEDBACK_DIR, stamp);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "description.txt"), description, "utf8");
        writeFileSync(
          path.join(dir, "meta.json"),
          JSON.stringify(
            { at: new Date().toISOString(), mode: session.mode, advisorId: session.advisorId },
            null,
            2,
          ),
        );

        const screenshot = parsed.screenshot;
        const match = screenshot?.match(
          /^data:image\/(png|jpe?g|webp);base64,(.+)$/,
        );
        if (match) {
          const [, kind, b64] = match;
          const ext = kind === "jpeg" ? "jpg" : kind;
          writeFileSync(
            path.join(dir, `screenshot.${ext}`),
            Buffer.from(b64!, "base64"),
          );
        }

        // Metadata only — never the description or image content.
        log.info("advisor feedback saved", {
          dir: stamp,
          hasImage: Boolean(match),
        });
        return json(res, 200, { saved: true });
      }

      if (method === "POST" && url.pathname === "/mode") {
        const body = JSON.parse(await readBody(req)) as { mode?: string };
        const next = body.mode;
        if (next !== "private" && next !== "openai") {
          return json(res, 400, { error: "mode must be 'private' or 'openai'" });
        }
        lastMode.set(session.advisorId, next);
        const target = switchActive(cid, next); // lazily creates the track; no dispose
        log.info("advisor mode switched", { client: cid, mode: target.mode });
        return json(res, 200, { mode: target.mode });
      }

      if (method === "POST" && url.pathname === "/upload") {
        // basename() keeps the write inside the session's own workDir; a
        // "../../.ssh/authorized_keys" name would otherwise escape it.
        const name = path.basename(
          url.searchParams.get("name") ?? "upload.txt",
        );
        writeFileSync(
          path.join(session.workDir, name),
          await readBody(req),
          "utf8",
        );
        log.info("advisor upload stored", {
          session: session.id,
          bytes: Number(req.headers["content-length"] ?? 0),
        });
        return json(res, 200, { stored: name });
      }

      // The host renders the document, never the agent. The agent's
      // propose_schedule call only supplied the data, and it was validated
      // before it was stored — nothing unvalidated can reach this template.
      if (method === "GET" && url.pathname === "/export/schedule") {
        if (!session.lastSchedule) {
          return json(res, 404, { error: "no schedule has been proposed yet" });
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          // inline, not attachment: the point of the document is that the
          // advisor can look at it and press print.
          "Content-Disposition": 'inline; filename="proposed-schedule.html"',
        });
        return res.end(renderSchedule(session.lastSchedule));
      }

      if (method === "GET" && url.pathname === "/export") {
        const md = session.history
          .map((t) => `## ${t.role}\n\n${t.text}\n`)
          .join("\n");
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": 'attachment; filename="advising-session.md"',
        });
        return res.end(md);
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      // Metadata only, and never the error body — a provider error can quote
      // the prompt back, and the prompt can carry student information.
      log.warn("advisor request failed", {
        path: url.pathname,
        method,
        err: err instanceof Error ? err.name : "unknown",
      });
      if (res.headersSent) return res.end();
      return json(res, 500, { error: "request failed" });
    }
  });
}

export async function startAdvisorServer(): Promise<http.Server> {
  // First, before any work: a non-loopback bind with no password must not get
  // as far as opening a socket.
  assertAdvisorAuthConfig(ADVISOR_PASSWORD, ADVISOR_HTTP_HOST);

  setInterval(
    () => {
      const n = sweepExpired();
      if (n > 0) log.info("advisor sessions swept", { removed: n });
    },
    Math.min(ADVISOR_SESSION_TTL_MS, 15 * 60 * 1000),
  ).unref();

  // Build the MCP bridge ONCE, before accepting requests: per-request
  // construction would pay listTools() latency every turn and churn
  // connections against the MCP servers.
  await initAdvisorTools();
  // Dispose sessions BEFORE closing the tool bridge, and synchronously: these
  // handlers race process exit, and the directories hold JSONL transcripts that
  // can contain student information. KeepAlive=true means restarts are routine,
  // so a handler that only closes the bridge leaks a directory pair per live
  // session per restart, with nothing left running to reap them.
  //
  // The handler must also EXIT. Nothing else here does: the listening socket
  // keeps the loop alive, so a handler that only cleans up leaves a process
  // still serving 8770 with every session disposed and the MCP bridge closed —
  // a zombie that accepts requests it can no longer answer, and that holds the
  // port against the restart launchd is in the middle of performing. Under
  // KeepAlive that presents as an EADDRINUSE restart loop.
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const n = disposeAllSessions();
    if (n > 0) log.info("advisor sessions disposed on shutdown", { count: n });
    void shutdownAdvisorTools();
    // Sessions — the part that matters for student data — are already gone by
    // here, synchronously. The bridge teardown is best-effort, so exit on a
    // short timer rather than waiting on a promise that could hang.
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const server = createAdvisorServer();
  await new Promise<void>((resolve) =>
    // Bind host is configurable (ADVISOR_HTTP_HOST, default 127.0.0.1) so the
    // pilot can serve campus on 0.0.0.0. Anything off loopback is gated by
    // assertAdvisorAuthConfig above: there is still no per-advisor identity
    // behind this door, only the shared password, so the password is what makes
    // widening the bind permissible at all.
    server.listen(ADVISOR_PORT, ADVISOR_HTTP_HOST, resolve),
  );
  log.info("advisor chat listening", {
    port: ADVISOR_PORT,
    host: ADVISOR_HTTP_HOST,
  });
  return server;
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await startAdvisorServer();
