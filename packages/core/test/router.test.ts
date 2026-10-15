import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/breaker.js";
import { BudgetExceededError } from "../src/budget.js";
import { VendorError } from "../src/providers/types.js";
import { AllVendorsFailedError, NoVendorsError } from "../src/router.js";
import { UsageLog } from "../src/usage.js";
import { makeRouter, output, PNG_1PX, RECEIPT, scripted } from "./helpers.js";

const rateLimited = () => new VendorError("anthropic", "rate_limit", "429 Too Many Requests", { status: 429 });

describe("Router", () => {
  it("returns the first vendor's validated receipt with cost and prompt version", async () => {
    const primary = scripted("anthropic", [output()]);
    const { router } = makeRouter([primary, scripted("openai", [output()])]);

    const result = await router.extract(PNG_1PX, "image/png");

    expect(result.receipt).toEqual(RECEIPT);
    expect(result.vendor).toBe("anthropic");
    expect(result.fellBack).toBe(false);
    expect(result.promptVersion).toBe(7);
    // claude-haiku-5-5: 1,000 in x $0.10/M + 200 out x $0.50/M
    expect(result.costUsd).toBeCloseTo(0.0002, 10);
  });

  it("retries transient errors with exponential backoff, then succeeds on the same vendor", async () => {
    const primary = scripted("anthropic", [rateLimited(), rateLimited(), output()]);
    const { router, sleeps } = makeRouter([primary]);

    const result = await router.extract(PNG_1PX, "image/png");

    expect(primary.calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(result.attempts.map((a) => a.outcome)).toEqual(["error", "error", "ok"]);
  });

  it("honours Retry-After when it is longer than the computed backoff", async () => {
    const primary = scripted("anthropic", [new VendorError("anthropic", "rate_limit", "slow down", { retryAfterMs: 4_000 }), output()]);
    const { router, sleeps } = makeRouter([primary]);
    await router.extract(PNG_1PX, "image/png");
    expect(sleeps).toEqual([4_000]);
  });

  it("falls back to the next vendor after retries are exhausted", async () => {
    const primary = scripted("anthropic", [rateLimited()]);
    const secondary = scripted("openai", [output({ model: "gpt-5-mini" })], "gpt-5-mini");
    const { router } = makeRouter([primary, secondary]);

    const result = await router.extract(PNG_1PX, "image/png");

    expect(primary.calls).toBe(3);
    expect(result.vendor).toBe("openai");
    expect(result.fellBack).toBe(true);
  });

  it("does not retry non-retryable errors", async () => {
    const primary = scripted("anthropic", [new VendorError("anthropic", "auth", "invalid x-api-key", { status: 401 })]);
    const { router } = makeRouter([primary, scripted("openai", [output()])]);

    const result = await router.extract(PNG_1PX, "image/png");

    expect(primary.calls).toBe(1);
    expect(result.vendor).toBe("openai");
  });

  it("treats a schema-invalid HTTP 200 as a silent failure and moves on without retrying it", async () => {
    const primary = scripted("anthropic", [output({ text: '{"merchant": "Harbor"}' })]);
    const { router } = makeRouter([primary, scripted("openai", [output()])]);

    const result = await router.extract(PNG_1PX, "image/png");

    expect(primary.calls).toBe(1);
    expect(result.vendor).toBe("openai");
    expect(result.attempts[0]).toMatchObject({ outcome: "invalid", reason: expect.stringMatching(/^schema_mismatch/) });
    // The rejected output was still paid for and is still counted.
    expect(result.attempts[0]!.costUsd).toBeGreaterThan(0);
  });

  it("routes around a vendor with exhausted quota and alerts once", async () => {
    const quota = new VendorError("openai", "quota", "You exceeded your current quota", { status: 429 });
    const primary = scripted("openai", [quota], "gpt-5-mini");
    const { router, alerts, breaker } = makeRouter([primary, scripted("anthropic", [output()])]);

    await router.extract(PNG_1PX, "image/png");
    await router.extract(PNG_1PX, "image/png");

    expect(primary.calls).toBe(1); // second request skips the tripped vendor
    expect(breaker.isOpen("openai:gpt-5-mini")).toBe(true);
    expect(alerts.sent.filter((a) => a.kind === "quota_exhausted")).toHaveLength(1);
  });

  it("opens the circuit after repeated failures and skips the vendor", async () => {
    const primary = scripted("anthropic", [new VendorError("anthropic", "bad_request", "400")]);
    const breaker = new CircuitBreaker(2, 60_000);
    const { router } = makeRouter([primary, scripted("openai", [output()])], { breaker });

    await router.extract(PNG_1PX, "image/png");
    await router.extract(PNG_1PX, "image/png");
    const third = await router.extract(PNG_1PX, "image/png");

    expect(primary.calls).toBe(2);
    expect(third.attempts[0]).toMatchObject({ vendor: "anthropic", outcome: "skipped", reason: "circuit open" });
  });

  it("times out a hung vendor and falls back", async () => {
    const hung = scripted("anthropic", [output()]);
    hung.extract = (input) =>
      new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason)));
    const { router } = makeRouter([hung, scripted("openai", [output()])], { options: { timeoutMs: 20, maxAttempts: 1 } });

    const result = await router.extract(PNG_1PX, "image/png");

    expect(result.vendor).toBe("openai");
    expect(result.attempts[0]).toMatchObject({ outcome: "error", reason: expect.stringMatching(/^timeout/) });
  });

  it("throws AllVendorsFailedError with the full attempt trace", async () => {
    const { router, alerts } = makeRouter([
      scripted("anthropic", [output({ refused: true, detail: "refusal (cyber)" })]),
      scripted("openai", [output({ truncated: true })]),
    ]);

    const error = await router.extract(PNG_1PX, "image/png").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllVendorsFailedError);
    expect((error as AllVendorsFailedError).attempts.map((a) => a.reason?.split(":")[0])).toEqual(["refused", "truncated"]);
    expect(alerts.sent.map((a) => a.kind)).toContain("all_vendors_failed");
  });

  it("hard-stops before calling any vendor once the budget is spent", async () => {
    const primary = scripted("anthropic", [output({ usage: { inputTokens: 10_000_000, outputTokens: 0 } })]);
    const { router, alerts } = makeRouter([primary], { budgetUsd: 0.5 });

    await router.extract(PNG_1PX, "image/png"); // costs $1.00 and crosses the limit
    await expect(router.extract(PNG_1PX, "image/png")).rejects.toBeInstanceOf(BudgetExceededError);

    expect(primary.calls).toBe(1);
    expect(alerts.sent.map((a) => a.kind)).toEqual(expect.arrayContaining(["budget_warning", "budget_exhausted"]));
  });

  it("honours a per-call vendor order", async () => {
    const { router } = makeRouter([scripted("anthropic", [output()]), scripted("openai", [output()])]);
    const result = await router.extract(PNG_1PX, "image/png", { vendors: ["openai"] });
    expect(result.vendor).toBe("openai");
  });

  it("fails clearly when nothing is configured", async () => {
    const { router } = makeRouter([]);
    await expect(router.extract(PNG_1PX, "image/png")).rejects.toBeInstanceOf(NoVendorsError);
  });

  it("names the problem when a per-call vendor order matches nothing configured", async () => {
    const { router } = makeRouter([scripted("anthropic", [output()])]);
    await expect(router.extract(PNG_1PX, "image/png", { vendors: ["gemini"] })).rejects.toThrow(/requested vendors \(gemini\)/);
  });

  it("tracks two models from the same vendor separately", async () => {
    const haiku = scripted("anthropic", [new VendorError("anthropic", "bad_request", "model does not support this")], "claude-haiku-5-5");
    const opus = scripted("anthropic", [output({ model: "claude-opus-5-5" })], "claude-opus-5-5");
    const breaker = new CircuitBreaker(1, 60_000);
    const { router } = makeRouter([haiku, opus], { breaker });

    await router.extract(PNG_1PX, "image/png");
    const second = await router.extract(PNG_1PX, "image/png");

    expect(breaker.isOpen("anthropic:claude-haiku-5-5")).toBe(true);
    expect(breaker.isOpen("anthropic:claude-opus-5-5")).toBe(false);
    expect(second.model).toBe("claude-opus-5-5");
  });

  it("logs one usage record per request, including fallbacks and silent failures", async () => {
    const usage = new UsageLog(join(mkdtempSync(join(tmpdir(), "modelgate-")), "usage.jsonl"));
    const { router } = makeRouter([scripted("anthropic", [output({ text: "nope" })]), scripted("openai", [output()])], { usage });

    await router.extract(PNG_1PX, "image/png");

    const [record] = usage.read();
    expect(record).toMatchObject({ outcome: "ok", vendor: "openai", fellBack: true, silentFailures: 1, promptVersion: 7 });
  });
});
