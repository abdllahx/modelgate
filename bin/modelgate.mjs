#!/usr/bin/env node
// Launcher used by .mcp.json. A fresh clone or a plugin installed from the
// marketplace has no node_modules or build output, so the first start installs
// only the MCP server's workspace (not the web app) and builds it once.
// stdout is the MCP channel: child output is routed to stderr.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "apps", "mcp", "dist", "index.js");
const run = (command) => execSync(command, { cwd: root, stdio: ["ignore", 2, 2] });

if (!existsSync(join(root, "node_modules", "@modelgate", "core"))) {
  process.stderr.write("[modelgate] first run: installing the MCP server's dependencies\n");
  run("npm ci --workspace @modelgate/mcp --include-workspace-root --include=dev --no-audit --no-fund");
}
if (!existsSync(entry)) {
  process.stderr.write("[modelgate] first run: building\n");
  run("npx turbo run build --filter=@modelgate/mcp... --output-logs=errors-only");
}

await import(pathToFileURL(entry).href);
