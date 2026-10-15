import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Alerts, Budget } from "@modelgate/core";
import { describe, expect, it } from "vitest";
import { connect, PostgresBudget, PostgresUsageLog } from "../src/index.js";

describe("Postgres stores", () => {
  it("creates a missing data directory for on-disk PGlite and keeps data across restarts", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "modelgate-pg-")), "fresh", "home", "pglite");

    const first = await connect({ dataDir });
    await new PostgresBudget(first.db, { limitUsd: 5, warnAt: 0.8 }).record(1.25);
    await first.close();

    const second = await connect({ dataDir });
    expect((await new PostgresBudget(second.db, { limitUsd: 5, warnAt: 0.8 }).snapshot()).spentUsd).toBeCloseTo(1.25);
    await second.close();
  });

  it("share one ledger across instances, with an atomic increment and a single warning", async () => {
    const shared = await connect();
    const warnings: string[] = [];
    const alerts = new Alerts({ log: (line) => warnings.push(line) });
    const a = new PostgresBudget(shared.db, { limitUsd: 1, warnAt: 0.5, alerts });
    const b = new PostgresBudget(shared.db, { limitUsd: 1, warnAt: 0.5, alerts: new Alerts({ log: (line) => warnings.push(line) }) });

    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).record(0.07)));

    expect((await a.snapshot()).spentUsd).toBeCloseTo(0.7);
    expect((await b.snapshot()).spentUsd).toBeCloseTo(0.7);
    expect(warnings.filter((w) => w.includes("budget_warning"))).toHaveLength(1);
    await shared.close();
  });

  it("round-trips usage records and filters by month", async () => {
    const shared = await connect();
    const usage = new PostgresUsageLog(shared.db, "mcp");
    const record = {
      ts: "2026-09-30T23:59:59.000Z",
      requestId: "8b0d6c2e-9a43-4a8e-9a39-6e3f1c3d2f10",
      outcome: "ok" as const,
      vendor: "openai" as const,
      model: "gpt-5-mini",
      promptVersion: 3,
      costUsd: 0.0012,
      latencyMs: 2100,
      fellBack: true,
      silentFailures: 1,
      attempts: [{ vendor: "anthropic" as const, model: "claude-opus-5-5", attempt: 1, outcome: "invalid" as const, reason: "schema_mismatch: x", latencyMs: 900, costUsd: 0.01 }],
      warnings: ["w"],
    };
    await usage.append(record);
    expect(await usage.read("2026-09")).toEqual([record]);
    expect(await usage.read("2026-10")).toEqual([]);
    await shared.close();
  });

  it("matches the file-backed Budget's contract", async () => {
    const shared = await connect();
    const db = new PostgresBudget(shared.db, { limitUsd: 1, warnAt: 0.8 });
    const file = new Budget({ limitUsd: 1, warnAt: 0.8 });
    for (const budget of [db, file]) {
      await budget.record(1.5);
      await expect(Promise.resolve().then(() => budget.assertAvailable())).rejects.toThrow(/budget exhausted/);
    }
    await shared.close();
  });
});
