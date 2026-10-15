#!/usr/bin/env node
// PreToolUse hook: stops an agent from hand-editing files that must only change
// through a script, or that hold secrets. Exit 2 blocks the edit and tells Claude why.
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const RULES = [
  { pattern: /(^|\/)\.env(\.(?!example$)[^/]+)?$/, reason: "holds secrets. Ask the user to edit it." },
  { pattern: /^packages\/eval\/baseline\.json$/, reason: "changes only through `npm run eval:baseline` after a reviewed eval run." },
  { pattern: /^packages\/eval\/dataset\//, reason: "is generated. Change packages/eval/src/generate-dataset.ts and run `npm run dataset`." },
  { pattern: /^packages\/eval\/results\//, reason: "is written by `npm run eval`." },
  { pattern: /^packages\/db\/migrations\//, reason: "is generated. Change packages/db/src/schema.ts and run `npm run db:generate`." },
];

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const file = input.tool_input?.file_path;
  if (typeof file === "string") {
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const path = relative(root, file).split("\\").join("/");
    const rule = RULES.find((r) => r.pattern.test(path));
    if (rule) {
      process.stderr.write(`Blocked: ${path} ${rule.reason}\n`);
      process.exit(2);
    }
  }
} catch {
  // Malformed hook input: allow rather than block the agent on our own bug.
}
process.exit(0);
