// Verify the local audit trail (state/decisions.jsonl). Exits non-zero on any
// integrity problem. NOTE: the authoritative audit for Graph actions is M365's
// unified audit log — this only checks the local convenience trail.

import fs from "fs";
import path from "path";

import { STATE_DIR } from "../src/config.js";
import { verifyAuditLines } from "../src/audit-verify.js";

const p = path.join(STATE_DIR, "decisions.jsonl");
if (!fs.existsSync(p)) {
  console.log(`No audit log at ${p} (nothing to verify).`);
  process.exit(0);
}
const lines = fs.readFileSync(p, "utf-8").split("\n");
const r = verifyAuditLines(lines);

console.log(`Audit log: ${p}`);
console.log(`  entries:        ${r.count}`);
console.log(`  range:          ${r.firstTs ?? "—"} … ${r.lastTs ?? "—"}`);
console.log(`  parse errors:   ${r.parseErrors.length}`);
console.log(`  ts regressions: ${r.tsRegressions}`);
for (const e of r.parseErrors) {
  console.log(`    line ${e.line}: ${e.reason}`);
}
if (r.ok) {
  console.log("OK — local trail is well-formed and chronologically ordered.");
  process.exit(0);
}
console.error(
  "INTEGRITY WARNING — the local trail looks corrupted or reordered. " +
    "Cross-check against the M365 unified audit log (the authoritative record).",
);
process.exit(1);
