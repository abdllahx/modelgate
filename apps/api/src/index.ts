import { join } from "node:path";
import { Alerts, createRuntime, loadConfig, specId } from "@modelgate/core";
import { connect, PostgresBudget, PostgresUsageLog } from "@modelgate/db";
import { createApi } from "./app.js";

const log = (msg: string) => process.stderr.write(`[modelgate-api] ${msg}\n`);

const token = process.env.MODELGATE_API_TOKEN || undefined;
if (process.env.NODE_ENV === "production" && !token) {
  log("MODELGATE_API_TOKEN is required in production. Refusing to start without auth.");
  process.exit(1);
}

const config = loadConfig();
// Render Postgres in production; embedded PGlite on disk for local development.
const connection = await connect({
  url: process.env.DATABASE_URL || undefined,
  dataDir: process.env.DATABASE_URL ? undefined : join(config.home, "pglite"),
});
const alerts = new Alerts({ webhook: config.alertWebhook });
const budget = new PostgresBudget(connection.db, { limitUsd: config.budgetUsd, warnAt: config.budgetWarnAt, alerts });
const usage = new PostgresUsageLog(connection.db, "api");
const { router, breaker, prompt } = createRuntime(config, { budget, usage, alerts });

const app = createApi({ router, budget, usage, breaker, prompt, maxImageBytes: config.maxImageBytes, token });
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, () => {
  log(`listening on :${port}; routing ${config.vendors.map(specId).join(" -> ") || "(no vendors configured)"}; ${connection.driver} ledger; auth ${token ? "on" : "off"}`);
});

const shutdown = () => server.close(() => void connection.close().finally(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
