import { Alerts } from "./alerts.js";
import { CircuitBreaker } from "./breaker.js";
import type { BudgetGuard } from "./budget.js";
import type { Config } from "./config.js";
import { loadPrompt, type Prompt } from "./prompts.js";
import { createProvider, type VisionProvider } from "./providers/index.js";
import { Router } from "./router.js";
import type { UsageSink } from "./usage.js";

export interface Runtime {
  router: Router;
  breaker: CircuitBreaker;
  prompt: Prompt;
  providers: VisionProvider[];
}

/**
 * Builds the router from config and the chosen stores. The MCP server passes
 * file-backed stores (or Postgres when DATABASE_URL is set); the API always
 * passes Postgres. Evals build their own routers.
 */
export function createRuntime(
  config: Config,
  stores: { budget: BudgetGuard; usage: UsageSink; alerts: Alerts },
  overrides: { providers?: VisionProvider[]; sleep?: (ms: number) => Promise<void> } = {},
): Runtime {
  const prompt = loadPrompt();
  const providers = overrides.providers ?? config.vendors.map((spec) => createProvider(spec, config));
  const breaker = new CircuitBreaker(config.breakerThreshold, config.breakerCooldownMs);
  const router = new Router(providers, {
    ...stores,
    breaker,
    prompt,
    options: {
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.baseDelayMs,
      quotaCooldownMs: config.quotaCooldownMs,
      ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    },
  });
  return { router, breaker, prompt, providers };
}
