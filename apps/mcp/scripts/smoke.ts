/**
 * End-to-end check of the shipped artefact: starts the server the way Claude
 * Code does (node bin/modelgate.mjs over stdio), lists tools, extracts a dataset
 * receipt with the offline mock vendor, and reads status. Free; no keys needed.
 *
 *   npm run smoke
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATASET = join(ROOT, "packages/eval/dataset");
const labels = JSON.parse(readFileSync(join(DATASET, "labels.json"), "utf8")) as Array<{ file: string; receipt: { total: number } }>;
const sample = labels[0]!;

// SMOKE_ROOT points at another checkout, e.g. a fresh clone, to test first-run install and build.
const LAUNCH_ROOT = process.env.SMOKE_ROOT || ROOT;
const transport = new StdioClientTransport({
  command: "node",
  args: [join(LAUNCH_ROOT, "bin/modelgate.mjs")],
  cwd: LAUNCH_ROOT,
  env: { PATH: process.env.PATH ?? "", MODELGATE_VENDORS: "mock", MODELGATE_HOME: mkdtempSync(join(tmpdir(), "modelgate-smoke-")) },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

const result = await client.callTool({ name: "extract_receipt", arguments: { image_path: join(DATASET, sample.file) } });
const structured = result.structuredContent as { receipt: { merchant: string; total: number }; vendor: string; cost_usd: number } | undefined;
if (result.isError || !structured || structured.receipt.total !== sample.receipt.total) {
  console.error("extract_receipt failed:", JSON.stringify(result.content));
  process.exit(1);
}
console.log(`extract_receipt: ${structured.receipt.merchant}, total ${structured.receipt.total} via ${structured.vendor}`);

const status = await client.callTool({ name: "get_status", arguments: {} });
console.log(`get_status: ${status.isError ? "error" : "ok"}`);
await client.close();
console.log("smoke test passed");
