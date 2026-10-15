import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.js";
import { retryAfterMs, VendorError, type ClientOptions, type ExtractInput, type ProviderOutput, type VisionProvider } from "./types.js";

// Server-side refusal fallback ("default" routes by refusal category). Claude
// Haiku has no server-side fallback, so the parameter is only sent where it applies.
const SERVER_FALLBACK = /^claude-(opus|sonnet|fable)/;

export class AnthropicProvider implements VisionProvider {
  readonly vendor = "anthropic" as const;
  private client: Anthropic | undefined;

  constructor(
    readonly model: string,
    private readonly effort: Effort,
    private readonly clientOptions: ClientOptions = {},
  ) {}

  // Built on first use, so a missing credential fails one request (and falls
  // back) instead of crashing the server at startup.
  private sdk(): Anthropic {
    // maxRetries 0: the router owns retries, backoff and fallback. SDK retries
    // would double-count attempts and hide latency from the measurements.
    this.client ??= new Anthropic({ maxRetries: 0, ...this.clientOptions });
    return this.client;
  }

  async extract(input: ExtractInput): Promise<ProviderOutput> {
    try {
      const response = await this.sdk().beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          system: input.instructions,
          output_config: {
            effort: this.effort,
            format: { type: "json_schema", schema: input.jsonSchema },
          },
          ...(SERVER_FALLBACK.test(this.model)
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: input.mimeType, data: input.image.toString("base64") },
                },
                { type: "text", text: "Extract this receipt." },
              ],
            },
          ],
        },
        { signal: input.signal },
      );

      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const refused = response.stop_reason === "refusal";
      return {
        text,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        model: response.model,
        refused,
        truncated: response.stop_reason === "max_tokens",
        ...(refused ? { detail: `refusal (${response.stop_details?.category ?? "uncategorised"})` } : {}),
      };
    } catch (err) {
      throw toVendorError(err);
    }
  }
}

/** Maps SDK errors to VendorError kinds; the router decides retry or fallback from the kind. */
export function toVendorError(err: unknown): VendorError {
  const v = "anthropic" as const;
  const options = (e: InstanceType<typeof Anthropic.APIError>) => ({
    status: e.status,
    retryAfterMs: retryAfterMs(e.headers),
    cause: err,
  });

  if (err instanceof Anthropic.APIUserAbortError) return new VendorError(v, "timeout", "request aborted", { cause: err });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new VendorError(v, "timeout", err.message, { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new VendorError(v, "network", err.message, { cause: err });
  if (err instanceof Anthropic.RateLimitError) return new VendorError(v, "rate_limit", err.message, options(err));
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new VendorError(v, "auth", err.message, options(err));
  }
  if (err instanceof Anthropic.BadRequestError) {
    // Exhausted prepaid credit arrives as a 400 invalid_request_error; the
    // message text is the only field that distinguishes it from a malformed request.
    const body = `${err.message} ${JSON.stringify(err.error ?? {})}`;
    const kind = /credit balance/i.test(body) ? "quota" : "bad_request";
    return new VendorError(v, kind, err.message, options(err));
  }
  if (err instanceof Anthropic.APIError) {
    const kind = (err.status ?? 0) >= 500 ? "server" : "bad_request";
    return new VendorError(v, kind, err.message, options(err));
  }
  return new VendorError(v, "unknown", String(err), { cause: err });
}
