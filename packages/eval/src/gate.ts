/**
 * Regression gate for prompt and provider changes. CI runs the eval on a pull
 * request and this script fails the build when a candidate gets worse than the
 * committed baseline.
 *
 *   npm run eval:gate        # compare packages/eval/results/latest.json with packages/eval/baseline.json
 *   npm run eval:baseline    # promote latest to baseline (after review, in the same PR)
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CandidateSummary, EvalResults } from "./run.js";

export const THRESHOLDS = {
  /** Absolute drop in field accuracy (0.02 = 2 points). */
  accuracyDrop: 0.02,
  /** Absolute drop in the share of documents with valid output. */
  validRateDrop: 0.05,
  /** Relative increase in cost per document. */
  costIncrease: 0.25,
};

export interface GateFinding {
  candidate: string;
  metric: "fieldAccuracy" | "validRate" | "costPerDocUsd";
  baseline: number;
  latest: number;
}

export function compare(baseline: EvalResults, latest: EvalResults): GateFinding[] {
  const findings: GateFinding[] = [];
  const byId = new Map<string, CandidateSummary>(baseline.candidates.map((c) => [c.id, c]));
  for (const now of latest.candidates) {
    const before = byId.get(now.id);
    if (!before) continue;
    if (before.fieldAccuracy - now.fieldAccuracy > THRESHOLDS.accuracyDrop) {
      findings.push({ candidate: now.id, metric: "fieldAccuracy", baseline: before.fieldAccuracy, latest: now.fieldAccuracy });
    }
    if (before.validRate - now.validRate > THRESHOLDS.validRateDrop) {
      findings.push({ candidate: now.id, metric: "validRate", baseline: before.validRate, latest: now.validRate });
    }
    if (before.costPerDocUsd > 0 && now.costPerDocUsd > before.costPerDocUsd * (1 + THRESHOLDS.costIncrease)) {
      findings.push({ candidate: now.id, metric: "costPerDocUsd", baseline: before.costPerDocUsd, latest: now.costPerDocUsd });
    }
  }
  return findings;
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { values } = parseArgs({
    options: {
      baseline: { type: "string", default: `${root}baseline.json` },
      latest: { type: "string", default: `${root}results/latest.json` },
      promote: { type: "boolean", default: false },
    },
  });

  if (!existsSync(values.latest)) {
    console.error(`No eval results at ${values.latest}. Run \`npm run eval\` first.`);
    process.exit(1);
  }
  if (values.promote) {
    const latest = JSON.parse(readFileSync(values.latest, "utf8")) as EvalResults;
    if (latest.budgetExhausted) {
      console.error("Refusing to promote: the latest run hit its --max-usd cap and is incomplete.");
      process.exit(1);
    }
    copyFileSync(values.latest, values.baseline);
    console.log(`Promoted ${values.latest} to ${values.baseline}. Commit it with the change that produced it.`);
    return;
  }
  if (!existsSync(values.baseline)) {
    console.log("No baseline yet; nothing to compare. Review the results, then run `npm run eval:baseline`.");
    return;
  }

  const baseline = JSON.parse(readFileSync(values.baseline, "utf8")) as EvalResults;
  const latest = JSON.parse(readFileSync(values.latest, "utf8")) as EvalResults;
  if (latest.budgetExhausted) {
    console.error("The latest run hit its --max-usd cap before finishing, so it cannot be compared. Rerun with a higher cap.");
    process.exit(1);
  }
  if (baseline.dataset.size !== latest.dataset.size) {
    console.error(`Dataset size differs (baseline ${baseline.dataset.size}, latest ${latest.dataset.size}); results are not comparable.`);
    process.exit(1);
  }
  const shared = latest.candidates.filter((c) => baseline.candidates.some((b) => b.id === c.id));
  if (shared.length === 0) {
    console.error("The latest run shares no candidates with the baseline, so nothing was compared.");
    process.exit(1);
  }

  const findings = compare(baseline, latest);
  console.log(`Prompt v${baseline.promptVersion} -> v${latest.promptVersion}, ${shared.length} candidate(s) compared.`);
  if (findings.length === 0) {
    console.log("No regressions beyond thresholds.");
    return;
  }
  for (const f of findings) {
    console.error(`REGRESSION ${f.candidate} ${f.metric}: ${f.baseline.toFixed(4)} -> ${f.latest.toFixed(4)}`);
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
