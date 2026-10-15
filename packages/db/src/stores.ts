import { Alerts, BudgetExceededError, type BudgetGuard, type BudgetSnapshot, type UsageRecord, type UsageSink } from "@modelgate/core";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { budgetLedger, usageRecords } from "./schema.js";

export interface PostgresBudgetOptions {
  limitUsd: number;
  warnAt: number;
  alerts?: Alerts;
  now?: () => Date;
}

/** BudgetGuard backed by Postgres: one monthly limit shared by every API instance and MCP server. */
export class PostgresBudget implements BudgetGuard {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly options: PostgresBudgetOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private period(): string {
    return this.now().toISOString().slice(0, 7);
  }

  private async spent(period: string): Promise<number> {
    const [row] = await this.db.select({ spentUsd: budgetLedger.spentUsd }).from(budgetLedger).where(eq(budgetLedger.period, period));
    return row?.spentUsd ?? 0;
  }

  async assertAvailable(): Promise<void> {
    const period = this.period();
    const spentUsd = await this.spent(period);
    const { limitUsd } = this.options;
    if (limitUsd > 0 && spentUsd >= limitUsd) {
      void this.options.alerts?.send(
        "budget_exhausted",
        `Spent $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} this month; extraction is blocked.`,
        { spentUsd, limitUsd },
        period,
      );
      throw new BudgetExceededError(spentUsd, limitUsd);
    }
  }

  async record(usd: number): Promise<void> {
    const period = this.period();
    const { limitUsd, warnAt } = this.options;
    // Atomic increment in one statement, so concurrent writers never lose spend.
    const [row] = await this.db
      .insert(budgetLedger)
      .values({ period, spentUsd: usd, limitUsd })
      .onConflictDoUpdate({ target: budgetLedger.period, set: { spentUsd: sql`${budgetLedger.spentUsd} + ${usd}`, limitUsd } })
      .returning();
    if (!row || limitUsd <= 0 || row.warned || row.spentUsd < limitUsd * warnAt) return;

    // Exactly one process wins this update, so the warning fires once per month across all of them.
    const claimed = await this.db
      .update(budgetLedger)
      .set({ warned: true })
      .where(and(eq(budgetLedger.period, period), eq(budgetLedger.warned, false)))
      .returning();
    if (claimed.length > 0) {
      void this.options.alerts?.send(
        "budget_warning",
        `Spent $${row.spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} (${Math.round(warnAt * 100)}% threshold).`,
        { spentUsd: row.spentUsd, limitUsd },
        period,
      );
    }
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const period = this.period();
    const spentUsd = await this.spent(period);
    const { limitUsd, warnAt } = this.options;
    return { period, spentUsd, limitUsd, remainingUsd: limitUsd > 0 ? Math.max(0, limitUsd - spentUsd) : null, warnAt };
  }
}

/** UsageSink backed by Postgres. `source` records which surface served the request. */
export class PostgresUsageLog implements UsageSink {
  constructor(
    private readonly db: Database,
    private readonly source: "mcp" | "api",
  ) {}

  async append(record: UsageRecord): Promise<void> {
    await this.db.insert(usageRecords).values({
      requestId: record.requestId,
      ts: new Date(record.ts),
      source: this.source,
      outcome: record.outcome,
      vendor: record.vendor ?? null,
      model: record.model ?? null,
      promptVersion: record.promptVersion,
      costUsd: record.costUsd,
      latencyMs: Math.round(record.latencyMs),
      fellBack: record.fellBack,
      silentFailures: record.silentFailures,
      attempts: record.attempts,
      warnings: record.warnings,
    });
  }

  async read(period?: string): Promise<UsageRecord[]> {
    const where = period ? and(gte(usageRecords.ts, monthStart(period, 0)), lt(usageRecords.ts, monthStart(period, 1))) : undefined;
    const rows = await this.db.select().from(usageRecords).where(where).orderBy(usageRecords.ts);
    return rows.map((row) => ({
      ts: row.ts.toISOString(),
      requestId: row.requestId,
      outcome: row.outcome,
      ...(row.vendor ? { vendor: row.vendor } : {}),
      ...(row.model ? { model: row.model } : {}),
      promptVersion: row.promptVersion,
      costUsd: row.costUsd,
      latencyMs: row.latencyMs,
      fellBack: row.fellBack,
      silentFailures: row.silentFailures,
      attempts: row.attempts,
      warnings: row.warnings,
    }));
  }
}

function monthStart(period: string, offset: number): Date {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1 + offset, 1));
}
