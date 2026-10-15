import type { AdoptionRecord, UsageRecord } from "./usage.js";

export interface Report {
  period: string;
  requests: number;
  succeeded: number;
  successRate: number;
  fallbackRate: number;
  silentFailuresCaught: number;
  silentFailuresByIssue: Record<string, number>;
  budgetBlocked: number;
  totalCostUsd: number;
  costPerSuccessUsd: number;
  costByVendor: Record<string, number>;
  servedByVendor: Record<string, number>;
  latencyP50Ms: number;
  latencyP95Ms: number;
  adoption: { sessions: number; toolCalls: number; failedToolCalls: number };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

const bump = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

/** Adoption, cost and outcome numbers from the usage and adoption logs, with no manual reporting. */
export function summarize(usage: UsageRecord[], adoption: AdoptionRecord[], period?: string): Report {
  const inPeriod = <T extends { ts: string }>(rows: T[]) => (period ? rows.filter((r) => r.ts.startsWith(period)) : rows);
  const rows = inPeriod(usage);
  const calls = inPeriod(adoption);

  const ok = rows.filter((r) => r.outcome === "ok");
  const silentFailuresByIssue: Record<string, number> = {};
  const costByVendor: Record<string, number> = {};
  const servedByVendor: Record<string, number> = {};

  for (const row of rows) {
    for (const attempt of row.attempts) {
      if (attempt.costUsd > 0) bump(costByVendor, attempt.vendor, attempt.costUsd);
      if (attempt.outcome === "invalid") bump(silentFailuresByIssue, attempt.reason?.split(":")[0] ?? "unknown");
    }
    if (row.outcome === "ok" && row.vendor) bump(servedByVendor, row.vendor);
  }

  const totalCostUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const latencies = ok.map((r) => r.latencyMs);
  return {
    period: period ?? "all",
    requests: rows.length,
    succeeded: ok.length,
    successRate: rows.length ? ok.length / rows.length : 0,
    fallbackRate: ok.length ? ok.filter((r) => r.fellBack).length / ok.length : 0,
    silentFailuresCaught: Object.values(silentFailuresByIssue).reduce((a, b) => a + b, 0),
    silentFailuresByIssue,
    budgetBlocked: rows.filter((r) => r.outcome === "budget_exceeded").length,
    totalCostUsd,
    costPerSuccessUsd: ok.length ? totalCostUsd / ok.length : 0,
    costByVendor,
    servedByVendor,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    adoption: {
      sessions: new Set(calls.map((c) => c.sessionId)).size,
      toolCalls: calls.length,
      failedToolCalls: calls.filter((c) => !c.ok).length,
    },
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(4)}`;

export function renderReport(r: Report): string {
  const table = (map: Record<string, number>, format: (n: number) => string) =>
    Object.keys(map).length === 0
      ? "_none_"
      : Object.entries(map)
          .sort(([, a], [, b]) => b - a)
          .map(([k, v]) => `${k} ${format(v)}`)
          .join(", ");

  return [
    `# ModelGate report (${r.period})`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Requests | ${r.requests} |`,
    `| Success rate | ${pct(r.successRate)} |`,
    `| Served after fallback | ${pct(r.fallbackRate)} |`,
    `| Silent failures caught | ${r.silentFailuresCaught} (${table(r.silentFailuresByIssue, String)}) |`,
    `| Blocked by budget | ${r.budgetBlocked} |`,
    `| Total cost | ${usd(r.totalCostUsd)} |`,
    `| Cost per successful extraction | ${usd(r.costPerSuccessUsd)} |`,
    `| Cost by vendor | ${table(r.costByVendor, usd)} |`,
    `| Served by vendor | ${table(r.servedByVendor, String)} |`,
    `| Latency p50 / p95 | ${Math.round(r.latencyP50Ms)} ms / ${Math.round(r.latencyP95Ms)} ms |`,
    `| Agent sessions using ModelGate | ${r.adoption.sessions} |`,
    `| Agent tool calls (failed) | ${r.adoption.toolCalls} (${r.adoption.failedToolCalls}) |`,
    "",
  ].join("\n");
}
