import { ApprovalGate } from "../approval/gate.js";
import type {
  ApprovalChannel,
  ApprovalStore,
  PendingSend,
} from "../approval/types.js";
import {
  PROBE_TIMEOUT_MS,
  TELEGRAM_PROBE_HOST,
  TELEGRAM_PROBE_PORT,
  makeTcpReachability,
  type Reachability,
} from "./reachability.js";

const BODY_LIMIT = 1500;

/**
 * Consecutive getUpdates failures required before the watchdog will consider
 * restarting. Reaching this alone is NOT sufficient — see
 * shouldRestartAfterPollErrors.
 */
export const MAX_CONSECUTIVE_POLL_ERRORS = 10;

/** Minimum gap between watchdog exits. Bounds churn even if the probe is wrong. */
export const WATCHDOG_COOLDOWN_MS = 3_600_000;

export const BACKOFF_BASE_MS = 3_000;
export const BACKOFF_CAP_MS = 60_000;

/** How stale lastSuccessfulPoll must be before we shout, and the repeat gap. */
export const RECEIVER_DOWN_WARN_MS = 300_000;

/**
 * Whether to exit so launchd restarts the process.
 *
 * A restart only helps when the network is fine and THIS process is broken.
 * During an outage a restart cannot help, and exiting on every outage is what
 * produced 13 restarts in 9 minutes. All three conditions must hold:
 *
 *   1. enough consecutive errors
 *   2. the network is verifiably reachable (probed OUTSIDE fetch)
 *   3. we have not already exited inside the cooldown window
 *
 * (3) is the safety net and does not depend on (2) being correct: worst case
 * is one restart per hour.
 *
 * @param msSinceLastExit null when no watchdog exit has ever been recorded.
 */
export function shouldRestartAfterPollErrors(
  consecutiveErrors: number,
  networkHealthy: boolean,
  msSinceLastExit: number | null,
  threshold: number = MAX_CONSECUTIVE_POLL_ERRORS,
  cooldownMs: number = WATCHDOG_COOLDOWN_MS,
): boolean {
  if (consecutiveErrors < threshold) return false;
  if (!networkHealthy) return false;
  return msSinceLastExit === null || msSinceLastExit >= cooldownMs;
}

/** Exponential backoff: base, doubling, capped. Caller resets on success. */
export function nextBackoffMs(consecutiveErrors: number): number {
  const n = Math.max(1, consecutiveErrors);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** Whether to emit the loud receiver-down line (stale, and not just warned). */
export function shouldWarnReceiverDown(
  msSinceLastSuccess: number,
  msSinceLastWarn: number,
): boolean {
  return (
    msSinceLastSuccess >= RECEIVER_DOWN_WARN_MS &&
    msSinceLastWarn >= RECEIVER_DOWN_WARN_MS
  );
}

/**
 * Emits the RECEIVER DOWN line when warranted and returns the (possibly
 * updated) lastWarn timestamp. Shared by the transport-failure (catch) path
 * and the HTTP-failure path so the staleness check isn't duplicated —
 * neither path updates `lastSuccess` on failure, so this is the only place
 * that decides whether to shout.
 */
export function maybeWarnReceiverDown(
  now: number,
  lastSuccess: number,
  lastWarn: number,
): number {
  if (!shouldWarnReceiverDown(now - lastSuccess, now - lastWarn)) {
    return lastWarn;
  }
  const mins = Math.round((now - lastSuccess) / 60_000);
  process.stderr.write(
    `[telegram-approval] RECEIVER DOWN for ${mins}m — ` +
      `approvals cannot be actioned\n`,
  );
  return now;
}

export function formatApprovalMessage(
  req: PendingSend,
  externals: string[],
): string {
  const a = req.artifact;
  const lines: string[] = [];
  lines.push(`✉️ Approve send (${a.account})  [${req.request_id}]`);
  lines.push(`To: ${a.to.join(", ")}`);
  if (a.cc && a.cc.length) lines.push(`Cc: ${a.cc.join(", ")}`);
  if (externals.length) lines.push(`⚠️ External: ${externals.join(", ")}`);
  lines.push(`Subject: ${a.subject}`);
  lines.push("");
  const body =
    a.body.length > BODY_LIMIT
      ? `${a.body.slice(0, BODY_LIMIT)}\n…(truncated, ${a.body.length} chars total)`
      : a.body;
  lines.push(body);
  return lines.join("\n");
}

// --- I/O shell (integration; constructed only when a bot token is configured) ---

interface TelegramConfig {
  botToken: string;
  authorizedUserId: string;
  internalDomains: string[];
}

/**
 * Builds the ApprovalChannel and starts a long-poll receiver that routes
 * inline-button taps to gate.approve / gate.reject. Only host code holds the
 * bot token; the agent has no path here.
 */
export function startTelegramApproval(
  cfg: TelegramConfig,
  gate: ApprovalGate,
  deps: { reachability?: Reachability; store?: ApprovalStore } = {},
): ApprovalChannel {
  const reachability =
    deps.reachability ??
    makeTcpReachability(
      TELEGRAM_PROBE_HOST,
      TELEGRAM_PROBE_PORT,
      PROBE_TIMEOUT_MS,
    );
  const api = (method: string) =>
    `https://api.telegram.org/bot${cfg.botToken}/${method}`;

  const channel: ApprovalChannel = {
    async post(req, externals) {
      const text = formatApprovalMessage(req, externals);
      const reply_markup = {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `ok:${req.request_id}` },
            { text: "❌ Reject", callback_data: `no:${req.request_id}` },
          ],
        ],
      };
      const r = await fetch(api("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.authorizedUserId,
          text,
          reply_markup,
        }),
      });
      if (!r.ok) throw new Error(`telegram sendMessage ${r.status}`);
    },
  };

  void pollLoop(api, cfg, gate, reachability, deps.store);
  return channel;
}

/** Human label for the message edit + tap toast, given the post-tap status. */
export function approvalOutcomeLabel(status: string | undefined): string {
  switch (status) {
    case "sent":
      return "✅ Approved — sent";
    case "failed":
      return "⚠️ Approved — send failed";
    case "rejected":
      return "❌ Rejected";
    case "expired":
      return "⏰ Expired — no longer actionable";
    default:
      return "No change (not authorized or already resolved)";
  }
}

async function pollLoop(
  api: (m: string) => string,
  cfg: TelegramConfig,
  gate: ApprovalGate,
  reachability: Reachability,
  store: ApprovalStore | undefined,
): Promise<void> {
  let offset = 0;
  let consecutiveErrors = 0;
  let lastSuccess = Date.now();
  let lastWarn = Date.now();
  for (;;) {
    try {
      const r = await fetch(api("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: 25,
          allowed_updates: ["callback_query"],
        }),
        // A hung connection is dropped and retried on a fresh socket rather
        // than wedging the loop. 25s long-poll + 10s slack.
        signal: AbortSignal.timeout(35_000),
      });

      if (!r.ok) {
        // The fetch layer works — this is an application-level failure (a
        // revoked/invalid bot token returning 401, for example) that a
        // restart cannot fix. Do NOT feed consecutiveErrors or the watchdog
        // with it. It is also not success: leave lastSuccess untouched so
        // the receiver-down warning can still fire for a silently dead
        // receiver.
        process.stderr.write(
          `[telegram-approval] getUpdates HTTP ${r.status} — not a ` +
            `transport failure, watchdog state unchanged\n`,
        );
        lastWarn = maybeWarnReceiverDown(Date.now(), lastSuccess, lastWarn);
        await new Promise((res) =>
          setTimeout(res, nextBackoffMs(consecutiveErrors)),
        );
        continue;
      }

      const data = (await r.json()) as {
        result?: Array<{
          update_id: number;
          callback_query?: {
            id: string;
            from: { id: number };
            data?: string;
            message?: {
              message_id: number;
              chat: { id: number };
              text?: string;
            };
          };
        }>;
      };
      // A 2xx getUpdates means the fetch layer AND auth are healthy — clear
      // the watchdog counter.
      consecutiveErrors = 0;
      lastSuccess = Date.now();
      for (const u of data.result ?? []) {
        offset = u.update_id + 1;
        const cq = u.callback_query;
        if (!cq?.data) continue;
        const userId = String(cq.from.id);
        const [verb, requestId] = cq.data.split(":");
        if (verb === "ok") await gate.approve(requestId, userId);
        else if (verb === "no") gate.reject(requestId, userId);

        // Reflect the outcome so the tap has visible effect. A no-op tap
        // (unauthorized, or already resolved) leaves status "pending" and we
        // keep the buttons; a real decision edits the message and drops them.
        const status = gate.getStatus(requestId)?.status;
        const resolved = Boolean(status) && status !== "pending";
        const label = approvalOutcomeLabel(status);
        await fetch(api("answerCallbackQuery"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cq.id, text: label }),
        });
        if (resolved && cq.message) {
          // editMessageText without reply_markup removes the inline keyboard,
          // so the decision can't be tapped again.
          await fetch(api("editMessageText"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: cq.message.chat.id,
              message_id: cq.message.message_id,
              text: `${cq.message.text ?? ""}\n\n${label}`,
            }),
          });
        }
      }
    } catch (e) {
      consecutiveErrors++;
      const now = Date.now();
      process.stderr.write(
        `[telegram-approval] poll error (${consecutiveErrors}): ${String(e)}\n`,
      );

      lastWarn = maybeWarnReceiverDown(now, lastSuccess, lastWarn);

      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        // Probe OUTSIDE fetch. If this said "unreachable" because fetch is
        // wedged, the watchdog would never fire in the case it exists for.
        const healthy = await reachability.check();
        const lastExit = store?.getLastWatchdogExit() ?? null;
        const since = lastExit === null ? null : now - lastExit;
        if (shouldRestartAfterPollErrors(consecutiveErrors, healthy, since)) {
          process.stderr.write(
            `[telegram-approval] ${consecutiveErrors} consecutive poll errors ` +
              `with the network reachable — exiting so launchd restarts the ` +
              `process (clears a stuck fetch state).\n`,
          );
          store?.recordWatchdogExit(now);
          process.exit(1);
        }
        if (!healthy) {
          process.stderr.write(
            `[telegram-approval] network unreachable — NOT restarting ` +
              `(a restart cannot fix an outage); backing off\n`,
          );
        }
      }

      await new Promise((res) =>
        setTimeout(res, nextBackoffMs(consecutiveErrors)),
      );
    }
  }
}
