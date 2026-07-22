// Authentication seam for the advisor chat.
//
// Phase 1 is a shared password behind a firewall. The important part is not the
// password — it is that `advisorId` exists in the data model from day one, so
// Phase 2 replaces the body of authenticate() and nothing else. Sessions,
// audit, and export already have somewhere to put a real identity.
//
// Phase 2 is mostly built: src/token-portal.ts already runs Google OAuth2 and
// verifies hd=g.clemson.edu.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import { ADVISOR_PASSWORD } from "./config.js";

export const SESSION_COOKIE = "advisor_sid";

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Constant-time comparison. `expected` defaults to config so tests can inject.
 *
 * FAIL CLOSED: an empty `expected` — the default when ADVISOR_PASSWORD is
 * unset — rejects everything. An unconfigured service must never mean "accept
 * anything"; that is the one failure mode of a shared-password door that can't
 * be noticed by using it.
 *
 * The length check leaks the secret's length. timingSafeEqual throws on
 * unequal-length buffers, so there is no way to avoid it at this layer, and
 * length alone is not a practical attack against a firewalled endpoint.
 */
export function checkPassword(
  supplied: string,
  expected: string = ADVISOR_PASSWORD,
): boolean {
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Phase 1: any request carrying a session cookie is the shared advisor.
 * Phase 2: resolve the real advisor here and return their id.
 *
 * This says only "a cookie is present" — the caller still has to resolve it
 * against the session store, which is what actually proves the cookie was
 * issued by this process.
 */
export function authenticate(
  req: IncomingMessage,
): { advisorId: string } | null {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return sid ? { advisorId: "shared" } : null;
}
