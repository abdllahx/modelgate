#!/usr/bin/env node
// PostToolUse hook: appends one line per ModelGate tool call so get_report and
// `npm run report` can show adoption (sessions, calls, failures) with no manual tracking.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const home = process.env.MODELGATE_HOME || join(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), ".modelgate");
  const response = input.tool_response;
  const failed = Boolean(response && typeof response === "object" && (response.isError || response.is_error));
  mkdirSync(home, { recursive: true });
  appendFileSync(
    join(home, "adoption.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), sessionId: input.session_id ?? "unknown", tool: input.tool_name ?? "unknown", ok: !failed })}\n`,
  );
} catch {
  // Telemetry must never interfere with the agent.
}
process.exit(0);
