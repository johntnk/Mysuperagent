import type { ModelUsage } from '../analysis/openai-response';

/** Official Standard API price snapshot. Currency: USD; cached tokens are a subset of input tokens. */
const rates: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
};
export function modelPrices(model: string) {
  const rate = rates[model];
  if (!rate) throw new Error('REPLAY_MODEL_PRICING_NOT_CONFIGURED');
  return {
    input_per_million: rate.input,
    cached_input_per_million: rate.cached,
    output_per_million: rate.output,
    long_context_threshold: 272000,
    long_input_multiplier: 2,
    long_output_multiplier: 1.5,
    as_of: '2026-11-07',
    source: `https://developers.openai.com/api/docs/models/${model}`,
  };
}
export function estimatedPrice(model: string, usage: ModelUsage) {
  const p = modelPrices(model),
    long = usage.input_tokens > p.long_context_threshold;
  if (
    [usage.input_tokens, usage.output_tokens, usage.cached_input_tokens].some(
      (n) => !Number.isFinite(n) || n < 0,
    ) ||
    usage.cached_input_tokens > usage.input_tokens
  )
    throw new Error('invalid_model_usage');
  return (
    (((usage.input_tokens - usage.cached_input_tokens) * p.input_per_million +
      usage.cached_input_tokens * p.cached_input_per_million) *
      (long ? p.long_input_multiplier : 1)) /
      1e6 +
    (usage.output_tokens * p.output_per_million * (long ? p.long_output_multiplier : 1)) / 1e6
  );
}
