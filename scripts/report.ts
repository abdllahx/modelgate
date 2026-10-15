/**
 * Prints the usage report (adoption, cost, outcomes) from the logs the server,
 * API and hooks write, so nobody has to assemble the numbers by hand. Reads
 * Postgres when DATABASE_URL is set, otherwise the local .modelgate files.
 *
 *   npm run report                 # current month
 *   npm run report -- --period 2026-09 --out REPORT.md
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, readAdoption, renderReport, summarize, UsageLog, type UsageRecord } from "@modelgate/core";
import { connect, PostgresUsageLog } from "@modelgate/db";

const { values } = parseArgs({
  options: {
    period: { type: "string", default: new Date().toISOString().slice(0, 7) },
    out: { type: "string" },
  },
});

const { home } = loadConfig();
let usage: UsageRecord[];
if (process.env.DATABASE_URL) {
  const connection = await connect({ url: process.env.DATABASE_URL });
  usage = await new PostgresUsageLog(connection.db, "api").read(values.period);
  await connection.close();
} else {
  usage = new UsageLog(join(home, "usage.jsonl")).read(values.period);
}

const markdown = renderReport(summarize(usage, readAdoption(join(home, "adoption.jsonl")), values.period));
if (values.out) writeFileSync(values.out, markdown);
process.stdout.write(markdown);
