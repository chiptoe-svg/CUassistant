import { createHash } from "crypto";

import type { SendArtifact } from "./types.js";

export function hashArtifact(a: SendArtifact): string {
  const canonical = JSON.stringify([
    a.account,
    a.to,
    a.cc ?? [],
    a.subject,
    a.body,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function externalRecipients(
  a: SendArtifact,
  internalDomains: string[],
): string[] {
  const internal = internalDomains.map((d) => d.toLowerCase());
  const all = [...a.to, ...(a.cc ?? [])];
  return all.filter((addr) => {
    const domain = addr.split("@")[1]?.toLowerCase() ?? "";
    return !internal.includes(domain);
  });
}
