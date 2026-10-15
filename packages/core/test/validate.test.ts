import { describe, expect, it } from "vitest";
import { checkContent, isIsoDate, validateExtraction } from "../src/validate.js";
import { output, RECEIPT } from "./helpers.js";

describe("validateExtraction", () => {
  it("accepts a well-formed receipt", () => {
    const result = validateExtraction(output());
    expect(result).toEqual({ ok: true, receipt: RECEIPT, warnings: [] });
  });

  it("strips markdown code fences some models add around JSON", () => {
    const result = validateExtraction(output({ text: "```json\n" + JSON.stringify(RECEIPT) + "\n```" }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["refused", output({ refused: true, detail: "refusal (cyber)" })],
    ["truncated", output({ truncated: true })],
    ["empty_response", output({ text: "   " })],
    ["invalid_json", output({ text: "Sorry, I can't read this receipt." })],
    ["schema_mismatch", output({ text: JSON.stringify({ ...RECEIPT, total: "13.24" }) })],
    ["schema_mismatch", output({ text: JSON.stringify({ ...RECEIPT, notes: "extra" }) })],
  ])("flags %s as a silent failure", (issue, out) => {
    const result = validateExtraction(out);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toBe(issue);
  });
});

describe("checkContent", () => {
  it("rejects the empty receipt the prompt asks for on unreadable images", () => {
    const result = checkContent({ merchant: "", date: "", currency: "", items: [], subtotal: 0, tax: 0, total: 0 });
    expect(result).toMatchObject({ ok: false, issue: "empty_fields" });
    if (!result.ok) expect(result.detail).toContain("merchant, date, currency, items, total");
  });

  it("rejects totals that do not add up", () => {
    const result = checkContent({ ...RECEIPT, total: 19.99 });
    expect(result).toMatchObject({ ok: false, issue: "totals_mismatch" });
  });

  it("warns, but accepts, when line items do not sum to the subtotal", () => {
    const result = checkContent({ ...RECEIPT, items: RECEIPT.items.slice(0, 1) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings[0]).toMatch(/line items sum to 6.98/);
  });

  it("rejects lowercase or non-ISO currency codes", () => {
    expect(checkContent({ ...RECEIPT, currency: "usd" })).toMatchObject({ ok: false, issue: "empty_fields" });
  });
});

describe("isIsoDate", () => {
  it("accepts real dates and rejects impossible or reformatted ones", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("14/03/2026")).toBe(false);
  });
});
