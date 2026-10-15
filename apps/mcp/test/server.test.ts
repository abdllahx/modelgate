import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Alerts, loadConfig } from "@modelgate/core";
import { createApp } from "../src/app.js";
import { createServer } from "../src/server.js";
import { output, PNG_1PX, RECEIPT, scripted } from "../../../packages/core/test/helpers.js";

async function connect(providers = [scripted("anthropic", [output()])], env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "modelgate-srv-"));
  const config = loadConfig({ MODELGATE_HOME: home, ...env });
  const app = await createApp(config, { providers, alerts: new Alerts({ log: () => {} }), sleep: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(app);
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server, app, home };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

describe("MCP server", () => {
  it("exposes three typed tools with annotations", async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(["extract_receipt", "get_report", "get_status"]);
    const extract = tools.find((t) => t.name === "extract_receipt")!;
    expect(extract.outputSchema).toBeDefined();
    expect(extract.annotations?.readOnlyHint).toBe(false);
  });

  it("extracts a receipt end to end and returns structured content", async () => {
    const { client, server, home } = await connect();
    cleanup.push(() => client.close(), () => server.close());
    const path = join(home, "receipt.png");
    writeFileSync(path, PNG_1PX);

    const result = await client.callTool({ name: "extract_receipt", arguments: { image_path: path } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ receipt: RECEIPT, vendor: "anthropic", prompt_version: 1, fell_back: false });
  });

  it("returns tool errors the agent can read instead of crashing", async () => {
    const { client, server, home } = await connect();
    cleanup.push(() => client.close(), () => server.close());
    const path = join(home, "notes.txt");
    writeFileSync(path, "not an image");

    const result = await client.callTool({ name: "extract_receipt", arguments: { image_path: path } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Unsupported content/);
  });

  it("tells the agent not to retry once the budget is exhausted", async () => {
    const expensive = scripted("anthropic", [output({ usage: { inputTokens: 20_000_000, outputTokens: 0 } })]);
    const { client, server } = await connect([expensive], { MODELGATE_BUDGET_USD: "1" });
    cleanup.push(() => client.close(), () => server.close());
    const args = { image_base64: PNG_1PX.toString("base64") };

    await client.callTool({ name: "extract_receipt", arguments: args });
    const blocked = await client.callTool({ name: "extract_receipt", arguments: args });

    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toMatch(/Do not retry/);
  });

  it("reports status and monthly usage", async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());
    await client.callTool({ name: "extract_receipt", arguments: { image_base64: PNG_1PX.toString("base64") } });

    const status = await client.callTool({ name: "get_status", arguments: {} });
    const report = await client.callTool({ name: "get_report", arguments: {} });

    expect(JSON.stringify(status.content)).toContain('\\"version\\": 1');
    expect(JSON.stringify(report.content)).toMatch(/Success rate \| 100.0%/);
  });
});
