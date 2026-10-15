import { Alerts } from "../src/alerts.js";
import { CircuitBreaker } from "../src/breaker.js";
import { Budget } from "../src/budget.js";
import { MockProvider, type MockResponder } from "../src/providers/mock.js";
import { VendorError, type ProviderOutput, type VendorId, type VisionProvider } from "../src/providers/types.js";
import { Router, type RouterOptions } from "../src/router.js";
import type { Receipt } from "../src/schema.js";
import type { UsageLog } from "../src/usage.js";

export const RECEIPT: Receipt = {
  merchant: "Harbor Street Market",
  date: "2026-03-14",
  currency: "USD",
  items: [
    { description: "Oat Milk 1L", quantity: 2, unit_price: 3.49, amount: 6.98 },
    { description: "Sourdough Loaf", quantity: 1, unit_price: 5.25, amount: 5.25 },
  ],
  subtotal: 12.23,
  tax: 1.01,
  total: 13.24,
};

export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function output(overrides: Partial<ProviderOutput> = {}): ProviderOutput {
  return {
    text: JSON.stringify(RECEIPT),
    usage: { inputTokens: 1_000, outputTokens: 200 },
    model: "claude-haiku-5-5",
    refused: false,
    truncated: false,
    ...overrides,
  };
}

/** A scripted vendor: each call takes the next step, and the last step repeats. */
export function scripted(vendor: VendorId, steps: Array<ProviderOutput | VendorError | Error>, model = "claude-haiku-5-5"): VisionProvider & { calls: number } {
  const responder: MockResponder = (_input, call) => {
    const step = steps[Math.min(call, steps.length) - 1]!;
    if (step instanceof Error) throw step;
    return step;
  };
  const mock = new MockProvider(responder, model);
  // Present as the requested vendor so routing, breakers and logs see a real vendor id.
  return Object.defineProperty(mock, "vendor", { value: vendor }) as unknown as VisionProvider & { calls: number };
}

export function makeRouter(
  providers: VisionProvider[],
  opts: { budgetUsd?: number; options?: Partial<RouterOptions>; usage?: UsageLog; breaker?: CircuitBreaker } = {},
) {
  const alerts = new Alerts({ log: () => {} });
  const budget = new Budget({ limitUsd: opts.budgetUsd ?? 10, warnAt: 0.8, alerts });
  const breaker = opts.breaker ?? new CircuitBreaker(3, 60_000);
  const sleeps: number[] = [];
  const router = new Router(providers, {
    budget,
    breaker,
    alerts,
    prompt: { id: "extract-receipt", version: 7, text: "Extract." },
    ...(opts.usage ? { usage: opts.usage } : {}),
    options: {
      timeoutMs: 1_000,
      maxAttempts: 3,
      baseDelayMs: 100,
      quotaCooldownMs: 900_000,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...opts.options,
    },
  });
  return { router, budget, breaker, alerts, sleeps };
}
