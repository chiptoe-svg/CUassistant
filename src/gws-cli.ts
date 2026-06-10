// Shared runner for the `gws` Google Workspace CLI. Mirrors src/gmail.ts:
// execFileSync + buildChildEnv, so the host's MS365/OpenAI secrets are never
// inherited (gws uses its own credential store). gws can fail two ways — a
// non-zero exit, or exit 0 with an `{ "error": … }` JSON envelope (e.g. an
// auth/invalid_grant) — so callers must check gwsResponseError on success too.

import { execFileSync } from "child_process";

import { buildChildEnv } from "./child-env.js";
import { GWS_BIN } from "./config.js";
import { log } from "./log.js";

export function runGws(args: string[], timeoutMs = 20_000): string | null {
  if (!GWS_BIN) return null;
  try {
    return execFileSync(GWS_BIN, args, {
      encoding: "utf-8",
      env: buildChildEnv({ GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    log.debug("gws call failed", { verb: args.slice(0, 3), err: String(err) });
    return null;
  }
}

/** Returns the error message if gws emitted an `{error}` envelope, else null. */
export function gwsResponseError(json: string): string | null {
  try {
    const d = JSON.parse(json) as { error?: { message?: string } | string };
    if (d && d.error) {
      return typeof d.error === "string"
        ? d.error
        : (d.error.message ?? "gws error");
    }
  } catch {
    /* not JSON — no structured error */
  }
  return null;
}
