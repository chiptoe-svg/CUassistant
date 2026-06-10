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
