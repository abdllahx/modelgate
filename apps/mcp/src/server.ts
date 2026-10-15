import {
  AllVendorsFailedError,
  BudgetExceededError,
  ImageInputError,
  loadImage,
  NoVendorsError,
  readAdoption,
  Receipt,
  renderReport,
  summarize,
  type VendorId,
} from "@modelgate/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "./app.js";

const VENDOR = z.enum(["anthropic", "openai", "gemini", "mock"]);

const Attempt = z.object({
  vendor: VENDOR,
  model: z.string(),
  attempt: z.number(),
  outcome: z.enum(["ok", "error", "invalid", "skipped"]),
  reason: z.string().optional(),
  latencyMs: z.number(),
  costUsd: z.number(),
});

const ExtractOutput = {
  receipt: Receipt,
  vendor: VENDOR,
  model: z.string(),
  cost_usd: z.number(),
  latency_ms: z.number(),
  prompt_version: z.number(),
  fell_back: z.boolean().describe("True when the first vendor in the routing order did not serve the request"),
  warnings: z.array(z.string()),
  attempts: z.array(Attempt),
};

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const json = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

export function createServer(app: App): McpServer {
  const server = new McpServer({ name: "modelgate", version: "0.1.0" });

  server.registerTool(
    "extract_receipt",
    {
      title: "Extract receipt",
      description:
        "Extract merchant, date, currency, line items, subtotal, tax and total from a receipt image as validated JSON. " +
        "Routes across vision LLM vendors with retries and fallback, rejects outputs that fail validation, and charges the call to a monthly budget. " +
        "Pass a local file path (preferred) or base64 data. Each call costs money: do not call it repeatedly on the same image.",
      inputSchema: {
        image_path: z.string().optional().describe("Path to a PNG, JPEG, GIF or WebP file, absolute or relative to the project"),
        image_base64: z.string().optional().describe("Base64 image data, with or without a data: URL prefix"),
        vendors: z
          .array(VENDOR)
          .optional()
          .describe("Override the routing order for this call, for example [\"openai\", \"anthropic\"]. Unconfigured vendors are ignored."),
      },
      outputSchema: ExtractOutput,
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ image_path, image_base64, vendors }) => {
      try {
        const image = await loadImage({ path: image_path, base64: image_base64 }, app.config.maxImageBytes);
        const result = await app.router.extract(image.bytes, image.mimeType, vendors ? { vendors: vendors as VendorId[] } : {});
        const structured = {
          receipt: result.receipt,
          vendor: result.vendor,
          model: result.model,
          cost_usd: result.costUsd,
          latency_ms: result.latencyMs,
          prompt_version: result.promptVersion,
          fell_back: result.fellBack,
          warnings: result.warnings,
          attempts: result.attempts,
        };
        return { content: json(structured), structuredContent: structured };
      } catch (err) {
        if (err instanceof BudgetExceededError) return errorResult(`${err.message} Do not retry until the budget is raised.`);
        if (err instanceof AllVendorsFailedError) return errorResult(err.message);
        if (err instanceof ImageInputError || err instanceof NoVendorsError) return errorResult(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "ModelGate status",
      description: "Routing order, per-vendor circuit breaker state, current prompt version, and this month's budget.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const status = {
        routing: app.router.vendors,
        breakers: app.breaker.snapshot(app.router.vendors.map((v) => `${v.vendor}:${v.model}`)),
        prompt: { id: app.prompt.id, version: app.prompt.version },
        budget: await app.budget.snapshot(),
        storage: app.storage,
      };
      return { content: json(status) };
    },
  );

  server.registerTool(
    "get_report",
    {
      title: "ModelGate usage report",
      description: "Requests, success and fallback rates, silent failures caught, cost by vendor, latency and agent adoption for a month.",
      inputSchema: {
        period: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe("Month as YYYY-MM; defaults to the current month"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) => {
      const month = period ?? (await app.budget.snapshot()).period;
      const report = summarize(await app.usage.read(month), readAdoption(app.adoptionFile), month);
      return { content: [{ type: "text", text: renderReport(report) }] };
    },
  );

  return server;
}
