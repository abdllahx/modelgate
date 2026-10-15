import { randomUUID } from "node:crypto";
import type { Alerts } from "./alerts.js";
import type { CircuitBreaker } from "./breaker.js";
import { BudgetExceededError, type BudgetGuard } from "./budget.js";
import { costOf } from "./pricing.js";
import type { Prompt } from "./prompts.js";
import {
  RETRYABLE,
  VendorError,
  type ImageMime,
  type ProviderOutput,
  type VendorId,
  type VisionProvider,
} from "./providers/types.js";
import { receiptJsonSchema, type Receipt } from "./schema.js";
import type { AttemptRecord, UsageRecord, UsageSink } from "./usage.js";
import { validateExtraction } from "./validate.js";

export interface RouterOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  quotaCooldownMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface RouterDeps {
  budget: BudgetGuard;
  breaker: CircuitBreaker;
  alerts: Alerts;
  prompt: Prompt;
  usage?: UsageSink;
  options: RouterOptions;
}

export interface ExtractionResult {
  requestId: string;
  receipt: Receipt;
  vendor: VendorId;
  model: string;
  costUsd: number;
  latencyMs: number;
  promptVersion: number;
  fellBack: boolean;
  warnings: string[];
  attempts: AttemptRecord[];
}

export class NoVendorsError extends Error {
  constructor(requested?: VendorId[]) {
    super(
      requested?.length
        ? `None of the requested vendors (${requested.join(", ")}) are configured. Omit "vendors" to use the configured routing order.`
        : "No vendors are configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, or MODELGATE_VENDORS=mock for an offline demo.",
    );
    this.name = "NoVendorsError";
  }
}

export class AllVendorsFailedError extends Error {
  constructor(
    readonly requestId: string,
    readonly attempts: AttemptRecord[],
  ) {
    const summary = attempts.map((a) => `${a.vendor}#${a.attempt} ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`).join("; ");
    super(`Every vendor failed or was skipped: ${summary}`);
    this.name = "AllVendorsFailedError";
  }
}

const MAX_BACKOFF_MS = 20_000;

/**
 * Routes one extraction through vendors in order:
 *   - transient errors (429, 5xx, timeout, network) retry the same vendor with jittered exponential backoff
 *   - non-retryable errors, exhausted retries and quota errors move to the next vendor
 *   - outputs that fail validation (silent failures) move to the next vendor
 *   - an open circuit breaker skips a vendor without calling it
 *   - the budget is checked before every call and recorded after it
 */
export class Router {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly providers: VisionProvider[],
    private readonly deps: RouterDeps,
  ) {
    this.sleep = deps.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.options.now ?? Date.now;
    this.random = deps.options.random ?? Math.random;
  }

  get vendors(): Array<{ vendor: VendorId; model: string }> {
    return this.providers.map((p) => ({ vendor: p.vendor, model: p.model }));
  }

  private chain(order?: VendorId[]): VisionProvider[] {
    if (!order || order.length === 0) return this.providers;
    return order.flatMap((vendor) => this.providers.filter((p) => p.vendor === vendor));
  }

  backoffMs(attempt: number, retryAfter?: number): number {
    const base = this.deps.options.baseDelayMs;
    const exponential = base * 2 ** (attempt - 1) + this.random() * base;
    return Math.min(MAX_BACKOFF_MS, Math.max(exponential, retryAfter ?? 0));
  }

  async extract(image: Buffer, mimeType: ImageMime, opts: { vendors?: VendorId[] } = {}): Promise<ExtractionResult> {
    const { budget, breaker, alerts, prompt, usage, options } = this.deps;
    const requestId = randomUUID();
    const started = this.now();
    const attempts: AttemptRecord[] = [];
    const chain = this.chain(opts.vendors);
    if (chain.length === 0) throw new NoVendorsError(opts.vendors);
    let spent = 0;

    const log = async (outcome: UsageRecord["outcome"], extra: Partial<UsageRecord> = {}) =>
      usage?.append({
        ts: new Date(started).toISOString(),
        requestId,
        outcome,
        promptVersion: prompt.version,
        costUsd: spent,
        latencyMs: this.now() - started,
        fellBack: false,
        silentFailures: attempts.filter((a) => a.outcome === "invalid").length,
        attempts,
        warnings: [],
        ...extra,
      });

    try {
      for (const [position, provider] of chain.entries()) {
        const { vendor, model } = provider;
        const route = `${vendor}:${model}`;
        if (breaker.isOpen(route)) {
          attempts.push({ vendor, model, attempt: 0, outcome: "skipped", reason: "circuit open", latencyMs: 0, costUsd: 0 });
          continue;
        }

        for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
          await budget.assertAvailable();
          const t0 = this.now();

          let output: ProviderOutput;
          try {
            output = await this.call(provider, image, mimeType);
          } catch (err) {
            const error = asVendorError(err, vendor);
            attempts.push({ vendor, model, attempt, outcome: "error", reason: `${error.kind}: ${error.message}`, latencyMs: this.now() - t0, costUsd: 0 });
            if (RETRYABLE.has(error.kind) && attempt < options.maxAttempts) {
              await this.sleep(this.backoffMs(attempt, error.retryAfterMs));
              continue;
            }
            if (error.kind === "quota") {
              breaker.trip(route, options.quotaCooldownMs, "quota or credits exhausted");
              void alerts.send(
                "quota_exhausted",
                `${vendor} reports exhausted quota or credits; routing around it for ${Math.round(options.quotaCooldownMs / 60_000)} min.`,
                { vendor, model },
                vendor,
              );
            } else {
              breaker.recordFailure(route, error.kind);
            }
            break;
          }

          const cost = costOf(output.model, output.usage);
          await budget.record(cost.usd);
          spent += cost.usd;
          if (cost.estimated) {
            void alerts.send("unpriced_model", `${output.model} has no price entry; charging the most expensive known rate.`, { model: output.model }, output.model);
          }

          const check = validateExtraction(output);
          const latencyMs = this.now() - t0;
          if (check.ok) {
            breaker.recordSuccess(route);
            attempts.push({ vendor, model: output.model, attempt, outcome: "ok", latencyMs, costUsd: cost.usd });
            const result: ExtractionResult = {
              requestId,
              receipt: check.receipt,
              vendor,
              model: output.model,
              costUsd: spent,
              latencyMs: this.now() - started,
              promptVersion: prompt.version,
              fellBack: position > 0,
              warnings: check.warnings,
              attempts,
            };
            await log("ok", { vendor, model: output.model, fellBack: position > 0, warnings: check.warnings });
            return result;
          }

          // Silent failure caught. Resending the same image to the same model
          // rarely fixes a refusal or a schema miss and doubles the spend, so the
          // request moves to the next vendor instead of retrying.
          attempts.push({ vendor, model: output.model, attempt, outcome: "invalid", reason: `${check.issue}: ${check.detail}`, latencyMs, costUsd: cost.usd });
          breaker.recordFailure(route, check.issue);
          break;
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) await log("budget_exceeded");
      throw err;
    }

    await log("failed");
    void alerts.send("all_vendors_failed", `Request ${requestId} failed on every vendor.`, { attempts }, requestId);
    throw new AllVendorsFailedError(requestId, attempts);
  }

  private async call(provider: VisionProvider, image: Buffer, mimeType: ImageMime): Promise<ProviderOutput> {
    const { timeoutMs } = this.deps.options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      return await provider.extract({
        image,
        mimeType,
        instructions: this.deps.prompt.text,
        jsonSchema: receiptJsonSchema(provider.vendor),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new VendorError(provider.vendor, "timeout", `no response within ${timeoutMs} ms`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function asVendorError(err: unknown, vendor: VendorId): VendorError {
  if (err instanceof VendorError) return err;
  return new VendorError(vendor, "unknown", err instanceof Error ? err.message : String(err), { cause: err });
}
