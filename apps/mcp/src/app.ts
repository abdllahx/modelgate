import { join } from "node:path";
import {
  Alerts,
  Budget,
  createRuntime,
  UsageLog,
  type BudgetGuard,
  type CircuitBreaker,
  type Config,
  type Prompt,
  type Router,
  type UsageSink,
  type VisionProvider,
} from "@modelgate/core";
import { connect, PostgresBudget, PostgresUsageLog } from "@modelgate/db";

export interface App {
  config: Config;
  prompt: Prompt;
  router: Router;
  budget: BudgetGuard;
  breaker: CircuitBreaker;
  alerts: Alerts;
  usage: UsageSink;
  adoptionFile: string;
  storage: "file" | "postgres";
  close: () => Promise<void>;
}

export interface AppOverrides {
  providers?: VisionProvider[];
  alerts?: Alerts;
  sleep?: (ms: number) => Promise<void>;
  /** Postgres connection string. When set, spend and usage are shared with the API and other servers. */
  databaseUrl?: string | undefined;
}

export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const alerts = overrides.alerts ?? new Alerts({ webhook: config.alertWebhook });
  const adoptionFile = join(config.home, "adoption.jsonl");

  let budget: BudgetGuard;
  let usage: UsageSink;
  let close = async () => {};
  let storage: App["storage"] = "file";
  if (overrides.databaseUrl) {
    const connection = await connect({ url: overrides.databaseUrl });
    budget = new PostgresBudget(connection.db, { limitUsd: config.budgetUsd, warnAt: config.budgetWarnAt, alerts });
    usage = new PostgresUsageLog(connection.db, "mcp");
    close = connection.close;
    storage = "postgres";
  } else {
    budget = new Budget({ limitUsd: config.budgetUsd, warnAt: config.budgetWarnAt, file: join(config.home, "ledger.json"), alerts });
    usage = new UsageLog(join(config.home, "usage.jsonl"));
  }

  const runtime = createRuntime(config, { budget, usage, alerts }, overrides);
  return { config, ...runtime, budget, alerts, usage, adoptionFile, storage, close };
}
