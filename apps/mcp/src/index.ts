#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, specId } from "@modelgate/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol. Everything human-readable goes to stderr.
const log = (msg: string) => process.stderr.write(`[modelgate] ${msg}\n`);

// .mcp.json forwards unset keys as empty strings, and a copied .env.example has
// blank ones. An empty ANTHROPIC_API_KEY would shadow other credential sources
// (such as an `ant auth login` profile), so blanks are dropped before and after
// loading .env: before, so .env can fill them; after, so its own blanks go too.
const dropBlankKeys = () => {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MODELGATE_VENDORS", "DATABASE_URL"]) {
    if (process.env[key] === "") delete process.env[key];
  }
};
dropBlankKeys();

// Only ModelGate's own .env (repo root), never the host project's: a plugin should not
// pick up keys another project keeps for itself. Real environment variables take precedence.
const ownEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(ownEnv)) process.loadEnvFile(ownEnv);
dropBlankKeys();

const config = loadConfig();
const app = await createApp(config, { databaseUrl: process.env.DATABASE_URL });
const server = createServer(app);

await server.connect(new StdioServerTransport());
log(
  config.vendors.length
    ? `ready: routing ${config.vendors.map(specId).join(" -> ")}, budget $${config.budgetUsd}/month (${app.storage} ledger), prompt v${app.prompt.version}`
    : "ready, but no vendors are configured; extract_receipt will return an error until a key is set",
);

const shutdown = () => void app.close().finally(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
