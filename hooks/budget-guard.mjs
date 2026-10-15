#!/usr/bin/env node
// PreToolUse hook: blocks extract_receipt before the call when this month's
// ledger shows the budget is spent. The server enforces the same limit; the
// hook stops the agent earlier and tells it plainly not to retry.
// Exit 2 blocks the tool call and shows stderr to Claude. It never blocks on its own errors.
import { readFileSync } from "node:fs";
import { join } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const home = process.env.MODELGATE_HOME || join(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), ".modelgate");
  const ledger = JSON.parse(readFileSync(join(home, "ledger.json"), "utf8"));
  const period = new Date().toISOString().slice(0, 7);
  if (ledger.period === period && ledger.limitUsd > 0 && ledger.spentUsd >= ledger.limitUsd) {
    process.stderr.write(
      `ModelGate budget exhausted: $${ledger.spentUsd.toFixed(2)} of $${ledger.limitUsd.toFixed(2)} spent in ${period}. ` +
        "Do not retry. Tell the user, who can raise MODELGATE_BUDGET_USD.\n",
    );
    process.exit(2);
  }
} catch {
  // No ledger yet, or unreadable: nothing has been spent that we know of.
}
process.exit(0);
