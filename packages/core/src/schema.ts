import { z } from "zod";
import type { VendorId } from "./providers/types.js";

// Zod is the single source of truth. The JSON Schema each vendor receives is
// generated from it, and every vendor's output is validated against it again.

export const LineItem = z
  .object({
    description: z.string().describe("Item name as printed, without quantity or price"),
    quantity: z.number().describe("Units purchased; 1 when not printed"),
    unit_price: z.number().describe("Price per unit"),
    amount: z.number().describe("Line total as printed"),
  })
  .strict();
export type LineItem = z.infer<typeof LineItem>;

export const Receipt = z
  .object({
    merchant: z.string().describe("Business name as printed at the top of the receipt"),
    date: z.string().describe("Purchase date as ISO 8601, YYYY-MM-DD"),
    currency: z.string().describe("ISO 4217 code, for example USD, EUR, GBP"),
    items: z.array(LineItem),
    subtotal: z.number(),
    tax: z.number().describe("Total tax; 0 when no tax line is printed"),
    total: z.number(),
  })
  .strict();
export type Receipt = z.infer<typeof Receipt>;

type JsonSchema = Record<string, unknown>;

function stripKeys(node: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((child) => stripKeys(child, keys));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !keys.has(key))
        .map(([key, value]) => [key, stripKeys(value, keys)]),
    );
  }
  return node;
}

const base = stripKeys(z.toJSONSchema(Receipt), new Set(["$schema"])) as JsonSchema;
// Gemini's responseJsonSchema rejects additionalProperties; the Zod parse still enforces it.
const gemini = stripKeys(base, new Set(["additionalProperties"])) as JsonSchema;

export function receiptJsonSchema(vendor: VendorId): JsonSchema {
  return vendor === "gemini" ? gemini : base;
}
