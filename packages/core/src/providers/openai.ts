import OpenAI from "openai";
import { retryAfterMs, VendorError, type ClientOptions, type ExtractInput, type ProviderOutput, type VisionProvider } from "./types.js";

export class OpenAIProvider implements VisionProvider {
  readonly vendor = "openai" as const;
  private client: OpenAI | undefined;

  constructor(
    readonly model: string,
    private readonly clientOptions: ClientOptions = {},
  ) {}

  private sdk(): OpenAI {
    try {
      // The router owns retries; see AnthropicProvider.
      this.client ??= new OpenAI({ maxRetries: 0, ...this.clientOptions });
    } catch (err) {
      // The SDK throws at construction when no key is set.
      throw new VendorError("openai", "auth", err instanceof Error ? err.message : String(err), { cause: err });
    }
    return this.client;
  }

  async extract(input: ExtractInput): Promise<ProviderOutput> {
    const client = this.sdk();
    try {
      const response = await client.responses.create(
        {
          model: this.model,
          instructions: input.instructions,
          max_output_tokens: 16000,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:${input.mimeType};base64,${input.image.toString("base64")}`,
                  detail: "high",
                },
                { type: "input_text", text: "Extract this receipt." },
              ],
            },
          ],
          text: { format: { type: "json_schema", name: "receipt", schema: input.jsonSchema, strict: true } },
        },
        { signal: input.signal },
      );

      const refusal = response.output
        .flatMap((item) => (item.type === "message" ? item.content : []))
        .find((part) => part.type === "refusal");
      return {
        text: response.output_text,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
        model: response.model,
        refused: Boolean(refusal),
        truncated: response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens",
        ...(refusal?.type === "refusal" ? { detail: `refusal: ${refusal.refusal}` } : {}),
      };
    } catch (err) {
      throw toVendorError(err);
    }
  }
}

/** Maps SDK errors to VendorError kinds; the router decides retry or fallback from the kind. */
export function toVendorError(err: unknown): VendorError {
  const v = "openai" as const;
  const options = (e: InstanceType<typeof OpenAI.APIError>) => ({
    status: e.status,
    retryAfterMs: retryAfterMs(e.headers),
    cause: err,
  });

  if (err instanceof OpenAI.APIUserAbortError) return new VendorError(v, "timeout", "request aborted", { cause: err });
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new VendorError(v, "timeout", err.message, { cause: err });
  if (err instanceof OpenAI.APIConnectionError) return new VendorError(v, "network", err.message, { cause: err });
  if (err instanceof OpenAI.RateLimitError) {
    // 429 covers both throttling and an empty prepaid balance; only the latter is not worth retrying.
    const kind = err.code === "insufficient_quota" ? "quota" : "rate_limit";
    return new VendorError(v, kind, err.message, options(err));
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new VendorError(v, "auth", err.message, options(err));
  }
  if (err instanceof OpenAI.APIError) {
    const kind = (err.status ?? 0) >= 500 ? "server" : "bad_request";
    return new VendorError(v, kind, err.message, options(err));
  }
  return new VendorError(v, "unknown", String(err), { cause: err });
}
