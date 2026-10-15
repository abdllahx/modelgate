import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@google/genai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { toVendorError as anthropicError } from "../src/providers/anthropic.js";
import { toVendorError as geminiError } from "../src/providers/gemini.js";
import { toVendorError as openaiError } from "../src/providers/openai.js";
import { RETRYABLE } from "../src/providers/types.js";

const headers = (init: Record<string, string> = {}) => new Headers(init);

describe("Anthropic error mapping", () => {
  it.each([
    ["rate_limit", new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", headers())],
    ["server", new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", headers())],
    ["auth", new Anthropic.AuthenticationError(401, { type: "error" }, "invalid x-api-key", headers())],
    [
      "quota",
      new Anthropic.BadRequestError(
        400,
        { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
        undefined,
        headers(),
      ),
    ],
    ["bad_request", new Anthropic.BadRequestError(400, { type: "error" }, "messages: field required", headers())],
    ["timeout", new Anthropic.APIConnectionTimeoutError()],
    ["timeout", new Anthropic.APIUserAbortError()],
    ["network", new Anthropic.APIConnectionError({ message: "ECONNRESET" })],
    ["unknown", new Error("bug")],
  ])("maps to %s", (kind, err) => {
    expect(anthropicError(err).kind).toBe(kind);
  });

  it("carries Retry-After into the backoff", () => {
    const err = anthropicError(new Anthropic.RateLimitError(429, { type: "error" }, "slow down", headers({ "retry-after": "7" })));
    expect(err.retryAfterMs).toBe(7_000);
  });
});

describe("OpenAI error mapping", () => {
  it("splits 429 into throttling (retried) and an empty balance (not retried)", () => {
    const throttled = openaiError(new OpenAI.RateLimitError(429, { code: "rate_limit_exceeded" }, "slow down", headers()));
    const broke = openaiError(new OpenAI.RateLimitError(429, { code: "insufficient_quota" }, "You exceeded your current quota", headers()));
    expect(throttled.kind).toBe("rate_limit");
    expect(broke.kind).toBe("quota");
    expect(RETRYABLE.has(throttled.kind)).toBe(true);
    expect(RETRYABLE.has(broke.kind)).toBe(false);
  });

  it.each([
    ["server", new OpenAI.InternalServerError(503, {}, "unavailable", headers())],
    ["auth", new OpenAI.PermissionDeniedError(403, {}, "forbidden", headers())],
    ["bad_request", new OpenAI.BadRequestError(400, {}, "invalid schema", headers())],
    ["timeout", new OpenAI.APIUserAbortError()],
  ])("maps to %s", (kind, err) => {
    expect(openaiError(err).kind).toBe(kind);
  });
});

describe("Gemini error mapping", () => {
  it.each([
    ["rate_limit", new ApiError({ status: 429, message: "RESOURCE_EXHAUSTED" })],
    ["server", new ApiError({ status: 503, message: "UNAVAILABLE" })],
    ["auth", new ApiError({ status: 403, message: "PERMISSION_DENIED" })],
    ["bad_request", new ApiError({ status: 400, message: "INVALID_ARGUMENT" })],
    ["timeout", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["network", new TypeError("fetch failed")],
  ])("maps to %s", (kind, err) => {
    expect(geminiError(err).kind).toBe(kind);
  });
});
