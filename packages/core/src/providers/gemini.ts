import { ApiError, GoogleGenAI } from "@google/genai";
import { VendorError, type ClientOptions, type ExtractInput, type ProviderOutput, type VisionProvider } from "./types.js";

// Finish reasons where the model stopped for policy reasons rather than finishing.
const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

export class GeminiProvider implements VisionProvider {
  readonly vendor = "gemini" as const;
  private client: GoogleGenAI | undefined;

  constructor(
    readonly model: string,
    private readonly clientOptions: ClientOptions = {},
  ) {}

  private sdk(): GoogleGenAI {
    if (this.client) return this.client;
    const apiKey = this.clientOptions.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    try {
      this.client = new GoogleGenAI({
        ...(apiKey ? { apiKey } : {}),
        // attempts: 1 disables the SDK's own retries; the router owns them.
        httpOptions: {
          retryOptions: { attempts: 1 },
          ...(this.clientOptions.baseURL ? { baseUrl: this.clientOptions.baseURL } : {}),
        },
      });
    } catch (err) {
      throw new VendorError("gemini", "auth", err instanceof Error ? err.message : String(err), { cause: err });
    }
    return this.client;
  }

  async extract(input: ExtractInput): Promise<ProviderOutput> {
    const client = this.sdk();
    try {
      const response = await client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: input.mimeType, data: input.image.toString("base64") } },
              { text: "Extract this receipt." },
            ],
          },
        ],
        config: {
          systemInstruction: input.instructions,
          responseMimeType: "application/json",
          responseJsonSchema: input.jsonSchema,
          maxOutputTokens: 16000,
          abortSignal: input.signal,
        },
      });

      const finish = response.candidates?.[0]?.finishReason;
      const blockReason = response.promptFeedback?.blockReason;
      const refused = Boolean(blockReason) || (finish !== undefined && BLOCKED.has(finish));
      const usage = response.usageMetadata;
      return {
        text: response.text ?? "",
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        },
        model: response.modelVersion ?? this.model,
        refused,
        truncated: finish === "MAX_TOKENS",
        ...(refused ? { detail: `blocked: ${blockReason ?? finish}` } : {}),
      };
    } catch (err) {
      throw toVendorError(err);
    }
  }
}

/** Maps SDK errors to VendorError kinds; the router decides retry or fallback from the kind. */
export function toVendorError(err: unknown): VendorError {
  const v = "gemini" as const;
  if (err instanceof ApiError) {
    const status = err.status;
    const kind =
      status === 429 ? "rate_limit" : status === 401 || status === 403 ? "auth" : status >= 500 ? "server" : "bad_request";
    return new VendorError(v, kind, err.message, { status, cause: err });
  }
  if (err instanceof Error && err.name === "AbortError") return new VendorError(v, "timeout", "request aborted", { cause: err });
  if (err instanceof TypeError) return new VendorError(v, "network", err.message, { cause: err });
  return new VendorError(v, "unknown", String(err), { cause: err });
}
