import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Budget, BudgetExceededError, type Ledger } from "../src/budget.js";

const tempLedger = () => join(mkdtempSync(join(tmpdir(), "modelgate-")), "ledger.json");

describe("Budget", () => {
  it("warns once at the threshold and blocks at the limit", () => {
    const alerts = new Alerts({ log: () => {} });
    const budget = new Budget({ limitUsd: 1, warnAt: 0.8, alerts });

    budget.record(0.5);
    budget.record(0.35); // crosses 80%
    budget.record(0.01);
    expect(alerts.sent.filter((a) => a.kind === "budget_warning")).toHaveLength(1);

    budget.assertAvailable();
    budget.record(0.2);
    expect(() => budget.assertAvailable()).toThrow(BudgetExceededError);
  });

  it("persists spend so a restarted server and the budget-guard hook see it", () => {
    const file = tempLedger();
    new Budget({ limitUsd: 5, warnAt: 0.8, file }).record(1.25);

    const reloaded = new Budget({ limitUsd: 5, warnAt: 0.8, file });
    expect(reloaded.snapshot().spentUsd).toBeCloseTo(1.25);
    const ledger = JSON.parse(readFileSync(file, "utf8")) as Ledger;
    expect(ledger).toMatchObject({ spentUsd: 1.25, limitUsd: 5 });
  });

  it("starts a new period at the month boundary", () => {
    const file = tempLedger();
    let now = new Date("2026-09-30T23:59:00Z");
    const budget = new Budget({ limitUsd: 1, warnAt: 0.8, file, now: () => now });
    budget.record(2);
    expect(() => budget.assertAvailable()).toThrow(BudgetExceededError);

    now = new Date("2026-10-01T00:01:00Z");
    expect(() => budget.assertAvailable()).not.toThrow();
    expect(budget.snapshot()).toMatchObject({ period: "2026-10", spentUsd: 0 });
  });

  it("tracks spend without blocking when the limit is 0", () => {
    const budget = new Budget({ limitUsd: 0, warnAt: 0.8 });
    budget.record(100);
    expect(() => budget.assertAvailable()).not.toThrow();
    expect(budget.snapshot().remainingUsd).toBeNull();
  });
});
