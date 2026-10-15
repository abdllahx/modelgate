#!/usr/bin/env node
// PostToolUse hook: after an agent edits a TypeScript file, typechecks the
// workspace that owns it and feeds errors straight back to Claude (exit 2), so
// they are fixed in the same turn instead of surfacing later in CI.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const file = input.tool_input?.file_path;
  if (typeof file !== "string" || !/\.(ts|tsx|mts)$/.test(file)) process.exit(0);

  // Nearest directory with a tsconfig.json: the workspace package, or the repo root.
  const root = resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  let dir = dirname(resolve(root, file));
  while (dir.startsWith(root) && !existsSync(join(dir, "tsconfig.json"))) dir = dirname(dir);
  if (!dir.startsWith(root)) process.exit(0);

  execFileSync("npx", ["--no-install", "tsc", "--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")], { cwd: root, stdio: "pipe" });
} catch (err) {
  const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  if (output) {
    const lines = output.split("\n");
    process.stderr.write(`Typecheck failed after this edit:\n${lines.slice(0, 20).join("\n")}${lines.length > 20 ? `\n... ${lines.length - 20} more` : ""}\n`);
    process.exit(2);
  }
}
process.exit(0);
