// Gmail "folders" = labels, via the `gws` CLI (same invocation pattern as
// src/gmail.ts / gws-sender.ts). Nested labels use "/" separators, so a Gmail
// label name IS a path and maps directly onto the subtree allow-list. "Move"
// is: add the destination label + remove INBOX (archive into the label).

import { execFileSync } from "child_process";

import { buildChildEnv } from "../child-env.js";
import { GWS_BIN } from "../config.js";
import { log } from "../log.js";
import { normalizeMailPath } from "../mail-paths.js";

export interface GmailLabel {
  id: string;
  path: string;
}

/** If gws returned an error envelope (it can exit 0 with `{error:…}`), the
 *  message; else null. Lets callers fail loud (e.g. auth/invalid_grant) instead
 *  of mistaking an error for "no labels". */
export function gwsResponseError(json: string): string | null {
  try {
    const d = JSON.parse(json) as { error?: { message?: string } | string };
    if (d && d.error) {
      return typeof d.error === "string"
        ? d.error
        : (d.error.message ?? "gws error");
    }
  } catch {
    /* not JSON — treat as no structured error */
  }
  return null;
}

/** Parse `users labels list` output, keeping only user labels (name = path). */
export function parseGmailLabels(json: string): GmailLabel[] {
  let parsed: { labels?: Array<{ id?: string; name?: string; type?: string }> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return (parsed.labels ?? [])
    .filter(
      (l): l is { id: string; name: string; type: string } =>
        !!l &&
        typeof l.id === "string" &&
        typeof l.name === "string" &&
        l.type === "user",
    )
    .map((l) => ({ id: l.id, path: l.name }));
}

function gws(args: string[], timeoutMs = 15_000): string | null {
  if (!GWS_BIN) return null;
  try {
    return execFileSync(GWS_BIN, args, {
      encoding: "utf-8",
      env: buildChildEnv({ GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    log.debug("gws call failed", { verb: args.slice(0, 4), err: String(err) });
    return null;
  }
}

/** All Gmail user labels as {id, path}. null if gws is unavailable/errored
 *  (e.g. auth/invalid_grant) so the tool can surface a real failure. */
export function listGmailLabels(): GmailLabel[] | null {
  const out = gws([
    "gmail",
    "users",
    "labels",
    "list",
    "--params",
    JSON.stringify({ userId: "me" }),
    "--format",
    "json",
  ]);
  if (out === null) return null;
  const e = gwsResponseError(out);
  if (e) {
    log.warn("gws labels list error", { error: e });
    return null;
  }
  return parseGmailLabels(out);
}

/** Resolve a label path (e.g. "sorted/News") to its Gmail label id. */
export function resolveGmailLabelByPath(path: string): string | null {
  const labels = listGmailLabels();
  if (!labels) return null;
  const target = normalizeMailPath(path).toLowerCase();
  return (
    labels.find((l) => normalizeMailPath(l.path).toLowerCase() === target)
      ?.id ?? null
  );
}

// --- Gmail message + attachment reading ---

export interface GmailAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

function walkParts(
  parts: GmailPart[],
  acc: { body: string | null; attachments: GmailAttachmentMeta[] },
): void {
  for (const part of parts) {
    if (part.parts) {
      walkParts(part.parts, acc);
      continue;
    }
    const mime = part.mimeType ?? "";
    const filename = part.filename ?? "";
    const attachmentId = part.body?.attachmentId;
    if (filename && attachmentId) {
      acc.attachments.push({
        id: attachmentId,
        name: filename,
        contentType: mime || "application/octet-stream",
        size: part.body?.size ?? 0,
      });
    } else if (
      acc.body === null &&
      (mime === "text/plain" || mime === "text/html")
    ) {
      const raw = part.body?.data ?? "";
      acc.body = Buffer.from(
        raw.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf-8");
    }
  }
}

/** Fetch a Gmail message (full format) and return subject, body text, and
 *  attachment metadata.  Body is decoded from base64url to UTF-8; attachment
 *  bytes are NOT fetched — call getGmailAttachment() with the part id. */
export function getGmailMessage(messageId: string): {
  id: string;
  subject: string;
  body: string;
  hasAttachments: boolean;
  attachments: GmailAttachmentMeta[];
} | null {
  const out = gws(
    [
      "gmail",
      "users",
      "messages",
      "get",
      "--params",
      JSON.stringify({ userId: "me", id: messageId, format: "full" }),
      "--format",
      "json",
    ],
    20_000,
  );
  if (out === null) return null;
  const e = gwsResponseError(out);
  if (e) {
    log.warn("gws message get error", { error: e, messageId });
    return null;
  }
  let msg: {
    id?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      mimeType?: string;
      parts?: GmailPart[];
    };
  };
  try {
    msg = JSON.parse(out);
  } catch {
    return null;
  }
  const subject =
    (msg.payload?.headers ?? []).find(
      (h) => h.name.toLowerCase() === "subject",
    )?.value ?? "";
  const acc: { body: string | null; attachments: GmailAttachmentMeta[] } = {
    body: null,
    attachments: [],
  };
  if (msg.payload?.parts) {
    walkParts(msg.payload.parts, acc);
  } else if (msg.payload?.body?.data) {
    const raw = msg.payload.body.data;
    acc.body = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
  }
  return {
    id: msg.id ?? messageId,
    subject,
    body: acc.body ?? "",
    hasAttachments: acc.attachments.length > 0,
    attachments: acc.attachments,
  };
}

/** Download a Gmail attachment by message id and attachment id.  Returns size
 *  and contentBytes (standard base64).  Name and contentType are not available
 *  from the Gmail attachments API — read them from get-mail-message's
 *  attachments array. */
export function getGmailAttachment(
  messageId: string,
  attachmentId: string,
): { id: string; size: number; contentBytes: string } | null {
  const out = gws(
    [
      "gmail",
      "users",
      "messages",
      "attachments",
      "get",
      "--params",
      JSON.stringify({ userId: "me", messageId, id: attachmentId }),
      "--format",
      "json",
    ],
    30_000,
  );
  if (out === null) return null;
  const e = gwsResponseError(out);
  if (e) {
    log.warn("gws attachment get error", { error: e, messageId, attachmentId });
    return null;
  }
  let att: { size?: number; data?: string };
  try {
    att = JSON.parse(out);
  } catch {
    return null;
  }
  // Gmail returns base64url; normalize to standard base64 for consistency with MS365
  const contentBytes = (att.data ?? "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return { id: attachmentId, size: att.size ?? 0, contentBytes };
}

/** Move = apply the destination label and archive from the inbox. */
export function moveGmailMessage(id: string, labelId: string): boolean {
  const out = gws(
    [
      "gmail",
      "users",
      "messages",
      "modify",
      "--params",
      JSON.stringify({
        userId: "me",
        id,
        addLabelIds: [labelId],
        removeLabelIds: ["INBOX"],
      }),
      "--format",
      "json",
    ],
    20_000,
  );
  return out !== null && gwsResponseError(out) === null;
}
