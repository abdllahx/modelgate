import { timingSafeEqual } from "node:crypto";
import {
  AllVendorsFailedError,
  BudgetExceededError,
  ImageInputError,
  loadImage,
  NoVendorsError,
  summarize,
  type BudgetGuard,
  type CircuitBreaker,
  type Prompt,
  type Router,
  type UsageSink,
} from "@modelgate/core";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { z } from "zod";

export interface ApiDeps {
  router: Router;
  budget: BudgetGuard;
  usage: UsageSink;
  breaker: CircuitBreaker;
  prompt: Prompt;
  maxImageBytes: number;
  /** Bearer token for /v1. Undefined disables auth; index.ts refuses that in production. */
  token: string | undefined;
}

const ExtractBody = z.object({
  image_base64: z.string().min(1),
  vendors: z.array(z.enum(["anthropic", "openai", "gemini", "mock"])).optional(),
});

function bearerAuth(token: string | undefined): RequestHandler {
  const expected = token ? Buffer.from(`Bearer ${token}`) : undefined;
  return (req, res, next) => {
    if (!expected) return next();
    const given = Buffer.from(req.get("authorization") ?? "");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.status(401).json({ error: "unauthorized", message: "Send Authorization: Bearer <MODELGATE_API_TOKEN>." });
  };
}

/**
 * HTTP surface for callers that are not agents (backends, the web app). Same
 * router, validation and budget as the MCP server; errors map to status codes
 * a client can act on: 402 budget spent, 422 bad image, 502 every vendor failed.
 */
export function createApi(deps: ApiDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, promptVersion: deps.prompt.version });
  });

  app.use("/v1", bearerAuth(deps.token));
  // Base64 is about 4/3 the size of the image it encodes.
  app.use("/v1", express.json({ limit: Math.ceil(deps.maxImageBytes * 1.4) + 4096 }));

  app.post("/v1/extract", async (req, res) => {
    const body = ExtractBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_request", message: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    try {
      const image = await loadImage({ base64: body.data.image_base64 }, deps.maxImageBytes);
      const result = await deps.router.extract(image.bytes, image.mimeType, body.data.vendors ? { vendors: body.data.vendors } : {});
      res.json({
        request_id: result.requestId,
        receipt: result.receipt,
        vendor: result.vendor,
        model: result.model,
        cost_usd: result.costUsd,
        latency_ms: result.latencyMs,
        prompt_version: result.promptVersion,
        fell_back: result.fellBack,
        warnings: result.warnings,
        attempts: result.attempts,
      });
    } catch (err) {
      if (err instanceof ImageInputError) res.status(422).json({ error: "invalid_image", message: err.message });
      else if (err instanceof BudgetExceededError) res.status(402).json({ error: "budget_exhausted", message: err.message });
      else if (err instanceof AllVendorsFailedError) {
        res.status(502).json({ error: "all_vendors_failed", message: err.message, request_id: err.requestId, attempts: err.attempts });
      } else if (err instanceof NoVendorsError) res.status(503).json({ error: "no_vendors", message: err.message });
      else throw err;
    }
  });

  app.get("/v1/status", async (_req, res) => {
    const routing = deps.router.vendors;
    res.json({
      routing,
      breakers: deps.breaker.snapshot(routing.map((v) => `${v.vendor}:${v.model}`)),
      prompt: { id: deps.prompt.id, version: deps.prompt.version },
      budget: await deps.budget.snapshot(),
    });
  });

  app.get("/v1/report", async (req, res) => {
    const requested = typeof req.query.period === "string" ? req.query.period : undefined;
    if (requested && !/^\d{4}-\d{2}$/.test(requested)) {
      res.status(400).json({ error: "invalid_request", message: "period must be YYYY-MM" });
      return;
    }
    const period = requested ?? (await deps.budget.snapshot()).period;
    res.json(summarize(await deps.usage.read(period), [], period));
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status === 413) res.status(413).json({ error: "too_large", message: `Image exceeds ${deps.maxImageBytes} bytes.` });
    else if (status === 400) res.status(400).json({ error: "invalid_request", message: "Body must be valid JSON." });
    else {
      process.stderr.write(`${JSON.stringify({ level: "error", msg: String(err?.stack ?? err) })}\n`);
      res.status(500).json({ error: "internal", message: "Unexpected error." });
    }
  };
  app.use(onError);
  return app;
}
