// Gmail send backend via the `gws` CLI. The actual send is host-invoked only —
// the agent never reaches this. Uses buildChildEnv so the subprocess does not
// inherit host secrets (see src/child-env.ts).
import { execFileSync } from "child_process";

import { buildChildEnv } from "../child-env.js";
import { GWS_BIN } from "../config.js";
import type { SendArtifact, SentResult } from "./types.js";

export async function gwsSend(a: SendArtifact): Promise<SentResult> {
  if (!GWS_BIN) throw new Error("gws not configured (GWS_BIN unset)");

  // `gws gmail +send` takes named flags, not a --params JSON blob.
  // Shape verified from: gws gmail +send --help
  const argv: string[] = [
    "gmail",
    "+send",
    "--to",
    a.to.join(","),
    "--subject",
    a.subject,
    "--body",
    a.body,
    "--format",
    "json",
  ];
  if (a.cc && a.cc.length > 0) {
    argv.push("--cc", a.cc.join(","));
  }

  const out = execFileSync(GWS_BIN, argv, {
    encoding: "utf-8",
    env: buildChildEnv({ GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" }),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const parsed = JSON.parse(out) as { id?: string };
  return { id: parsed.id ?? "sent" };
}
