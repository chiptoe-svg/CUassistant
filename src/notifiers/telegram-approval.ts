import { ApprovalGate } from "../approval/gate.js";
import type { ApprovalChannel, PendingSend } from "../approval/types.js";

const BODY_LIMIT = 1500;

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

async function pollLoop(
  api: (m: string) => string,
  cfg: TelegramConfig,
  gate: ApprovalGate,
): Promise<void> {
  let offset = 0;
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
          };
        }>;
      };
      for (const u of data.result ?? []) {
        offset = u.update_id + 1;
        const cq = u.callback_query;
        if (!cq?.data) continue;
        const userId = String(cq.from.id);
        const [verb, requestId] = cq.data.split(":");
        if (verb === "ok") await gate.approve(requestId, userId);
        else if (verb === "no") gate.reject(requestId, userId);
        await fetch(api("answerCallbackQuery"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      }
    } catch (e) {
      process.stderr.write(`[telegram-approval] poll error: ${String(e)}\n`);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
