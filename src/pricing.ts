// Per-model pricing (USD per 1M tokens). Hardcoded defaults transplanted
// from CUagent (verified 2026-04-20 via provider pricing pages). Adjust here
// when rates change. cached_input rates are cache-read; cache-write premium
// is not tracked separately.

export interface ModelPrice {
  input: number;
  output: number;
  cached_input?: number;
}

const PRICES: Record<string, ModelPrice> = {
  // OpenAI — developers.openai.com/api/docs/pricing
  'gpt-5.4-pro': { input: 30.0, output: 180.0 },
  'gpt-5.4': { input: 2.5, cached_input: 0.25, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, cached_input: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached_input: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cached_input: 0.175, output: 14.0 },
  'gpt-5.3-chat-latest': { input: 1.75, cached_input: 0.175, output: 14.0 },
  'o4-mini-2025-04-16': { input: 4.0, cached_input: 1.0, output: 16.0 },
  // Anthropic — claude.com/pricing
  'claude-opus-4-7': { input: 5.0, cached_input: 0.5, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, cached_input: 0.5, output: 25.0 },
  'claude-sonnet-4-6': { input: 3.0, cached_input: 0.3, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, cached_input: 0.3, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, cached_input: 0.1, output: 5.0 },
};

const FALLBACK: ModelPrice = { input: 1.25, cached_input: 0.125, output: 10.0 };

export interface UsageInput {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
}

export function priceOf(model: string): ModelPrice {
  return PRICES[model] ?? FALLBACK;
}

/**
 * API-equivalent cost regardless of how billing actually happened (subscription
 * vs API key). Lets us compare modes apples-to-apples.
 */
export function computeCostUsd(model: string, u: UsageInput): number {
  const p = priceOf(model);
  const cached = u.cached_input_tokens ?? 0;
  const uncachedInput = Math.max(0, u.input_tokens - cached);
  const cachedRate = p.cached_input ?? p.input;
  const cost =
    (uncachedInput / 1_000_000) * p.input +
    (cached / 1_000_000) * cachedRate +
    (u.output_tokens / 1_000_000) * p.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
