/**
 * Vendor and model evaluation over the labeled dataset.
 *
 * Each candidate runs on its own (same prompt, retries and validation as
 * production, no fallback) so its raw accuracy, reliability, latency and cost
 * are measured in isolation. Then the full routing chain runs as "routed" to
 * show what production delivers with fallback. Results go to
 * packages/eval/results/latest.json (read by the CI gate) and EVAL.md at the repo root (for people).
 *
 *   npm run eval                                       # vendors from your env
 *   npm run eval -- --candidates anthropic,openai:gpt-5.4-mini,gemini --max-usd 3
 *   npm run eval -- --candidates mock --markdown none  # offline smoke test
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  Alerts,
  AllVendorsFailedError,
  Budget,
  BudgetExceededError,
  CircuitBreaker,
  createProvider,
  DEFAULT_MODELS,
  loadConfig,
  loadPrompt,
  parseVendorSpec,
  percentile,
  Router,
  sniffMime,
  specId,
  type Config,
  type Prompt,
  type VisionProvider,
} from "@modelgate/core";
import { ClaudeCodeProvider } from "./claude-code-provider.js";
import type { LabeledReceipt } from "./generate-dataset.js";
import { FIELDS, scoreReceipt, type Field, type ReceiptScore } from "./score.js";

export interface DocResult {
  file: string;
  difficulty: string;
  ok: boolean;
  vendor?: string;
  costUsd: number;
  latencyMs: number;
  silentFailures: number;
  error?: string;
  score: ReceiptScore;
}

export interface CandidateSummary {
  id: string;
  /** "reference" candidates (Claude Code login) report accuracy only; their cost and latency are not comparable. */
  kind: "vendor" | "routed" | "reference";
  docs: number;
  fieldAccuracy: number;
  exactMatch: number;
  /** Share of documents that produced an output passing validation. */
  validRate: number;
  silentFailuresCaught: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  costPerDocUsd: number;
  costPer1kDocsUsd: number;
  byDifficulty: Record<string, number>;
  byField: Record<Field, number>;
  /** Every document that was not an exact match: the starting point for prompt work. */
  misses: Array<{ file: string; difficulty: string; vendor?: string; wrongFields: Field[]; error?: string }>;
}

export interface EvalResults {
  generatedAt: string;
  promptVersion: number;
  dataset: { size: number; source: string };
  /** True when the --max-usd cap stopped the run early; such results are not comparable. */
  budgetExhausted: boolean;
  candidates: CandidateSummary[];
  recommendation: { primary: string | null; order: string[]; rationale: string };
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(ROOT, "../..");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function runCandidate(
  providers: VisionProvider[],
  labels: LabeledReceipt[],
  datasetDir: string,
  deps: { config: Config; prompt: Prompt; budget: Budget; routed: boolean; concurrency: number },
): Promise<DocResult[]> {
  const { config } = deps;
  const router = new Router(providers, {
    budget: deps.budget,
    // Single-vendor runs keep the breaker shut so every document is measured.
    breaker: new CircuitBreaker(deps.routed ? config.breakerThreshold : Number.MAX_SAFE_INTEGER, config.breakerCooldownMs),
    alerts: new Alerts({ log: () => {} }),
    prompt: deps.prompt,
    options: {
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.baseDelayMs,
      quotaCooldownMs: config.quotaCooldownMs,
    },
  });

  let budgetHit = false;
  return pool(labels, deps.concurrency, async (label): Promise<DocResult> => {
    const base = { file: label.file, difficulty: label.difficulty };
    if (budgetHit) return { ...base, ok: false, costUsd: 0, latencyMs: 0, silentFailures: 0, error: "skipped: eval budget exhausted", score: scoreReceipt(label.receipt, null) };

    const bytes = readFileSync(join(datasetDir, label.file));
    const mimeType = sniffMime(bytes);
    if (!mimeType) throw new Error(`${label.file} is not a supported image`);
    const started = Date.now();
    try {
      const result = await router.extract(bytes, mimeType);
      return {
        ...base,
        ok: true,
        vendor: `${result.vendor}:${result.model}`,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        silentFailures: result.attempts.filter((a) => a.outcome === "invalid").length,
        score: scoreReceipt(label.receipt, result.receipt),
      };
    } catch (err) {
      if (err instanceof BudgetExceededError) budgetHit = true;
      const attempts = err instanceof AllVendorsFailedError ? err.attempts : [];
      return {
        ...base,
        ok: false,
        costUsd: attempts.reduce((sum, a) => sum + a.costUsd, 0),
        latencyMs: Date.now() - started,
        silentFailures: attempts.filter((a) => a.outcome === "invalid").length,
        error: err instanceof Error ? err.message : String(err),
        score: scoreReceipt(label.receipt, null),
      };
    }
  });
}

export function summarizeCandidate(id: string, kind: CandidateSummary["kind"], docs: DocResult[]): CandidateSummary {
  const ok = docs.filter((d) => d.ok);
  const cost = docs.reduce((sum, d) => sum + d.costUsd, 0);
  const difficulties = [...new Set(docs.map((d) => d.difficulty))];
  return {
    id,
    kind,
    docs: docs.length,
    fieldAccuracy: mean(docs.map((d) => d.score.accuracy)),
    exactMatch: mean(docs.map((d) => (d.score.exact ? 1 : 0))),
    validRate: docs.length ? ok.length / docs.length : 0,
    silentFailuresCaught: docs.reduce((sum, d) => sum + d.silentFailures, 0),
    errors: docs.length - ok.length,
    p50Ms: percentile(ok.map((d) => d.latencyMs), 50),
    p95Ms: percentile(ok.map((d) => d.latencyMs), 95),
    costPerDocUsd: docs.length ? cost / docs.length : 0,
    costPer1kDocsUsd: docs.length ? (cost / docs.length) * 1000 : 0,
    byDifficulty: Object.fromEntries(difficulties.map((level) => [level, mean(docs.filter((d) => d.difficulty === level).map((d) => d.score.accuracy))])),
    byField: Object.fromEntries(FIELDS.map((f) => [f, mean(docs.map((d) => (d.score.fields[f] ? 1 : 0)))])) as Record<Field, number>,
    misses: docs
      .filter((d) => !d.score.exact)
      .map((d) => ({
        file: d.file,
        difficulty: d.difficulty,
        ...(d.vendor ? { vendor: d.vendor } : {}),
        wrongFields: FIELDS.filter((f) => !d.score.fields[f]),
        ...(d.error ? { error: d.error } : {}),
      })),
  };
}

/**
 * Primary = the cheapest vendor within one accuracy point of the best, among
 * vendors that return valid output for at least 90% of documents. The rest
 * follow by accuracy, then cost, as fallbacks.
 */
export function recommend(candidates: CandidateSummary[]): EvalResults["recommendation"] {
  if (!candidates.some((c) => c.kind === "vendor")) {
    return {
      primary: null,
      order: [],
      rationale: "Only reference candidates (Claude Code login) were run, so there is no cost to compare. Run API-key vendors for a routing recommendation.",
    };
  }
  const vendors = candidates.filter((c) => c.kind === "vendor" && c.validRate >= 0.9);
  if (vendors.length === 0) {
    return { primary: null, order: [], rationale: "No candidate returned valid output for at least 90% of documents." };
  }
  const best = Math.max(...vendors.map((c) => c.fieldAccuracy));
  const [primary] = vendors.filter((c) => c.fieldAccuracy >= best - 0.01).sort((a, b) => a.costPerDocUsd - b.costPerDocUsd);
  const rest = vendors
    .filter((c) => c !== primary)
    .sort((a, b) => b.fieldAccuracy - a.fieldAccuracy || a.costPerDocUsd - b.costPerDocUsd);
  const order = [primary!, ...rest].map((c) => c.id);
  const topScorer = vendors.find((c) => c.fieldAccuracy === best)!;
  const rationale =
    topScorer === primary
      ? `${primary!.id} has the best field accuracy (${(best * 100).toFixed(1)}%) and is the cheapest candidate within one point of it at $${primary!.costPer1kDocsUsd.toFixed(2)} per 1k documents.`
      : `${primary!.id} is within one point of the best field accuracy (${(primary!.fieldAccuracy * 100).toFixed(1)}% vs ${(best * 100).toFixed(1)}% for ${topScorer.id}) at $${primary!.costPer1kDocsUsd.toFixed(2)} vs $${topScorer.costPer1kDocsUsd.toFixed(2)} per 1k documents.`;
  return { primary: primary!.id, order, rationale };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function renderMarkdown(results: EvalResults): string {
  const label = (c: CandidateSummary) => {
    const name = c.id === "routed" ? "**routed (production chain)**" : `\`${c.id}\``;
    return c.kind === "reference" ? `${name} (reference)` : name;
  };
  const rows = results.candidates.map((c) =>
    c.kind === "reference"
      ? `| ${label(c)} | ${pct(c.fieldAccuracy)} | ${pct(c.exactMatch)} | ${pct(c.validRate)} | ${c.silentFailuresCaught} | n/a | n/a | n/a |`
      : `| ${label(c)} | ${pct(c.fieldAccuracy)} | ${pct(c.exactMatch)} | ${pct(c.validRate)} | ${c.silentFailuresCaught} | ${Math.round(c.p50Ms)} / ${Math.round(c.p95Ms)} ms | $${c.costPerDocUsd.toFixed(5)} | $${c.costPer1kDocsUsd.toFixed(2)} |`,
  );
  const hasReference = results.candidates.some((c) => c.kind === "reference");
  const difficulties = Object.keys(results.candidates[0]?.byDifficulty ?? {});
  const diffRows = results.candidates.map((c) => `| \`${c.id}\` | ${difficulties.map((d) => pct(c.byDifficulty[d] ?? 0)).join(" | ")} |`);
  const fieldRows = results.candidates.map((c) => `| \`${c.id}\` | ${FIELDS.map((f) => pct(c.byField[f])).join(" | ")} |`);
  const { recommendation: rec } = results;

  return `# Vendor evaluation

Generated ${results.generatedAt} · prompt \`extract-receipt\` v${results.promptVersion} · ${results.dataset.size} ${results.dataset.source} receipts

| Candidate | Field accuracy | Exact match | Valid output | Silent failures caught | Latency p50 / p95 | Cost / doc | Cost / 1k docs |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## Recommendation

${rec.primary ? `${rec.rationale}\n\n\`\`\`bash\nMODELGATE_VENDORS=${rec.order.join(",")}\n\`\`\`` : rec.rationale}

## Accuracy by difficulty

| Candidate | ${difficulties.join(" | ")} |
|---|${difficulties.map(() => "---").join("|")}|
${diffRows.join("\n")}

## Accuracy by field

| Candidate | ${FIELDS.join(" | ")} |
|---|${FIELDS.map(() => "---").join("|")}|
${fieldRows.join("\n")}

## Misses

${
  results.candidates.every((c) => c.misses.length === 0)
    ? "Every document was an exact match."
    : results.candidates
        .filter((c) => c.misses.length > 0)
        .map((c) => `- \`${c.id}\`: ${c.misses.map((m) => `${m.file} (${m.difficulty}; ${m.error ? m.error.slice(0, 80) : `wrong ${m.wrongFields.join(", ")}`}${m.vendor ? ` via ${m.vendor}` : ""})`).join("; ")}`)
        .join("\n")
}

## Method

- Each candidate runs alone with production settings (same prompt, retries and validation, no fallback). "routed" runs the full chain in \`MODELGATE_VENDORS\` order.
- Field accuracy is the share of 7 fields (merchant, date, currency, items, subtotal, tax, total) that match the label. Money matches within 0.01; items match by name and amount.
- Silent failures caught are HTTP 200 responses rejected by validation (refusals, truncation, invalid JSON, schema misses, empty fields, totals that do not add up).
- Cost is computed from each response's token usage and the price table in \`src/pricing.ts\`.${hasReference ? "\n- Reference rows ran through the Claude Agent SDK on a Claude Code login, not an API key. Their accuracy is comparable; cost and latency are not (the Claude Code harness adds context and a process start to every call), so they are excluded from the recommendation." : ""}
- Reproduce: \`npm run eval -- --candidates ${results.candidates.filter((c) => c.id !== "routed").map((c) => c.id).join(",")}\`
`;
}

interface Candidate {
  id: string;
  kind: "vendor" | "reference";
  provider: () => VisionProvider;
}

/** "vendor[:model]" for API vendors, or "claude-code[:model]" for an accuracy-only run on a Claude Code login. */
function toCandidate(spec: string, config: Config): Candidate {
  const [name, ...rest] = spec.split(":");
  if (name === "claude-code") {
    const model = rest.join(":") || DEFAULT_MODELS.anthropic;
    return { id: `claude-code:${model}`, kind: "reference", provider: () => new ClaudeCodeProvider(model) };
  }
  const vendorSpec = parseVendorSpec(spec);
  return { id: specId(vendorSpec), kind: "vendor", provider: () => createProvider(vendorSpec, config) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      candidates: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "max-usd": { type: "string", default: "2" },
      routed: { type: "boolean", default: true },
      dataset: { type: "string", default: join(ROOT, "dataset") },
      out: { type: "string", default: join(ROOT, "results/latest.json") },
      markdown: { type: "string", default: join(REPO, "EVAL.md") },
    },
    allowNegative: true,
  });

  const config = loadConfig();
  const candidates: Candidate[] = values.candidates
    ? values.candidates.split(",").map((s) => toCandidate(s.trim(), config))
    : config.vendors.map((spec) => ({ id: specId(spec), kind: "vendor" as const, provider: () => createProvider(spec, config) }));
  if (candidates.length === 0) {
    console.error("No candidates. Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) or pass --candidates mock.");
    process.exit(1);
  }

  const allLabels = JSON.parse(readFileSync(join(values.dataset, "labels.json"), "utf8")) as LabeledReceipt[];
  const labels = values.limit ? allLabels.slice(0, Number(values.limit)) : allLabels;
  const prompt = loadPrompt();
  // One in-memory budget caps the whole run; eval spend never touches the production ledger.
  // Calls already in flight when the cap is reached still complete, so a run can
  // overshoot by up to `concurrency` calls.
  const budget = new Budget({ limitUsd: Number(values["max-usd"]), warnAt: 1 });
  const deps = { config, prompt, budget, concurrency: Number(values.concurrency) };

  console.error(`Evaluating ${candidates.map((c) => c.id).join(", ")} on ${labels.length} receipts (prompt v${prompt.version}, cap $${values["max-usd"]})`);
  const summaries: CandidateSummary[] = [];
  let budgetExhausted = false;
  const track = (docs: DocResult[]) => {
    if (docs.some((d) => d.error?.startsWith("skipped: eval budget") || d.error?.startsWith("Monthly AI budget"))) budgetExhausted = true;
    return docs;
  };
  for (const candidate of candidates) {
    const docs = track(await runCandidate([candidate.provider()], labels, values.dataset, { ...deps, routed: false }));
    summaries.push(summarizeCandidate(candidate.id, candidate.kind, docs));
    console.error(`  ${candidate.id}: ${pct(summaries.at(-1)!.fieldAccuracy)} field accuracy`);
  }
  if (values.routed && candidates.length > 1) {
    const docs = track(await runCandidate(candidates.map((c) => c.provider()), labels, values.dataset, { ...deps, routed: true }));
    // A chain containing any reference candidate inherits its non-comparable cost and latency.
    summaries.push(summarizeCandidate("routed", candidates.some((c) => c.kind === "reference") ? "reference" : "routed", docs));
  }

  const results: EvalResults = {
    generatedAt: new Date().toISOString(),
    promptVersion: prompt.version,
    dataset: { size: labels.length, source: allLabels.length === labels.length ? "synthetic" : `synthetic (first ${labels.length})` },
    budgetExhausted,
    candidates: summaries,
    recommendation: recommend(summaries),
  };

  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
  if (values.markdown !== "none") writeFileSync(values.markdown, renderMarkdown(results));

  console.table(
    summaries.map((c) => ({
      candidate: c.id,
      accuracy: pct(c.fieldAccuracy),
      exact: pct(c.exactMatch),
      valid: pct(c.validRate),
      silentFailures: c.silentFailuresCaught,
      p95Ms: Math.round(c.p95Ms),
      per1k: `$${c.costPer1kDocsUsd.toFixed(2)}`,
    })),
  );
  console.error(results.recommendation.rationale);
  if (budgetExhausted) console.error(`WARNING: the $${values["max-usd"]} cap stopped the run early. Results are incomplete; rerun with a higher --max-usd.`);
  console.error(`Spent $${budget.snapshot().spentUsd.toFixed(4)}. Wrote ${values.out}${values.markdown !== "none" ? ` and ${values.markdown}` : ""}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
