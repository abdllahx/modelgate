/**
 * Generates a deterministic, labeled receipt dataset for the eval harness.
 *
 * Synthetic receipts make the ground truth exact and the dataset free to share.
 * Image variants (faded ink, rotation, speckle, small JPEG, thermal fade, skew)
 * stress the same failure points real phone photos do, and content traps
 * (day/month-ambiguous dates, CASH and CHANGE lines next to TOTAL) test reading
 * rather than OCR. Add real receipts by dropping images into packages/eval/dataset and
 * appending entries to labels.json.
 *
 *   npm run dataset            # 28 receipts (4 per difficulty), seed 20261015
 *   npm run dataset -- --count 40 --seed 7
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import type { LineItem, Receipt } from "@modelgate/core";

export type Difficulty = "clean" | "faded" | "rotated" | "noisy" | "small" | "thermal" | "skewed";

export interface LabeledReceipt {
  file: string;
  difficulty: Difficulty;
  receipt: Receipt;
}

const MERCHANTS = [
  "Harbor Street Market",
  "Bluebell Grocers",
  "Northgate Pharmacy",
  "Copper Kettle Cafe",
  "Maple & Rye Bakery",
  "Cityline Hardware",
  "Greenleaf Organics",
  "Riverside Deli",
  "Lumen Books",
  "Corner Fresh Foods",
  "Atlas Office Supply",
  "Sunrise Bodega",
];

const CATALOG: Array<[string, number]> = [
  ["Oat Milk 1L", 3.49],
  ["Sourdough Loaf", 5.25],
  ["Free Range Eggs 12", 4.8],
  ["Cheddar 200g", 3.95],
  ["Bananas 1kg", 1.89],
  ["Arabica Beans 250g", 8.5],
  ["Greek Yogurt", 2.65],
  ["Olive Oil 500ml", 7.4],
  ["Pasta Fusilli", 1.99],
  ["Tomato Passata", 2.15],
  ["Dark Chocolate", 2.79],
  ["Sparkling Water", 0.99],
  ["Avocados", 1.6],
  ["Basmati Rice 1kg", 4.1],
  ["Green Tea 20pk", 3.6],
  ["Paper Towels", 4.45],
  ["Dish Soap", 2.99],
  ["AA Batteries 4pk", 6.75],
];

const CURRENCIES = {
  USD: { symbol: "$", taxLabel: "SALES TAX 8.25%", rate: 0.0825 },
  EUR: { symbol: "€", taxLabel: "MwSt 19%", rate: 0.19 },
  GBP: { symbol: "£", taxLabel: "VAT 20%", rate: 0.2 },
} as const;
type Currency = keyof typeof CURRENCIES;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DIFFICULTIES: Difficulty[] = ["clean", "faded", "rotated", "noisy", "small", "thermal", "skewed"];

/** mulberry32: tiny seeded PRNG so the dataset is reproducible byte for byte. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toFixed(2);
const pad = (n: number) => String(n).padStart(2, "0");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function printedDate(iso: string, currency: Currency, style: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const month = MONTHS[m - 1]!;
  if (currency === "USD") return style ? `${month} ${d}, ${y}` : `${pad(m)}/${pad(d)}/${y}`;
  if (currency === "EUR") return `${pad(d)}.${pad(m)}.${y}`;
  return style ? `${d} ${month} ${y}` : `${pad(d)}/${pad(m)}/${y}`;
}

type Line = { left: string; right?: string; center?: boolean; bold?: boolean };

function buildReceipt(random: () => number, index: number): { receipt: Receipt; lines: Line[] } {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const merchant = MERCHANTS[index % MERCHANTS.length]!;
  const currency: Currency = pick(["USD", "USD", "EUR", "GBP"] as const);
  const { symbol, taxLabel, rate } = CURRENCIES[currency];

  const start = Date.UTC(2025, 0, 1);
  let date = new Date(start + Math.floor(random() * 640) * 86_400_000).toISOString().slice(0, 10);
  // Half of day-first receipts get a day of 12 or less, so 04/03 could be read either
  // way; only the currency rule in the prompt resolves it.
  if (currency !== "USD" && random() < 0.5) date = `${date.slice(0, 8)}${pad(1 + Math.floor(random() * 12))}`;

  const count = 2 + Math.floor(random() * 5);
  const chosen = [...CATALOG].sort(() => random() - 0.5).slice(0, count);
  const items: LineItem[] = chosen.map(([description, unit_price]) => {
    const quantity = random() < 0.3 ? 2 + Math.floor(random() * 2) : 1;
    return { description, quantity, unit_price, amount: round2(quantity * unit_price) };
  });

  const subtotal = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const taxed = currency !== "USD" || random() < 0.7;
  const tax = taxed ? round2(subtotal * rate) : 0;
  const total = round2(subtotal + tax);

  const lines: Line[] = [
    { left: merchant.toUpperCase(), center: true, bold: true },
    { left: `${100 + Math.floor(random() * 899)} Market Road`, center: true },
    { left: `Tel: 555-0${100 + Math.floor(random() * 899)}`, center: true },
    { left: "" },
    { left: `Date: ${printedDate(date, currency, Math.floor(random() * 2))}`, right: `${pad(8 + Math.floor(random() * 12))}:${pad(Math.floor(random() * 60))}` },
    { left: `Order #${10000 + Math.floor(random() * 89999)}` },
    { left: "-".repeat(36) },
    ...items.map((item) => ({
      left: item.quantity > 1 ? `${item.quantity} x ${item.description} @${money(item.unit_price)}` : item.description,
      right: money(item.amount),
    })),
    { left: "-".repeat(36) },
    { left: "SUBTOTAL", right: `${symbol}${money(subtotal)}` },
    ...(taxed ? [{ left: taxLabel, right: `${symbol}${money(tax)}` }] : []),
    { left: "TOTAL", right: `${symbol}${money(total)}`, bold: true },
    { left: "" },
    ...paymentLines(random, symbol, total),
    { left: "Thank you for shopping!", center: true },
  ];

  return { receipt: { merchant, date, currency, items, subtotal, tax, total }, lines };
}

/** Card, or cash with CASH and CHANGE amounts that sit right under TOTAL and must not be mistaken for it. */
function paymentLines(random: () => number, symbol: string, total: number): Line[] {
  if (random() < 0.6) return [{ left: `VISA **** ${1000 + Math.floor(random() * 8999)}` }];
  const tendered = Math.ceil((total + 0.01) / 10) * 10 + (random() < 0.5 ? 10 : 0);
  return [
    { left: "CASH", right: `${symbol}${money(tendered)}` },
    { left: "CHANGE", right: `${symbol}${money(round2(tendered - total))}` },
  ];
}

function toSvg(lines: Line[], difficulty: Difficulty, random: () => number): string {
  const fontSize = difficulty === "small" ? 12 : 16;
  const lineHeight = Math.round(fontSize * 1.45);
  const width = difficulty === "small" ? 340 : 440;
  const margin = 24;
  const height = margin * 2 + lines.length * lineHeight;
  const ink = difficulty === "faded" ? "#9a9a9a" : difficulty === "thermal" ? "#b4b4b4" : "#151515";
  const paper = difficulty === "noisy" ? "#efe9dc" : difficulty === "thermal" ? "#fbfaf4" : "#ffffff";

  const text = lines
    .map((line, i) => {
      const y = margin + (i + 1) * lineHeight - 6;
      const weight = line.bold ? ' font-weight="bold"' : "";
      if (line.center) {
        return `<text x="${width / 2}" y="${y}" text-anchor="middle"${weight}>${escapeXml(line.left)}</text>`;
      }
      const left = `<text x="${margin}" y="${y}"${weight}>${escapeXml(line.left)}</text>`;
      const right = line.right ? `<text x="${width - margin}" y="${y}" text-anchor="end"${weight}>${escapeXml(line.right)}</text>` : "";
      return left + right;
    })
    .join("\n");

  const speckles =
    difficulty === "noisy"
      ? Array.from({ length: 420 }, () => {
          const shade = 90 + Math.floor(random() * 120);
          return `<circle cx="${(random() * width).toFixed(1)}" cy="${(random() * height).toFixed(1)}" r="${(0.4 + random() * 1.3).toFixed(2)}" fill="rgb(${shade},${shade},${shade})"/>`;
        }).join("")
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="100%" fill="${paper}"/>
<g font-family="Courier New, Courier, monospace" font-size="${fontSize}" fill="${ink}">
${text}
</g>
${speckles}
</svg>`;
}

async function render(svg: string, difficulty: Difficulty, random: () => number): Promise<{ bytes: Buffer; ext: "png" | "jpg" }> {
  // "small" renders at screen density and low JPEG quality, like a distant phone photo.
  const density = difficulty === "small" ? 72 : difficulty === "thermal" ? 108 : 144;
  let image = sharp(Buffer.from(svg), { density });
  if (difficulty === "faded") image = image.blur(0.8);
  if (difficulty === "rotated") {
    const angle = (random() < 0.5 ? -1 : 1) * (4 + random() * 4);
    image = image.rotate(angle, { background: "#ffffff" });
  }
  if (difficulty === "thermal") image = image.blur(1.1).rotate(random() < 0.5 ? -2 : 2, { background: "#fbfaf4" });
  if (difficulty === "skewed") {
    // Shear approximates a receipt photographed at an angle.
    const shear = 0.1 + random() * 0.08;
    image = image.affine([1, shear, shear / 2, 1], { background: "#ffffff" });
  }
  if (difficulty === "small" || difficulty === "thermal") {
    return { bytes: await image.jpeg({ quality: difficulty === "small" ? 55 : 60 }).toBuffer(), ext: "jpg" };
  }
  return { bytes: await image.png({ compressionLevel: 9 }).toBuffer(), ext: "png" };
}

export async function generateDataset(outDir: string, count: number, seed: number): Promise<LabeledReceipt[]> {
  const random = rng(seed);
  mkdirSync(outDir, { recursive: true });
  const labels: LabeledReceipt[] = [];
  for (let i = 0; i < count; i++) {
    const difficulty = DIFFICULTIES[i % DIFFICULTIES.length]!;
    const { receipt, lines } = buildReceipt(random, i);
    const { bytes, ext } = await render(toSvg(lines, difficulty, random), difficulty, random);
    const file = `receipt-${pad(i + 1)}.${ext}`;
    writeFileSync(join(outDir, file), bytes);
    labels.push({ file, difficulty, receipt });
  }
  writeFileSync(join(outDir, "labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
  return labels;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      count: { type: "string", default: "28" },
      seed: { type: "string", default: "20261015" },
      out: { type: "string", default: fileURLToPath(new URL("../dataset", import.meta.url)) },
    },
  });
  const labels = await generateDataset(values.out, Number(values.count), Number(values.seed));
  const byDifficulty = labels.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.difficulty]: (acc[l.difficulty] ?? 0) + 1 }), {});
  console.log(`Wrote ${labels.length} receipts to ${values.out}`, byDifficulty);
}
