/**
 * Contract tests: each provider runs through its real SDK against a local HTTP
 * server that records the request and replays a response in the vendor's wire
 * format. This checks serialisation, headers, response parsing, usage mapping
 * and error classification end to end without API keys or spend.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { VendorError, type ExtractInput } from "../src/providers/types.js";
import { receiptJsonSchema } from "../src/schema.js";
import { makeRouter, PNG_1PX, RECEIPT } from "./helpers.js";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: any;
}
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

let server: Server;
let base = "";
let replies: Reply[] = [];
let requests: Recorded[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const reply = replies.shift() ?? { status: 500, body: { error: "no reply queued" } };
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body ?? {}));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  replies = [];
  requests = [];
});

const input = (vendor: "anthropic" | "openai" | "gemini"): ExtractInput => ({
  image: PNG_1PX,
  mimeType: "image/png",
  instructions: "Extract the receipt.",
  jsonSchema: receiptJsonSchema(vendor),
  signal: new AbortController().signal,
});

const anthropicMessage = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: JSON.stringify(RECEIPT) }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1800, output_tokens: 420 },
  ...overrides,
});

describe("Anthropic contract", () => {
  const provider = () => new AnthropicProvider("claude-opus-5-5", "medium", { baseURL: base, apiKey: "test-key" });

  it("sends a structured-output vision request with server-side fallback", async () => {
    replies.push({ status: 200, body: anthropicMessage() });

    const out = await provider().extract(input("anthropic"));

    const [req] = requests;
    expect(req!.method).toBe("POST");
    expect(req!.url).toMatch(/^\/v1\/messages/);
    expect(req!.headers["x-api-key"]).toBe("test-key");
    expect(req!.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(req!.body).toMatchObject({
      model: "claude-opus-5-5",
      system: "Extract the receipt.",
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(req!.body.output_config.format.schema.required).toContain("total");
    expect(req!.body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_1PX.toString("base64") },
    });
    expect(out).toEqual({
      text: JSON.stringify(RECEIPT),
      usage: { inputTokens: 1800, outputTokens: 420 },
      model: "claude-opus-5-5",
      refused: false,
      truncated: false,
    });
  });

  it("does not send fallbacks to Haiku, which has no server-side fallback", async () => {
    replies.push({ status: 200, body: anthropicMessage({ model: "claude-haiku-5-5" }) });
    await new AnthropicProvider("claude-haiku-5-5", "low", { baseURL: base, apiKey: "k" }).extract(input("anthropic"));
    expect(requests[0]!.body).not.toHaveProperty("fallbacks");
    expect(requests[0]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("reports refusals and the model that served the request", async () => {
    replies.push({
      status: 200,
      body: anthropicMessage({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }),
    });
    const out = await provider().extract(input("anthropic"));
    expect(out).toMatchObject({ refused: true, detail: "refusal (cyber)" });
  });

  it("classifies a 429 with Retry-After and an exhausted credit balance", async () => {
    replies.push({ status: 429, headers: { "retry-after": "3" }, body: { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } } });
    replies.push({
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
    });

    const limited = await provider().extract(input("anthropic")).catch((e: unknown) => e);
    const broke = await provider().extract(input("anthropic")).catch((e: unknown) => e);

    expect(limited).toMatchObject({ kind: "rate_limit", status: 429, retryAfterMs: 3000 });
    expect(broke).toMatchObject({ kind: "quota", status: 400 });
    expect(requests).toHaveLength(2); // SDK retries are off: one request per call
  });
});

describe("OpenAI contract", () => {
  const provider = () => new OpenAIProvider("gpt-5-mini", { baseURL: `${base}/v1`, apiKey: "sk-test" });
  const response = (overrides: Record<string, unknown> = {}) => ({
    id: "resp_test",
    object: "response",
    created_at: 1760000000,
    model: "gpt-5-mini-2025-08-07",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(RECEIPT), annotations: [] }],
      },
    ],
    usage: { input_tokens: 1500, output_tokens: 900, total_tokens: 2400, output_tokens_details: { reasoning_tokens: 640 } },
    ...overrides,
  });

  it("sends a strict json_schema Responses request with the image as a data URL", async () => {
    replies.push({ status: 200, body: response() });

    const out = await provider().extract(input("openai"));

    const [req] = requests;
    expect(req!.url).toBe("/v1/responses");
    expect(req!.headers.authorization).toBe("Bearer sk-test");
    expect(req!.body).toMatchObject({
      model: "gpt-5-mini",
      instructions: "Extract the receipt.",
      text: { format: { type: "json_schema", name: "receipt", strict: true } },
    });
    expect(req!.body.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: `data:image/png;base64,${PNG_1PX.toString("base64")}`,
      detail: "high",
    });
    expect(out).toMatchObject({
      text: JSON.stringify(RECEIPT),
      usage: { inputTokens: 1500, outputTokens: 900 },
      model: "gpt-5-mini-2025-08-07",
      refused: false,
      truncated: false,
    });
  });

  it("detects refusals and truncation", async () => {
    replies.push({
      status: 200,
      body: response({
        output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
      }),
    });
    replies.push({ status: 200, body: response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }) });

    expect(await provider().extract(input("openai"))).toMatchObject({ refused: true, detail: "refusal: I can't help with that." });
    expect(await provider().extract(input("openai"))).toMatchObject({ truncated: true, text: "" });
  });

  it("separates an empty balance from throttling", async () => {
    replies.push({ status: 429, body: { error: { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" } } });
    replies.push({ status: 429, body: { error: { code: "rate_limit_exceeded", type: "requests", message: "Rate limit reached" } } });

    expect(await provider().extract(input("openai")).catch((e: unknown) => e)).toMatchObject({ kind: "quota" });
    expect(await provider().extract(input("openai")).catch((e: unknown) => e)).toMatchObject({ kind: "rate_limit" });
  });

  it("reports a missing key as an auth failure instead of crashing", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const error = await new OpenAIProvider("gpt-5-mini", { baseURL: `${base}/v1` }).extract(input("openai")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VendorError);
      expect(error).toMatchObject({ kind: "auth" });
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("Gemini contract", () => {
  const provider = () => new GeminiProvider("gemini-2.5-flash", { baseURL: base, apiKey: "g-test" });
  const response = (overrides: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(RECEIPT) }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 1300, candidatesTokenCount: 310, thoughtsTokenCount: 200, totalTokenCount: 1810 },
    modelVersion: "gemini-2.5-flash",
    ...overrides,
  });

  it("sends inline image data with a JSON response schema", async () => {
    replies.push({ status: 200, body: response() });

    const out = await provider().extract(input("gemini"));

    const [req] = requests;
    expect(req!.url).toMatch(/\/models\/gemini-2\.5-flash:generateContent/);
    expect(req!.headers["x-goog-api-key"]).toBe("g-test");
    expect(req!.body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: PNG_1PX.toString("base64") } });
    expect(req!.body.generationConfig).toMatchObject({ responseMimeType: "application/json", maxOutputTokens: 16000 });
    expect(req!.body.generationConfig.responseJsonSchema).toBeDefined();
    expect(JSON.stringify(req!.body.generationConfig.responseJsonSchema)).not.toContain("additionalProperties");
    expect(JSON.stringify(req!.body.systemInstruction)).toContain("Extract the receipt.");
    // Thinking tokens are billed as output.
    expect(out).toMatchObject({ text: JSON.stringify(RECEIPT), usage: { inputTokens: 1300, outputTokens: 510 }, refused: false });
  });

  it("treats safety blocks as refusals and MAX_TOKENS as truncation", async () => {
    replies.push({ status: 200, body: response({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }) });
    replies.push({ status: 200, body: response({ candidates: [{ content: { role: "model", parts: [{ text: '{"merch' }] }, finishReason: "MAX_TOKENS" }] }) });

    expect(await provider().extract(input("gemini"))).toMatchObject({ refused: true, detail: "blocked: SAFETY" });
    expect(await provider().extract(input("gemini"))).toMatchObject({ truncated: true });
  });

  it("classifies HTTP errors without SDK retries", async () => {
    replies.push({ status: 503, body: { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } } });
    const error = await provider().extract(input("gemini")).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "server", status: 503 });
    expect(requests).toHaveLength(1);
  });
});

describe("Router over real SDKs", () => {
  it("retries an overloaded Anthropic API, then falls back to OpenAI on a schema miss", async () => {
    replies.push({ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
    replies.push({ status: 200, body: anthropicMessage({ content: [{ type: "text", text: '{"merchant":"Harbor"}' }] }) });
    replies.push({
      status: 200,
      body: {
        id: "resp",
        object: "response",
        created_at: 1,
        model: "gpt-5-mini",
        status: "completed",
        output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(RECEIPT), annotations: [] }] }],
        usage: { input_tokens: 1000, output_tokens: 300, total_tokens: 1300 },
      },
    });
    const { router, sleeps } = makeRouter([
      new AnthropicProvider("claude-opus-5-5", "medium", { baseURL: base, apiKey: "k" }),
      new OpenAIProvider("gpt-5-mini", { baseURL: `${base}/v1`, apiKey: "k" }),
    ]);

    const result = await router.extract(PNG_1PX, "image/png");

    expect(requests.map((r) => r.url.split("?")[0])).toEqual(["/v1/messages", "/v1/messages", "/v1/responses"]);
    expect(sleeps).toHaveLength(1);
    expect(result).toMatchObject({ vendor: "openai", fellBack: true, receipt: RECEIPT });
    expect(result.attempts.map((a) => a.outcome)).toEqual(["error", "invalid", "ok"]);
    // claude-opus-5-5 schema miss (1,800 in / 420 out) + gpt-5-mini success (1,000 in / 300 out)
    expect(result.costUsd).toBeCloseTo((1800 * 4 + 420 * 20) / 1e6 + (1000 * 0.25 + 300 * 2) / 1e6, 10);
  });

  it("aborts a hung request at the router timeout", async () => {
    replies.push({ status: 200, delayMs: 2_000, body: anthropicMessage() });
    const { router } = makeRouter([new AnthropicProvider("claude-opus-5-5", "medium", { baseURL: base, apiKey: "k" })], {
      options: { timeoutMs: 100, maxAttempts: 1 },
    });

    const started = Date.now();
    const error = await router.extract(PNG_1PX, "image/png").catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(String(error)).toMatch(/timeout: no response within 100 ms/);
  });
});
