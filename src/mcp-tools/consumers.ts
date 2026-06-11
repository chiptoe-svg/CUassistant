// Per-agent credential registry for the credentialed MCP HTTP server.
//
// Each authorized agent (a NanoClaw group, etc.) is provisioned its OWN bearer
// token via `npm run mcp:pair -- --id <agent>`. Only the SHA-256 hash of each
// token is stored, in state/mcp-consumers.json. The server accepts a request
// only if the presented bearer hashes to a registered consumer; the matched
// consumer id becomes the audit identity. Grant = add an entry + inject the
// token into that one container; revoke = remove the entry. There is NO shared
// global secret, so an un-provisioned agent on the same host has no access.
//
// Tokens do not expire (an expiry timer would silently sever the connection —
// the failure mode an mTLS cert would introduce). Lifecycle is instead managed
// by explicit revoke + staleness reporting (`staleConsumers`): created_at and
// last_seen_at make stale/unused tokens visible without breaking anything.

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { STATE_DIR } from "../config.js";

export interface Consumer {
  /** Stable agent identifier, e.g. "nanoclaw-personal". Used as the audit id. */
  id: string;
  /** sha256 hex of the bearer token. The raw token is never stored. */
  token_hash: string;
  /** ISO timestamp the token was minted. */
  created_at: string;
  /** ISO timestamp the token was last accepted, when tracked. */
  last_seen_at?: string;
  /** Free-text operator note (e.g. what the agent is for). */
  note?: string;
  /** Attested model-backend provider (e.g. "chatgpt_edu"). Absent = unattested. */
  provider?: string;
  /** Capability scope tokens (see SCOPE_OPERATIONS); absent/empty = full access. */
  scopes?: string[];
}

const REGISTRY_PATH = (): string => path.join(STATE_DIR, "mcp-consumers.json");
const DAY_MS = 86_400_000;

/** sha256 hex digest of a token. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf-8").digest("hex");
}

/** Mint a high-entropy, prefixed bearer token. */
export function generateToken(): string {
  return `cma_${crypto.randomBytes(32).toString("base64url")}`;
}

/** Parse a registry document, dropping entries that lack id or token_hash. */
export function parseConsumers(raw: string): Consumer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { consumers?: unknown[] })?.consumers ?? []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is Consumer =>
      !!c &&
      typeof (c as Consumer).id === "string" &&
      typeof (c as Consumer).token_hash === "string",
  );
}

/** Load the on-disk registry (empty when the file is absent or unreadable). */
export function loadConsumers(): Consumer[] {
  try {
    return parseConsumers(fs.readFileSync(REGISTRY_PATH(), "utf-8"));
  } catch {
    return [];
  }
}

/** Persist the registry with owner-only permissions. */
export function saveConsumers(consumers: Consumer[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    REGISTRY_PATH(),
    JSON.stringify({ consumers }, null, 2) + "\n",
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(REGISTRY_PATH(), 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * Constant-time match of a presented `Authorization` header against the
 * registry. Returns the matched Consumer, or null. Compares fixed-length hex
 * digests so the comparison leaks neither the token nor its length.
 *
 * The returned object is a live reference into the caller's `consumers` array —
 * read it, do not mutate it. Persisted changes go through loadConsumers ->
 * mutate -> saveConsumers (see recordSeen / attestConsumer).
 */
export function authenticateConsumer(
  authHeader: string | undefined,
  consumers: Consumer[],
): Consumer | null {
  const prefix = "Bearer ";
  if (!authHeader || !authHeader.startsWith(prefix)) return null;
  const got = Buffer.from(hashToken(authHeader.slice(prefix.length)));
  for (const c of consumers) {
    const exp = Buffer.from(c.token_hash);
    if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) {
      return c;
    }
  }
  return null;
}

/** Backward-compatible: returns just the matched consumer id, or null. */
export function authenticateBearer(
  authHeader: string | undefined,
  consumers: Consumer[],
): string | null {
  return authenticateConsumer(authHeader, consumers)?.id ?? null;
}

/** Update a consumer's last_seen_at (best effort; no-op for unknown ids). */
export function recordSeen(id: string, nowIso: string): void {
  try {
    const list = loadConsumers();
    const c = list.find((x) => x.id === id);
    if (!c) return; // e.g. the synthetic "env-token" is not on disk
    c.last_seen_at = nowIso;
    saveConsumers(list);
  } catch {
    /* best effort */
  }
}

/**
 * Set a consumer's attested provider (and optionally scopes) IN PLACE, without
 * touching its token_hash or last_seen_at. Mutates and returns the list.
 * Throws if the id is not present. This backs `mcp:consumers --attest`.
 */
export function attestConsumer(
  consumers: Consumer[],
  id: string,
  provider: string,
  scopes?: string[],
): Consumer[] {
  const c = consumers.find((x) => x.id === id);
  if (!c) throw new Error(`No consumer "${id}" found.`);
  c.provider = provider;
  if (scopes !== undefined) c.scopes = scopes;
  return consumers;
}

export interface StaleOptions {
  nowMs: number;
  /** Flag tokens minted more than this many days ago. */
  maxAgeDays: number;
  /** Flag tokens not used within this many days (never-seen counts from created_at). */
  maxIdleDays: number;
}

export interface StaleConsumer {
  id: string;
  reason: "age" | "idle";
  ageDays: number;
  idleDays: number;
}

/**
 * Report tokens worth rotating/revoking: too old, or unused too long. This is
 * the warn-don't-break form of "expiry alerting" — it never rejects a token,
 * it only surfaces staleness for a deliberate rotation decision.
 */
export function staleConsumers(
  consumers: Consumer[],
  opts: StaleOptions,
): StaleConsumer[] {
  const out: StaleConsumer[] = [];
  for (const c of consumers) {
    const created = Date.parse(c.created_at);
    const lastSeen = c.last_seen_at ? Date.parse(c.last_seen_at) : created;
    const ageDays = Number.isNaN(created)
      ? 0
      : Math.floor((opts.nowMs - created) / DAY_MS);
    const idleDays = Number.isNaN(lastSeen)
      ? 0
      : Math.floor((opts.nowMs - lastSeen) / DAY_MS);
    if (ageDays > opts.maxAgeDays) {
      out.push({ id: c.id, reason: "age", ageDays, idleDays });
    } else if (idleDays > opts.maxIdleDays) {
      out.push({ id: c.id, reason: "idle", ageDays, idleDays });
    }
  }
  return out;
}
