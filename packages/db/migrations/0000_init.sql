CREATE TABLE "budget_ledger" (
	"period" text PRIMARY KEY NOT NULL,
	"spent_usd" double precision DEFAULT 0 NOT NULL,
	"limit_usd" double precision NOT NULL,
	"warned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"vendor" text,
	"model" text,
	"prompt_version" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"fell_back" boolean NOT NULL,
	"silent_failures" integer NOT NULL,
	"attempts" jsonb NOT NULL,
	"warnings" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_records_ts_idx" ON "usage_records" USING btree ("ts");