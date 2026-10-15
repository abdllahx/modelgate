import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VendorId } from "./providers/types.js";

export interface AttemptRecord {
  vendor: VendorId;
  model: string;
  attempt: number;
  outcome: "ok" | "error" | "invalid" | "skipped";
  reason?: string;
  latencyMs: number;
  costUsd: number;
}

export interface UsageRecord {
  ts: string;
  requestId: string;
  outcome: "ok" | "failed" | "budget_exceeded";
  vendor?: VendorId;
  model?: string;
  promptVersion: number;
  costUsd: number;
  latencyMs: number;
  /** True when a vendor other than the first in the routing order served the request. */
  fellBack: boolean;
  /** Outputs rejected by validation: HTTP 200 responses that were wrong. */
  silentFailures: number;
  attempts: AttemptRecord[];
  warnings: string[];
}

export interface AdoptionRecord {
  ts: string;
  sessionId: string;
  tool: string;
  ok: boolean;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

/** Where the router writes one record per request. JSONL locally; Postgres via @modelgate/db. */
export interface UsageSink {
  append(record: UsageRecord): void | Promise<void>;
  /** Records for one month (YYYY-MM), or all of them. */
  read(period?: string): UsageRecord[] | Promise<UsageRecord[]>;
}

/** Append-only JSONL log: one line per extraction request. Feeds get_report and scripts/report.ts. */
export class UsageLog implements UsageSink {
  constructor(readonly file: string) {}

  append(record: UsageRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  read(period?: string): UsageRecord[] {
    const rows = readJsonl<UsageRecord>(this.file);
    return period ? rows.filter((r) => r.ts.startsWith(period)) : rows;
  }
}

/** Written by the PostToolUse hook in hooks/log-adoption.mjs. */
export function readAdoption(file: string): AdoptionRecord[] {
  return readJsonl<AdoptionRecord>(file);
}
