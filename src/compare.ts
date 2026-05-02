import { validateSortFolder } from "./cascade.js";
import { classifyBatchWithCodex } from "./codex-agent.js";
import { MODE } from "./config.js";
import { loadTaxonomy } from "./loaders.js";
import { computeCostUsd } from "./pricing.js";
import { appendDecision, appendUsage } from "./state.js";
import { Classification, CompareOutcome, EmailMinimal } from "./types.js";
import { fetchBodies } from "./scan-mail.js";
import {
  candidateFromEmail,
  deterministicDecisionFor,
} from "./preclassifier.js";

export async function compareAgentToPrefilter(
  emails: EmailMinimal[],
  classification: Classification,
  institutions: Set<string>,
  contacts: Set<string>,
  scanRunId: string,
): Promise<CompareOutcome> {
  const candidates = emails.map((email) =>
    candidateFromEmail(email, institutions, contacts),
  );
  await fetchBodies(candidates);

  const taxonomy = loadTaxonomy();
  const { results, usage } = await classifyBatchWithCodex(candidates, taxonomy);
  if (usage) {
    appendUsage({
      scan_run_id: scanRunId,
      email_ids: candidates.map((e) => e.id),
      mode: MODE,
      caller: "codex",
      model: usage.model,
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_output_tokens: usage.reasoning_output_tokens,
      latency_ms: usage.latency_ms,
      cost_usd: computeCostUsd(usage.model, usage),
    });
  }

  const out: CompareOutcome = {
    agentTaskCount: 0,
    agentSkipCount: 0,
    deterministicTaskCount: 0,
    deterministicSkipCount: 0,
    deterministicAgentNeededCount: 0,
    agreementCount: 0,
    disagreementCount: 0,
    missingAgentCount: 0,
  };

  for (const email of candidates) {
    const deterministic = deterministicDecisionFor(email, classification);
    if (deterministic.needs_task === true) out.deterministicTaskCount += 1;
    else if (deterministic.needs_task === false) {
      out.deterministicSkipCount += 1;
    } else {
      out.deterministicAgentNeededCount += 1;
    }

    const agent = results.get(email.id);
    if (!agent) {
      out.missingAgentCount += 1;
      appendDecision({
        scan_run_id: scanRunId,
        email_id: email.id,
        account: email.account,
        sender: email.from,
        subject: (email.subject || "").slice(0, 120),
        pass: "compare",
        decision: "agent-missing",
        deterministic_source: deterministic.source,
        deterministic_needs_task: deterministic.needs_task,
        deterministic_sort_folder: deterministic.sort_folder,
        deterministic_task_title: deterministic.task_title,
        deterministic_rule_matched: deterministic.rule_matched,
        deterministic_reasoning: deterministic.reasoning,
        model_used: "codex-cli",
        dry_run: true,
      });
      continue;
    }

    if (agent.needs_task) out.agentTaskCount += 1;
    else out.agentSkipCount += 1;

    const deterministicMadeDecision = deterministic.needs_task !== null;
    const agrees =
      deterministicMadeDecision &&
      deterministic.needs_task === agent.needs_task;
    if (agrees) out.agreementCount += 1;
    else if (deterministicMadeDecision) out.disagreementCount += 1;

    appendDecision({
      scan_run_id: scanRunId,
      email_id: email.id,
      account: email.account,
      sender: email.from,
      subject: (email.subject || "").slice(0, 120),
      pass: "compare",
      decision: deterministicMadeDecision
        ? agrees
          ? "compare-agree"
          : "compare-disagree"
        : "compare-agent-needed",
      deterministic_source: deterministic.source,
      deterministic_needs_task: deterministic.needs_task,
      deterministic_sort_folder: deterministic.sort_folder,
      deterministic_task_title: deterministic.task_title,
      deterministic_rule_matched: deterministic.rule_matched,
      deterministic_reasoning: deterministic.reasoning,
      agent_needs_task: agent.needs_task,
      agent_sort_folder: validateSortFolder(agent.sort_folder, taxonomy),
      agent_task_title: agent.task_title,
      agent_reasoning: agent.reasoning,
      model_used: "codex-cli",
      dry_run: true,
    });
  }

  return out;
}
