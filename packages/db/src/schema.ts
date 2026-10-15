import type { AttemptRecord, UsageRecord } from "@modelgate/core";
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** One row per extraction request, from the MCP server or the API. */
export const usageRecords = pgTable(
  "usage_records",
  {
    requestId: uuid("request_id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    source: text("source").$type<"mcp" | "api">().notNull(),
    outcome: text("outcome").$type<UsageRecord["outcome"]>().notNull(),
    vendor: text("vendor").$type<NonNullable<UsageRecord["vendor"]>>(),
    model: text("model"),
    promptVersion: integer("prompt_version").notNull(),
    costUsd: doublePrecision("cost_usd").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    fellBack: boolean("fell_back").notNull(),
    silentFailures: integer("silent_failures").notNull(),
    attempts: jsonb("attempts").$type<AttemptRecord[]>().notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull(),
  },
  (t) => [index("usage_records_ts_idx").on(t.ts)],
);

/** One row per month. Every process increments the same row, so the limit is shared. */
export const budgetLedger = pgTable("budget_ledger", {
  period: text("period").primaryKey(),
  spentUsd: doublePrecision("spent_usd").notNull().default(0),
  limitUsd: doublePrecision("limit_usd").notNull(),
  warned: boolean("warned").notNull().default(false),
});
