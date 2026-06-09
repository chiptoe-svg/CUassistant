// Local audit-trail verifier for state/decisions.jsonl.
//
// IMPORTANT: this checks the *local convenience* trail. The authoritative,
// tamper-resistant audit for Graph actions is Microsoft 365's own unified audit
// log — every call carries the delegated user identity, so it is recorded
// tenant-side regardless of what happens to this file. This verifier catches
// accidental corruption and obvious tampering (unparseable lines, a timestamp
// that goes backwards) in the local trail; it is not a cryptographic integrity
// guarantee against a same-uid attacker (only off-host shipping would be).

export interface AuditParseError {
  line: number;
  reason: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  count: number;
  parseErrors: AuditParseError[];
  /** Count of entries whose ts is earlier than a preceding entry's ts. */
  tsRegressions: number;
  firstTs: string | null;
  lastTs: string | null;
}

/** Verify append-only audit lines (one JSON object per line; blanks ignored). */
export function verifyAuditLines(lines: string[]): AuditVerifyResult {
  const parseErrors: AuditParseError[] = [];
  let count = 0;
  let tsRegressions = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let prevMs = -Infinity;

  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    let entry: { ts?: string };
    try {
      entry = JSON.parse(raw) as { ts?: string };
    } catch {
      parseErrors.push({ line: i + 1, reason: "unparseable JSON" });
      return;
    }
    count += 1;
    if (typeof entry.ts === "string") {
      const ms = Date.parse(entry.ts);
      if (!Number.isNaN(ms)) {
        if (firstTs === null) firstTs = entry.ts;
        lastTs = entry.ts;
        if (ms < prevMs) tsRegressions += 1;
        prevMs = ms;
      }
    }
  });

  return {
    ok: parseErrors.length === 0 && tsRegressions === 0,
    count,
    parseErrors,
    tsRegressions,
    firstTs,
    lastTs,
  };
}
