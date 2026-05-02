// Lean host-side classifier for MODE=hybrid residuals when
// RESIDUAL_CLASSIFIER=openai. One API call per unresolved email, no tools,
// structured JSON only. The host validates the result and applies side effects.

import {
  OPENAI_API_KEY,
  OPENAI_CLASSIFIER_MODEL,
  OPENAI_CLASSIFIER_TIMEOUT_MS,
} from "./config.js";
import { log } from "./log.js";
import { ClassificationResult, LlmCandidate, Taxonomy } from "./types.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

export function openAiConfigured(): boolean {
  return Boolean(OPENAI_API_KEY);
}

function buildLeanSystemPrompt(taxonomy: Taxonomy): string {
  const folderBullets = taxonomy.folders
    .map((f) => {
      const hint = taxonomy.context[f];
      return hint ? `  ${f} - ${hint}` : `  ${f}`;
    })
    .join("\n");

  return [
    "Classify one email for personal task triage.",
    "",
    "Decide:",
    "1. needs_task: true only if the email creates a real obligation, deadline, direct ask, official consequence, or follow-up the recipient owns. Default false.",
    "2. sort_folder: exactly one taxonomy value.",
    "3. task_title: 4-10 words, action verb first, naming the sender or organization.",
    "4. reasoning: one concise sentence.",
    "",
    "Prefer false negatives over noisy false positives.",
    "",
    "Taxonomy:",
    folderBullets,
    "",
    'Return JSON only: {"needs_task": boolean, "sort_folder": string, "task_title": string, "reasoning": string}',
  ].join("\n");
}

export interface OpenAiUsage {
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

export interface OpenAiClassifyOutput {
  result: ClassificationResult | null;
  usage: OpenAiUsage | null;
}

export async function classifyEmailWithApi(
  email: LlmCandidate,
  taxonomy: Taxonomy,
): Promise<OpenAiClassifyOutput> {
  if (!OPENAI_API_KEY) return { result: null, usage: null };
  const startMs = Date.now();
  const userMsg = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Hint: ${email.bucket_hint}`,
    `Body: ${email.body || "(no body; classify from sender+subject)"}`,
  ].join("\n");

  try {
    const r = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_CLASSIFIER_MODEL,
        messages: [
          { role: "system", content: buildLeanSystemPrompt(taxonomy) },
          { role: "user", content: userMsg },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 300,
      }),
      signal: AbortSignal.timeout(OPENAI_CLASSIFIER_TIMEOUT_MS),
    });
    if (!r.ok) {
      log.warn("classify-api: non-200", {
        status: r.status,
        body: (await r.text()).slice(0, 200),
        emailId: email.id,
      });
      return { result: null, usage: null };
    }
    const resp = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const text = resp.choices?.[0]?.message?.content;
    const usage: OpenAiUsage | null = resp.usage
      ? {
          model: OPENAI_CLASSIFIER_MODEL,
          input_tokens: resp.usage.prompt_tokens ?? 0,
          cached_input_tokens:
            resp.usage.prompt_tokens_details?.cached_tokens ?? 0,
          output_tokens: resp.usage.completion_tokens ?? 0,
          latency_ms: Date.now() - startMs,
        }
      : null;
    if (!text) return { result: null, usage };
    const parsed = JSON.parse(text) as Partial<ClassificationResult>;
    return {
      result: {
        needs_task: Boolean(parsed.needs_task),
        sort_folder: String(parsed.sort_folder || "To Delete"),
        task_title: String(parsed.task_title || "").slice(0, 120),
        reasoning: String(parsed.reasoning || "").slice(0, 500),
      },
      usage,
    };
  } catch (err) {
    log.warn("classify-api: threw", {
      err: String(err),
      emailId: email.id,
    });
    return { result: null, usage: null };
  }
}
