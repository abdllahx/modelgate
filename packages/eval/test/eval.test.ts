import { describe, expect, it } from "vitest";
import { compare } from "../src/gate.js";
import { recommend, renderMarkdown, summarizeCandidate, type CandidateSummary, type DocResult, type EvalResults } from "../src/run.js";
import { itemsMatch, scoreReceipt } from "../src/score.js";
import { RECEIPT } from "../../core/test/helpers.js";

describe("scoreReceipt", () => {
  it("scores a perfect extraction as exact", () => {
    expect(scoreReceipt(RECEIPT, RECEIPT)).toMatchObject({ accuracy: 1, exact: true });
  });

  it("normalises case and punctuation in merchant names", () => {
    const score = scoreReceipt({ ...RECEIPT, merchant: "Maple & Rye Bakery" }, { ...RECEIPT, merchant: "MAPLE AND RYE BAKERY" });
    expect(score.fields.merchant).toBe(true);
  });

  it("scores field by field", () => {
    const score = scoreReceipt(RECEIPT, { ...RECEIPT, date: "2026-14-03", tax: 1.1, total: 13.33 });
    expect(score.fields).toMatchObject({ date: false, tax: false, total: false, merchant: true });
    expect(score.accuracy).toBeCloseTo(4 / 7);
  });

  it("scores a failed extraction as zero", () => {
    expect(scoreReceipt(RECEIPT, null).accuracy).toBe(0);
  });

  it("matches items by name and amount regardless of order", () => {
    expect(itemsMatch(RECEIPT.items, [...RECEIPT.items].reverse())).toBe(true);
    expect(itemsMatch(RECEIPT.items, [{ ...RECEIPT.items[0]!, amount: 6.0 }, RECEIPT.items[1]!])).toBe(false);
  });
});

const summary = (id: string, fieldAccuracy: number, costPerDocUsd: number, validRate = 1): CandidateSummary => ({
  id,
  kind: "vendor",
  docs: 24,
  fieldAccuracy,
  exactMatch: fieldAccuracy,
  validRate,
  silentFailuresCaught: 0,
  errors: 0,
  p50Ms: 1000,
  p95Ms: 2000,
  costPerDocUsd,
  costPer1kDocsUsd: costPerDocUsd * 1000,
  byDifficulty: { clean: fieldAccuracy },
  byField: { merchant: 1, date: 1, currency: 1, items: 1, subtotal: 1, tax: 1, total: 1 },
  misses: [],
});

describe("recommend", () => {
  it("picks the cheapest candidate within one point of the best accuracy", () => {
    const rec = recommend([summary("anthropic:claude-opus-5-5", 0.97, 0.01), summary("openai:gpt-5-mini", 0.965, 0.001), summary("gemini:gemini-2.5-flash", 0.9, 0.0005)]);
    expect(rec.primary).toBe("openai:gpt-5-mini");
    expect(rec.order).toEqual(["openai:gpt-5-mini", "anthropic:claude-opus-5-5", "gemini:gemini-2.5-flash"]);
  });

  it("explains that reference-only runs have no cost to compare", () => {
    const rec = recommend([{ ...summary("claude-code:claude-opus-5-5", 1, 0), kind: "reference" }]);
    expect(rec.primary).toBeNull();
    expect(rec.rationale).toMatch(/Only reference candidates/);
  });

  it("ignores unreliable candidates however cheap they are", () => {
    const rec = recommend([summary("a:x", 0.99, 0.0001, 0.5), summary("b:y", 0.9, 0.01)]);
    expect(rec.primary).toBe("b:y");
  });
});

describe("summarizeCandidate", () => {
  it("aggregates accuracy, validity, cost and silent failures", () => {
    const doc = (ok: boolean, accuracy: number): DocResult => ({
      file: "r.png",
      difficulty: "clean",
      ok,
      costUsd: 0.002,
      latencyMs: 1000,
      silentFailures: ok ? 0 : 1,
      score: { fields: { merchant: ok, date: ok, currency: ok, items: ok, subtotal: ok, tax: ok, total: ok }, accuracy, exact: accuracy === 1 },
    });
    const s = summarizeCandidate("x", "vendor", [doc(true, 1), doc(false, 0)]);
    expect(s).toMatchObject({ fieldAccuracy: 0.5, validRate: 0.5, silentFailuresCaught: 1, errors: 1 });
    expect(s.misses).toEqual([{ file: "r.png", difficulty: "clean", wrongFields: ["merchant", "date", "currency", "items", "subtotal", "tax", "total"] }]);
    expect(s.costPer1kDocsUsd).toBeCloseTo(2);
  });
});

describe("gate", () => {
  const results = (candidates: CandidateSummary[], promptVersion = 1): EvalResults => ({
    generatedAt: "2026-10-15T00:00:00Z",
    promptVersion,
    dataset: { size: 24, source: "synthetic" },
    budgetExhausted: false,
    candidates,
    recommendation: recommend(candidates),
  });

  it("passes small movements and fails real regressions", () => {
    const baseline = results([summary("openai:gpt-5-mini", 0.95, 0.001)]);
    expect(compare(baseline, results([summary("openai:gpt-5-mini", 0.94, 0.0011)], 2))).toEqual([]);

    const findings = compare(baseline, results([summary("openai:gpt-5-mini", 0.9, 0.002, 0.8)], 2));
    expect(findings.map((f) => f.metric).sort()).toEqual(["costPerDocUsd", "fieldAccuracy", "validRate"]);
  });

  it("renders EVAL.md with the recommended routing order", () => {
    const md = renderMarkdown(results([summary("openai:gpt-5-mini", 0.95, 0.001), summary("gemini:gemini-2.5-flash", 0.9, 0.0005)]));
    expect(md).toContain("MODELGATE_VENDORS=openai:gpt-5-mini,gemini:gemini-2.5-flash");
    expect(md).toContain("| `openai:gpt-5-mini` | 95.0%");
  });
});
