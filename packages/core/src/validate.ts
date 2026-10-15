import { Receipt } from "./schema.js";
import type { ProviderOutput } from "./providers/types.js";

/**
 * Silent-failure detection. Every check below catches an output that a vendor
 * returned with HTTP 200 and that would otherwise flow downstream as "success".
 */
export type Issue =
  | "refused"
  | "truncated"
  | "empty_response"
  | "invalid_json"
  | "schema_mismatch"
  | "empty_fields"
  | "totals_mismatch";

export type Validation =
  | { ok: true; receipt: Receipt; warnings: string[] }
  | { ok: false; issue: Issue; detail: string };

const TOLERANCE = 0.02;

const fail = (issue: Issue, detail: string): Validation => ({ ok: false, issue, detail });

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function validateExtraction(output: Pick<ProviderOutput, "text" | "refused" | "truncated" | "detail">): Validation {
  if (output.refused) return fail("refused", output.detail ?? "model declined the request");
  if (output.truncated) return fail("truncated", "output hit the token limit before the JSON closed");

  const text = stripFences(output.text);
  if (!text) return fail("empty_response", "response contained no text");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("invalid_json", `not valid JSON: ${text.slice(0, 80)}`);
  }

  const parsed = Receipt.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail("schema_mismatch", detail);
  }
  return checkContent(parsed.data);
}

/** Schema-valid but empty or arithmetically impossible output is still a failure. */
export function checkContent(receipt: Receipt): Validation {
  const missing: string[] = [];
  if (!receipt.merchant.trim()) missing.push("merchant");
  if (!isIsoDate(receipt.date)) missing.push("date");
  if (!/^[A-Z]{3}$/.test(receipt.currency)) missing.push("currency");
  if (receipt.items.length === 0) missing.push("items");
  if (!(receipt.total > 0)) missing.push("total");
  if (missing.length > 0) return fail("empty_fields", `missing or malformed: ${missing.join(", ")}`);

  if (Math.abs(receipt.subtotal + receipt.tax - receipt.total) > TOLERANCE) {
    return fail("totals_mismatch", `subtotal ${receipt.subtotal} + tax ${receipt.tax} does not equal total ${receipt.total}`);
  }

  // Discounts and rounding make a line-item mismatch plausible on real receipts,
  // so it is surfaced as a warning rather than rejected.
  const warnings: string[] = [];
  const itemsSum = round2(receipt.items.reduce((sum, item) => sum + item.amount, 0));
  if (Math.abs(itemsSum - receipt.subtotal) > TOLERANCE) {
    warnings.push(`line items sum to ${itemsSum} but subtotal is ${receipt.subtotal}`);
  }
  return { ok: true, receipt, warnings };
}
