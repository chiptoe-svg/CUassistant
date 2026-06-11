import { ApprovalGate } from "../approval/gate.js";
import type { ApprovalChannel, PendingSend } from "../approval/types.js";

const BODY_LIMIT = 1500;

/**
 * Consecutive getUpdates failures after which the poll loop exits so launchd's
 * keepalive restarts the process. The poll loop retries the SAME fetch on each
 * error; if the process's fetch layer is wedged (stale DNS/connections after a
 * sleep/wake or network change), it never self-heals. A fresh process does.
 * 10 errors at a 3s backoff is ~30s+ of solid failure, so a transient blip
 * won't trip it.
 */
export const MAX_CONSECUTIVE_POLL_ERRORS = 10;

/** Whether the poll loop has hit enough consecutive errors to warrant a restart. */
export function shouldRestartAfterPollErrors(
  consecutiveErrors: number,
  threshold: number = MAX_CONSECUTIVE_POLL_ERRORS,
): boolean {
  return consecutiveErrors >= threshold;
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
): ApprovalChannel {
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

  void pollLoop(api, cfg, gate);
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
): Promise<void> {
  let offset = 0;
  let consecutiveErrors = 0;
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
      });
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
      // A successful getUpdates means the fetch layer is healthy — clear the
      // watchdog counter.
      consecutiveErrors = 0;
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
      process.stderr.write(
        `[telegram-approval] poll error (${consecutiveErrors}): ${String(e)}\n`,
      );
      if (shouldRestartAfterPollErrors(consecutiveErrors)) {
        process.stderr.write(
          `[telegram-approval] ${consecutiveErrors} consecutive poll errors — ` +
            `exiting so launchd restarts the process (clears a stuck fetch state).\n`,
        );
        process.exit(1);
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
