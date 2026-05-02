import { classifyBatchWithCodex } from "./codex-agent.js";
import { MODE } from "./config.js";
import { loadTaxonomy } from "./loaders.js";
import { log } from "./log.js";
import { classifyEmailWithApi, openAiConfigured } from "./openai-classifier.js";
import { computeCostUsd } from "./pricing.js";
import { TaskWriter } from "./providers.js";
import { appendUsage } from "./state.js";
import { ApiOutcome, ScanOutcome } from "./types.js";
import {
  applyClassification,
  createApiOutcome,
  noteApiFailure,
} from "./scan-effects.js";

export async function classifyResidualsCodex(
  outcome: ScanOutcome,
  scanRunId: string,
  taskListId: string | null,
  taskWriter: TaskWriter,
): Promise<ApiOutcome> {
  const taxonomy = loadTaxonomy();
  const out = createApiOutcome();
  const { results: decisions, usage } = await classifyBatchWithCodex(
    outcome.llm_candidates,
    taxonomy,
  );
  if (usage) {
    appendUsage({
      scan_run_id: scanRunId,
      email_ids: outcome.llm_candidates.map((e) => e.id),
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
  for (const email of outcome.llm_candidates) {
    const result = decisions.get(email.id);
    if (!result) {
      noteApiFailure(out, email);
      continue;
    }
    await applyClassification(
      email,
      result,
      scanRunId,
      "codex-cli",
      taskListId,
      taskWriter,
      out,
    );
  }
  return out;
}

export async function classifyResidualsOpenAi(
  outcome: ScanOutcome,
  scanRunId: string,
  taskListId: string | null,
  taskWriter: TaskWriter,
): Promise<ApiOutcome> {
  const taxonomy = loadTaxonomy();
  const out = createApiOutcome();
  if (!openAiConfigured()) {
    log.warn(
      "RESIDUAL_CLASSIFIER=openai but OPENAI_API_KEY is missing; residuals stay pending",
    );
    for (const email of outcome.llm_candidates) noteApiFailure(out, email);
    return out;
  }
  for (const email of outcome.llm_candidates) {
    const { result, usage } = await classifyEmailWithApi(email, taxonomy);
    if (usage) {
      appendUsage({
        scan_run_id: scanRunId,
        email_ids: [email.id],
        mode: MODE,
        caller: "openai",
        model: usage.model,
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        output_tokens: usage.output_tokens,
        latency_ms: usage.latency_ms,
        cost_usd: computeCostUsd(usage.model, usage),
      });
    }
    if (!result) {
      noteApiFailure(out, email);
      continue;
    }
    await applyClassification(
      email,
      result,
      scanRunId,
      "openai-direct",
      taskListId,
      taskWriter,
      out,
    );
  }
  return out;
}
