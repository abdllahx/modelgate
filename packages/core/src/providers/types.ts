export type VendorId = "anthropic" | "openai" | "gemini" | "mock";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export interface ExtractInput {
  image: Buffer;
  mimeType: ImageMime;
  instructions: string;
  jsonSchema: Record<string, unknown>;
  signal: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  /** Includes reasoning/thinking tokens, which every vendor bills as output. */
  outputTokens: number;
}

/**
 * Raw vendor output. Providers never parse or judge the JSON themselves:
 * validation is centralised so every vendor is held to identical checks.
 */
export interface ProviderOutput {
  text: string;
  usage: Usage;
  /** The model that actually served the request (can differ after a server-side fallback). */
  model: string;
  refused: boolean;
  truncated: boolean;
  detail?: string;
}

/** Overrides for API gateways or proxies, and for contract tests against a local server. */
export interface ClientOptions {
  baseURL?: string;
  apiKey?: string;
}

export interface VisionProvider {
  readonly vendor: VendorId;
  readonly model: string;
  extract(input: ExtractInput): Promise<ProviderOutput>;
}

export type FailureKind =
  | "rate_limit"
  | "server"
  | "timeout"
  | "network"
  | "quota"
  | "auth"
  | "bad_request"
  | "unknown";

export const RETRYABLE: ReadonlySet<FailureKind> = new Set(["rate_limit", "server", "timeout", "network"]);

export class VendorError extends Error {
  readonly vendor: VendorId;
  readonly kind: FailureKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    vendor: VendorId,
    kind: FailureKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "VendorError";
    this.vendor = vendor;
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
