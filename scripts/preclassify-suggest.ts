// Suggest deterministic preclassifier rule changes from MODE=compare evidence.
//
// This script is intentionally read-only. It reads PRECLASSIFY.md, current
// config/classification.yaml, and state/decisions.jsonl compare rows, then
// prints reviewable YAML snippets and warnings.

import fs from "fs";
import path from "path";

import { CONFIG_DIR, STATE_DIR } from "../src/config.js";
import { loadClassification } from "../src/loaders.js";

interface Args {
  since?: string;
  days: number;
  minEvidence: number;
  limit: number;
}

interface CompareRow {
  ts?: string;
  pass?: string;
  decision?: string;
  sender?: string;
  subject?: string;
  deterministic_source?: string;
  deterministic_needs_task?: boolean | null;
  deterministic_rule_matched?: string | null;
  agent_needs_task?: boolean;
  agent_sort_folder?: string;
  agent_task_title?: string;
  agent_reasoning?: string;
}

interface Group<T> {
  key: string;
  rows: T[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 30, minEvidence: 3, limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") out.since = argv[++i];
    else if (arg === "--days") out.days = Number(argv[++i]);
    else if (arg === "--min-evidence") out.minEvidence = Number(argv[++i]);
    else if (arg === "--limit") out.limit = Number(argv[++i]);
  }
  return out;
}

function cutoffMs(args: Args): number {
  if (args.since) return Date.parse(args.since);
  return Date.now() - args.days * 24 * 60 * 60 * 1000;
}

function readPolicy(): string {
  try {
    return fs.readFileSync(
      path.resolve(process.cwd(), "PRECLASSIFY.md"),
      "utf-8",
    );
  } catch {
    return "";
  }
}

function readCompareRows(args: Args): CompareRow[] {
  const p = path.join(STATE_DIR, "decisions.jsonl");
  if (!fs.existsSync(p)) return [];
  const cutoff = cutoffMs(args);
  const rows: CompareRow[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as CompareRow;
      if (row.pass !== "compare") continue;
      if (row.ts && Date.parse(row.ts) < cutoff) continue;
      rows.push(row);
    } catch {
      /* skip malformed */
    }
  }
  return rows;
}

function senderAddress(sender: string | undefined): string {
  const raw = sender || "";
  return (
    raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0].toLowerCase() ??
    raw.toLowerCase().trim()
  );
}

function senderDomain(sender: string | undefined): string {
  const address = senderAddress(sender);
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

function normalizeSubject(subject: string | undefined): string {
  return (subject || "")
    .toLowerCase()
    .replace(/^(re|fw|fwd):\s*/g, "")
    .replace(/\b\d{1,4}([/-]\d{1,2}){0,2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function subjectNeedle(subject: string | undefined): string {
  const normalized = normalizeSubject(subject);
  if (!normalized) return "";
  const withoutBrackets = normalized
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutBrackets.slice(0, 80);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Array<Group<T>> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const rows = map.get(key) ?? [];
    rows.push(item);
    map.set(key, rows);
  }
  return [...map.entries()]
    .map(([key, rows]) => ({ key, rows }))
    .sort(
      (a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key),
    );
}

function escapeYamlSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

function printHeader(title: string): void {
  console.log();
  console.log(title);
  console.log("-".repeat(title.length));
}

function sample(rows: CompareRow, field: keyof CompareRow): string;
function sample(rows: CompareRow[], field: keyof CompareRow): string;
function sample(
  rows: CompareRow | CompareRow[],
  field: keyof CompareRow,
): string {
  const row = Array.isArray(rows) ? rows[0] : rows;
  const value = row[field];
  return typeof value === "string" ? value : "";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const policy = readPolicy();
  const classification = loadClassification();
  const rows = readCompareRows(args);

  const existingSkipAddresses = new Set(
    classification.skip_senders
      .map((s) => s.from_address?.toLowerCase())
      .filter((s): s is string => Boolean(s)),
  );
  const existingSkipDomains = new Set(
    classification.skip_senders
      .map((s) => s.from_domain?.toLowerCase())
      .filter((s): s is string => Boolean(s)),
  );
  const existingTemplateNames = new Set(
    classification.action_templates.map((t) => t.name),
  );

  console.log(
    `Read ${rows.length} compare row(s) from ${path.join(STATE_DIR, "decisions.jsonl")}`,
  );
  console.log(
    `Policy: ${policy ? "PRECLASSIFY.md loaded" : "PRECLASSIFY.md missing"}`,
  );
  console.log(`Config: ${path.join(CONFIG_DIR, "classification.yaml")}`);
  console.log(`Minimum evidence: ${args.minEvidence}`);

  const agentNeeded = rows.filter(
    (r) =>
      r.decision === "compare-agent-needed" &&
      typeof r.agent_needs_task === "boolean",
  );

  const skipCandidates = groupBy(
    agentNeeded.filter((r) => r.agent_needs_task === false),
    (r) => senderAddress(r.sender),
  )
    .filter((g) => g.rows.length >= args.minEvidence)
    .filter((g) => !existingSkipAddresses.has(g.key))
    .filter((g) => !existingSkipDomains.has(senderDomain(g.key)))
    .slice(0, args.limit);

  printHeader("Suggested skip_senders additions");
  if (skipCandidates.length === 0) {
    console.log(
      "No address-level skip suggestions met the evidence threshold.",
    );
  } else {
    for (const group of skipCandidates) {
      const domain = senderDomain(group.key);
      console.log();
      console.log(
        `# ${group.rows.length} agent no-task decisions; domain=${domain}`,
      );
      console.log(`- from_address: ${group.key}`);
      console.log(`  folder: /noise/review`);
      console.log(
        `  # sample_subject: '${escapeYamlSingleQuoted(sample(group.rows, "subject"))}'`,
      );
      console.log(
        `  # agent_reasoning: '${escapeYamlSingleQuoted(sample(group.rows, "agent_reasoning"))}'`,
      );
    }
  }

  const taskCandidates = groupBy(
    agentNeeded.filter((r) => r.agent_needs_task === true),
    (r) => `${senderAddress(r.sender)}\t${subjectNeedle(r.subject)}`,
  )
    .filter((g) => g.rows.length >= args.minEvidence)
    .slice(0, args.limit);

  printHeader("Suggested action_templates additions");
  if (taskCandidates.length === 0) {
    console.log("No sender+subject task templates met the evidence threshold.");
  } else {
    for (const group of taskCandidates) {
      const [address, needle] = group.key.split("\t");
      const baseName =
        `agent-confirmed-${address.split("@")[0].replace(/[^a-z0-9]+/g, "-")}`.slice(
          0,
          60,
        );
      const name = existingTemplateNames.has(baseName)
        ? `${baseName}-${group.rows.length}x`
        : baseName;
      console.log();
      console.log(`# ${group.rows.length} agent task decisions`);
      console.log(`- name: ${name}`);
      console.log(`  match:`);
      console.log(`    from_address: ${address}`);
      console.log(
        `    subject_contains: ['${escapeYamlSingleQuoted(needle)}']`,
      );
      console.log(`  create_task:`);
      console.log(
        `    title: '${escapeYamlSingleQuoted(sample(group.rows, "agent_task_title") || "Review message")}'`,
      );
      console.log(
        `    folder: '${escapeYamlSingleQuoted(sample(group.rows, "agent_sort_folder") || "/review")}'`,
      );
      console.log(
        `  # agent_reasoning: '${escapeYamlSingleQuoted(sample(group.rows, "agent_reasoning"))}'`,
      );
    }
  }

  const disagreements = rows
    .filter((r) => r.decision === "compare-disagree")
    .slice(0, args.limit);

  printHeader("Rules needing review");
  if (disagreements.length === 0) {
    console.log("No compare-disagree rows found in the selected window.");
  } else {
    for (const row of disagreements) {
      console.log();
      console.log(`- rule: ${row.deterministic_rule_matched ?? "(unknown)"}`);
      console.log(`  sender: ${senderAddress(row.sender)}`);
      console.log(`  subject: '${escapeYamlSingleQuoted(row.subject ?? "")}'`);
      console.log(
        `  deterministic_needs_task: ${String(row.deterministic_needs_task)}`,
      );
      console.log(`  agent_needs_task: ${String(row.agent_needs_task)}`);
      console.log(
        `  agent_reasoning: '${escapeYamlSingleQuoted(row.agent_reasoning ?? "")}'`,
      );
    }
  }
}

main();
