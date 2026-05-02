// Cost report — reads state/usage.jsonl, groups records, prints totals.
//
//   npm run cost-report                       # all-time totals
//   npm run cost-report -- --since 2026-04-01 # since a date
//   npm run cost-report -- --by mode          # group by mode (default day)
//   npm run cost-report -- --by model
//   npm run cost-report -- --simulate-mode agent
//
// `--simulate-mode agent` answers "what would the LLM bill have been if
// every scanned email had gone through the full agent?" by extrapolating
// observed per-email token rates from MODE=agent runs onto the total scan
// volume in shortcut modes such as MODE=hybrid.

import { readUsageRecords } from "../src/state.js";
import { computeCostUsd } from "../src/pricing.js";
import type { ScanMode } from "../src/types.js";

interface Record {
  ts: string;
  scan_run_id: string;
  email_ids: string[];
  mode: ScanMode;
  caller: "codex" | "openai";
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  latency_ms: number;
  cost_usd: number;
}

interface Args {
  since?: string;
  by: "mode" | "model" | "day";
  simulateMode?: ScanMode;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { by: "day" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") out.since = argv[++i];
    else if (a === "--by") out.by = argv[++i] as "mode" | "model" | "day";
    else if (a === "--simulate-mode") out.simulateMode = argv[++i] as ScanMode;
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function dollar(n: number): string {
  return "$" + n.toFixed(4);
}

interface Bucket {
  calls: number;
  emailCount: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

function emptyBucket(): Bucket {
  return {
    calls: 0,
    emailCount: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function add(b: Bucket, r: Record): void {
  b.calls += 1;
  b.emailCount += r.email_ids.length;
  b.inputTokens += r.input_tokens;
  b.cachedTokens += r.cached_input_tokens;
  b.outputTokens += r.output_tokens;
  b.costUsd += r.cost_usd;
}

function keyFor(r: Record, by: Args["by"]): string {
  if (by === "mode") return r.mode;
  if (by === "model") return r.model;
  return r.ts.slice(0, 10);
}

function table(buckets: Map<string, Bucket>, label: string): void {
  const keys = [...buckets.keys()].sort();
  const w = Math.max(label.length, ...keys.map((k) => k.length));
  console.log();
  console.log(
    `${label.padEnd(w)}  calls  emails       input    cached      output       cost`,
  );
  console.log("-".repeat(w + 70));
  let totals = emptyBucket();
  for (const k of keys) {
    const b = buckets.get(k)!;
    console.log(
      `${k.padEnd(w)}  ${String(b.calls).padStart(5)}  ${String(b.emailCount).padStart(6)}  ${fmt(b.inputTokens).padStart(10)}  ${fmt(b.cachedTokens).padStart(8)}  ${fmt(b.outputTokens).padStart(10)}  ${dollar(b.costUsd).padStart(9)}`,
    );
    totals.calls += b.calls;
    totals.emailCount += b.emailCount;
    totals.inputTokens += b.inputTokens;
    totals.cachedTokens += b.cachedTokens;
    totals.outputTokens += b.outputTokens;
    totals.costUsd += b.costUsd;
  }
  console.log("-".repeat(w + 70));
  console.log(
    `${"total".padEnd(w)}  ${String(totals.calls).padStart(5)}  ${String(totals.emailCount).padStart(6)}  ${fmt(totals.inputTokens).padStart(10)}  ${fmt(totals.cachedTokens).padStart(8)}  ${fmt(totals.outputTokens).padStart(10)}  ${dollar(totals.costUsd).padStart(9)}`,
  );
}

function simulate(records: Record[], targetMode: Args["simulateMode"]): void {
  if (!targetMode) return;
  const reference = records.filter((r) => r.mode === targetMode);
  if (reference.length === 0) {
    console.log(
      `\n[simulate] no MODE=${targetMode} runs in the data — can't extrapolate.`,
    );
    return;
  }
  const refEmails = reference.reduce((a, r) => a + r.email_ids.length, 0);
  const refInput = reference.reduce((a, r) => a + r.input_tokens, 0);
  const refCached = reference.reduce((a, r) => a + r.cached_input_tokens, 0);
  const refOutput = reference.reduce((a, r) => a + r.output_tokens, 0);
  const inputPer = refInput / refEmails;
  const cachedPer = refCached / refEmails;
  const outputPer = refOutput / refEmails;
  const refModel = reference[0].model;

  const totalEmails = new Set<string>();
  for (const r of records) for (const id of r.email_ids) totalEmails.add(id);
  const projectedInput = Math.round(inputPer * totalEmails.size);
  const projectedCached = Math.round(cachedPer * totalEmails.size);
  const projectedOutput = Math.round(outputPer * totalEmails.size);
  const projectedCost = computeCostUsd(refModel, {
    input_tokens: projectedInput,
    cached_input_tokens: projectedCached,
    output_tokens: projectedOutput,
  });
  const actualCost = records.reduce((a, r) => a + r.cost_usd, 0);
  console.log(
    `\n[simulate] If every email (${totalEmails.size}) had gone through MODE=${targetMode} (model=${refModel}):`,
  );
  console.log(
    `  Projected: ${fmt(projectedInput)} in / ${fmt(projectedCached)} cached / ${fmt(projectedOutput)} out  ${dollar(projectedCost)}`,
  );
  console.log(`  Actual:    ${dollar(actualCost)}`);
  const delta = projectedCost - actualCost;
  if (delta > 0)
    console.log(
      `  Savings:   ${dollar(delta)} (${((delta / projectedCost) * 100).toFixed(1)}%)`,
    );
  else
    console.log(
      `  Difference: ${dollar(-delta)} (actual was higher than the simulated baseline — unusual)`,
    );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = readUsageRecords(args.since) as Record[];
  if (all.length === 0) {
    console.log("No usage records yet. Run a scan first.");
    return;
  }
  console.log(
    `Read ${all.length} usage record(s)${args.since ? ` since ${args.since}` : ""} from state/usage.jsonl`,
  );
  const buckets = new Map<string, Bucket>();
  for (const r of all) {
    const k = keyFor(r, args.by);
    let b = buckets.get(k);
    if (!b) {
      b = emptyBucket();
      buckets.set(k, b);
    }
    add(b, r);
  }
  table(buckets, args.by);
  simulate(all, args.simulateMode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
