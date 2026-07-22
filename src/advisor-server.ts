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
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADVISOR_PASSWORD,
  ADVISOR_PORT,
  ADVISOR_SESSION_TTL_MS,
} from "./config.js";
import { log } from "./log.js";
import {
  SESSION_COOKIE,
  authenticate,
  checkPassword,
  parseCookies,
} from "./advisor-auth.js";
import {
  clearSession,
  createSession,
  disposeAllSessions,
  getSession,
  sweepExpired,
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

const MAX_BODY_BYTES = 5_000_000;

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

function html(res: http.ServerResponse, status: number, page: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * The UI has one text channel for the answer, so a turn that did NOT finish has
 * to say so inside it. Rendering a truncated answer as a final one is exactly
 * what AdvisorTurnResult's outcome field exists to prevent.
 */
const OUTCOME_NOTE: Record<Exclude<AdvisorTurnResult["outcome"], "complete">, string> = {
  aborted: "[Stopped — this answer is partial.]",
  round_cap: "[The tool-round limit was reached — this answer is partial.]",
  timeout: "[This turn ran out of time — this answer is partial.]",
  // The text is a tool call rendered as prose, not an answer, so unlike the
  // other outcomes it is suppressed entirely rather than annotated. Showing it
  // invites the advisor to read invented prose as a sourced answer — the exact
  // failure this outcome exists to prevent.
  malformed_tool_call:
    "[The model service returned a malformed response and this turn produced no answer. Please try again; if it repeats, the model server needs to be restarted.]",
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

export function createAdvisorServer(
  deps: { runTurn?: RunTurn } = {},
): http.Server {
  const runTurn = deps.runTurn ?? runAdvisorTurn;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && url.pathname === "/") {
        const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        // Resolve against the store, not just the cookie's presence: an
        // expired or forged cookie must land back on the login page rather
        // than on a chat window whose every request 401s.
        return getSession(sid)
          ? html(res, 200, renderChatPage())
          : html(res, 200, renderLoginPage());
      }

      if (method === "POST" && url.pathname === "/login") {
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
        const session = createSession("shared");
        log.info("advisor login", { session: session.id });
        res.writeHead(302, {
          Location: "/",
          "Set-Cookie": sessionCookie(session.id),
        });
        return res.end();
      }

      const auth = authenticate(req);
      if (!auth) return json(res, 401, { error: "not authenticated" });
      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const session = getSession(sid);
      if (!session) return json(res, 401, { error: "session expired" });

      if (method === "POST" && url.pathname === "/chat") {
        const parsed = JSON.parse(await readBody(req)) as { message?: string };
        const message = parsed.message;
        if (!message) return json(res, 400, { error: "message is required" });

        const controller = new AbortController();
        inFlight.get(session.id)?.controller.abort();
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
        });
      }

      if (method === "POST" && url.pathname === "/stop") {
        const entry = inFlight.get(session.id);
        entry?.controller.abort();
        return json(res, 200, { stopped: Boolean(entry) });
      }

      if (method === "POST" && url.pathname === "/clear") {
        // Abort, then WAIT. A turn that is past its abort check still has to
        // run its commit step, and that step recreates piSessionRoot. Clearing
        // before it finishes leaves a transcript directory behind that no
        // sweeper knows about, because the session is already out of the map.
        const entry = inFlight.get(session.id);
        if (entry) {
          entry.controller.abort();
          await entry.done;
          inFlight.delete(session.id);
        }
        clearSession(session.id);
        const fresh = createSession(session.advisorId);
        log.info("advisor session cleared", { session: fresh.id });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": sessionCookie(fresh.id),
        });
        return res.end(JSON.stringify({ cleared: true }));
      }

      if (method === "POST" && url.pathname === "/upload") {
        // basename() keeps the write inside the session's own workDir; a
        // "../../.ssh/authorized_keys" name would otherwise escape it.
        const name = path.basename(url.searchParams.get("name") ?? "upload.txt");
        writeFileSync(path.join(session.workDir, name), await readBody(req), "utf8");
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
  const onSignal = () => {
    const n = disposeAllSessions();
    if (n > 0) log.info("advisor sessions disposed on shutdown", { count: n });
    void shutdownAdvisorTools();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const server = createAdvisorServer();
  await new Promise<void>((resolve) =>
    // 127.0.0.1 only. There is no per-advisor identity behind this door yet,
    // so the network boundary is doing real work.
    server.listen(ADVISOR_PORT, "127.0.0.1", resolve),
  );
  log.info("advisor chat listening", { port: ADVISOR_PORT });
  return server;
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await startAdvisorServer();
