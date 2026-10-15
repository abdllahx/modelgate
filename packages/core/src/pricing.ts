import type { Usage } from "./providers/types.js";

export interface Price {
  /** USD per million input tokens (images are billed as input tokens). */
  input: number;
  /** USD per million output tokens, including reasoning/thinking tokens. */
  output: number;
}

/**
 * Standard-tier list prices, verified 2026-10-15:
 *   Anthropic  platform.claude.com pricing (via the Claude API reference)
 *   OpenAI     developers.openai.com/api/docs/pricing
 *   Google     ai.google.dev/gemini-api/docs/pricing
 * Update the date and the source when you change a row. Models are matched by
 * longest prefix, so dated or suffixed IDs ("gemini-2.5-flash-001") resolve.
 */
export const PRICING: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5": { input: 1.25, output: 10 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "mock-vision": { input: 0, output: 0 },
};

// Unknown models are charged at the most expensive known rate. The budget can
// overestimate an unpriced model's spend, but it can never silently undercount it.
const CONSERVATIVE: Price = Object.values(PRICING).reduce(
  (worst, p) => ({ input: Math.max(worst.input, p.input), output: Math.max(worst.output, p.output) }),
  { input: 0, output: 0 },
);

export function priceFor(model: string): { price: Price; estimated: boolean } {
  const key = Object.keys(PRICING)
    .filter((k) => model === k || model.startsWith(`${k}-`) || model.startsWith(`${k}@`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { price: PRICING[key]!, estimated: false } : { price: CONSERVATIVE, estimated: true };
}

export function costOf(model: string, usage: Usage): { usd: number; estimated: boolean } {
  const { price, estimated } = priceFor(model);
  const usd = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return { usd, estimated };
}
