import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Alerts } from "./alerts.js";

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly limitUsd: number) {
    super(`Monthly AI budget exhausted: $${spentUsd.toFixed(4)} spent of $${limitUsd.toFixed(2)}. Raise MODELGATE_BUDGET_USD or wait for the next period.`);
    this.name = "BudgetExceededError";
  }
}

/** On-disk shape. The budget-guard hook reads this file directly, so keep it stable. */
export interface Ledger {
  period: string;
  spentUsd: number;
  limitUsd: number;
  warned: boolean;
}

export interface BudgetOptions {
  limitUsd: number;
  warnAt: number;
  /** Ledger path. Omit for an in-memory budget (evals, tests). */
  file?: string;
  alerts?: Alerts;
  now?: () => Date;
}

export interface BudgetSnapshot {
  period: string;
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number | null;
  warnAt: number;
}

/**
 * What the router needs from a budget. `Budget` below keeps the ledger in a
 * local file (the MCP server's default); @modelgate/db implements the same
 * contract in Postgres so several processes share one monthly limit.
 */
export interface BudgetGuard {
  /** Throws BudgetExceededError before any vendor call once the limit is reached. */
  assertAvailable(): void | Promise<void>;
  record(usd: number): void | Promise<void>;
  snapshot(): BudgetSnapshot | Promise<BudgetSnapshot>;
}

/**
 * Monthly spend ledger for pay-per-call vendors. Warns once at the threshold
 * and hard-stops at the limit before a call is made. A limit of 0 disables the
 * hard stop but still tracks spend.
 */
export class Budget implements BudgetGuard {
  private ledger: Ledger;
  private readonly now: () => Date;

  constructor(private readonly options: BudgetOptions) {
    this.now = options.now ?? (() => new Date());
    this.ledger = this.load();
  }

  private period(): string {
    return this.now().toISOString().slice(0, 7);
  }

  private fresh(): Ledger {
    return { period: this.period(), spentUsd: 0, limitUsd: this.options.limitUsd, warned: false };
  }

  private load(): Ledger {
    if (!this.options.file) return this.fresh();
    try {
      const saved = JSON.parse(readFileSync(this.options.file, "utf8")) as Ledger;
      if (saved.period === this.period() && Number.isFinite(saved.spentUsd)) {
        return { ...saved, limitUsd: this.options.limitUsd };
      }
    } catch {
      // Missing or unreadable ledger: start the period from zero.
    }
    return this.fresh();
  }

  private persist(): void {
    if (!this.options.file) return;
    mkdirSync(dirname(this.options.file), { recursive: true });
    const tmp = `${this.options.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.ledger, null, 2));
    renameSync(tmp, this.options.file);
  }

  private rollover(): void {
    if (this.ledger.period !== this.period()) this.ledger = this.fresh();
  }

  /** Throws before any vendor call once the limit is reached. */
  assertAvailable(): void {
    this.rollover();
    const { limitUsd, spentUsd } = this.ledger;
    if (limitUsd > 0 && spentUsd >= limitUsd) {
      void this.options.alerts?.send(
        "budget_exhausted",
        `Spent $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} this month; extraction is blocked.`,
        { spentUsd, limitUsd },
        this.ledger.period,
      );
      throw new BudgetExceededError(spentUsd, limitUsd);
    }
  }

  record(usd: number): void {
    this.rollover();
    this.ledger.spentUsd += usd;
    const { limitUsd, spentUsd } = this.ledger;
    if (limitUsd > 0 && !this.ledger.warned && spentUsd >= limitUsd * this.options.warnAt) {
      this.ledger.warned = true;
      void this.options.alerts?.send(
        "budget_warning",
        `Spent $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} (${Math.round(this.options.warnAt * 100)}% threshold).`,
        { spentUsd, limitUsd },
        this.ledger.period,
      );
    }
    this.persist();
  }

  snapshot(): BudgetSnapshot {
    this.rollover();
    const { period, spentUsd, limitUsd } = this.ledger;
    return {
      period,
      spentUsd,
      limitUsd,
      remainingUsd: limitUsd > 0 ? Math.max(0, limitUsd - spentUsd) : null,
      warnAt: this.options.warnAt,
    };
  }
}
