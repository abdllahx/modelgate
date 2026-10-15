import type { LineItem, Receipt } from "@modelgate/core";

export const FIELDS = ["merchant", "date", "currency", "items", "subtotal", "tax", "total"] as const;
export type Field = (typeof FIELDS)[number];

export interface ReceiptScore {
  fields: Record<Field, boolean>;
  /** Share of the 7 fields extracted correctly. */
  accuracy: number;
  /** Every field correct. */
  exact: boolean;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const near = (a: number, b: number) => Math.abs(a - b) <= 0.011;

function similar(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ta = new Set(x.split(" "));
  const tb = new Set(y.split(" "));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / new Set([...ta, ...tb]).size >= 0.5;
}

/** Same number of items, and each expected item matches a distinct extracted item by name and amount. */
export function itemsMatch(expected: LineItem[], actual: LineItem[]): boolean {
  if (expected.length !== actual.length) return false;
  const used = new Set<number>();
  return expected.every((e) => {
    const i = actual.findIndex((a, idx) => !used.has(idx) && near(a.amount, e.amount) && similar(a.description, e.description));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

export function scoreReceipt(expected: Receipt, actual: Receipt | null): ReceiptScore {
  const fields: Record<Field, boolean> = {
    merchant: actual !== null && normalize(actual.merchant) === normalize(expected.merchant),
    date: actual?.date === expected.date,
    currency: actual?.currency === expected.currency,
    items: actual !== null && itemsMatch(expected.items, actual.items),
    subtotal: actual !== null && near(actual.subtotal, expected.subtotal),
    tax: actual !== null && near(actual.tax, expected.tax),
    total: actual !== null && near(actual.total, expected.total),
  };
  const correct = FIELDS.filter((f) => fields[f]).length;
  return { fields, accuracy: correct / FIELDS.length, exact: correct === FIELDS.length };
}
