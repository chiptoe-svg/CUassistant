import { DRY_RUN, MODE } from "./config.js";
import { readUsageRecords } from "./state.js";
import { ApiOutcome, CompareOutcome, ScanOutcome } from "./types.js";

function summarizeRunUsage(scanRunId: string): {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
} | null {
  const records = readUsageRecords();
  const mine = records.filter((r) => r.scan_run_id === scanRunId);
  if (mine.length === 0) return null;
  return {
    calls: mine.length,
    inputTokens: mine.reduce((a, r) => a + r.input_tokens, 0),
    cachedTokens: mine.reduce((a, r) => a + r.cached_input_tokens, 0),
    outputTokens: mine.reduce((a, r) => a + r.output_tokens, 0),
    costUsd: mine.reduce((a, r) => a + r.cost_usd, 0),
  };
}

export function formatSummary(
  o: ScanOutcome,
  api: ApiOutcome | null,
  scanRunId: string,
  compare?: CompareOutcome,
): string {
  if (o.scanned === 0) {
    const parts = ["No new mail since last scan."];
    if (o.errors.length > 0) {
      parts.push("", "Errors:");
      for (const e of o.errors.slice(0, 5)) parts.push(`  * ${e}`);
    }
    return parts.join("\n");
  }
  const preResolved = o.template_tasks + o.template_skips + o.skip_sender_count;
  const totalTasks = o.template_tasks + (api?.apiTaskCount ?? 0);
  const parts = [
    `Email Taskfinder - ${o.scan_run_id}${DRY_RUN ? " [dry-run]" : ""}`,
    "",
    `Scanned: ${o.scanned}   Tasks created: ${totalTasks}`,
    `Pre-resolved: ${preResolved}  (templated->task=${o.template_tasks}, templated->skip=${o.template_skips}, skip-rule=${o.skip_sender_count})`,
  ];
  if (compare) {
    parts.push(
      `Compare mode: agent task=${compare.agentTaskCount}, agent skip=${compare.agentSkipCount}, missing=${compare.missingAgentCount}`,
      `Prefilter baseline: task=${compare.deterministicTaskCount}, skip=${compare.deterministicSkipCount}, agent-needed=${compare.deterministicAgentNeededCount}`,
      `Prefilter vs agent: agree=${compare.agreementCount}, disagree=${compare.disagreementCount}`,
    );
  }
  if (api) {
    parts.push(
      `LLM-classified: ${o.llm_candidates.length}  (task=${api.apiTaskCount}, skip=${api.apiSkipCount}${api.apiFailureCount ? `, failed=${api.apiFailureCount}` : ""})`,
    );
    const u = summarizeRunUsage(scanRunId);
    if (u) {
      const fmt = (n: number) => n.toLocaleString("en-US");
      parts.push(
        `LLM cost [${MODE}]: $${u.costUsd.toFixed(4)} (${u.calls} call${u.calls === 1 ? "" : "s"}, ${fmt(u.inputTokens)} in${u.cachedTokens ? ` / ${fmt(u.cachedTokens)} cached` : ""}, ${fmt(u.outputTokens)} out)`,
      );
    }
    if (api.tasksCreated.length > 0) {
      parts.push("");
      for (const t of api.tasksCreated.slice(0, 20)) {
        parts.push(`* ${t.title}`);
      }
      if (api.tasksCreated.length > 20) {
        parts.push(`...and ${api.tasksCreated.length - 20} more`);
      }
    }
    if (api.apiFailureCount > 0) {
      parts.push(
        "",
        `${api.apiFailureCount} email(s) couldn't be classified this scan - they stay in carryover for the next run.`,
      );
    }
  }
  if (o.errors.length > 0) {
    parts.push("", "Errors:");
    for (const e of o.errors.slice(0, 5)) parts.push(`  * ${e}`);
  }
  return parts.join("\n");
}
