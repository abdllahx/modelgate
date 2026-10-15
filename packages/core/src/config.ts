import { join } from "node:path";
import type { VendorId } from "./providers/types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface VendorSpec {
  vendor: VendorId;
  model: string;
}

export const DEFAULT_MODELS: Record<VendorId, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5-mini",
  gemini: "gemini-2.5-flash",
  mock: "mock-vision",
};

const VENDORS: readonly VendorId[] = ["anthropic", "openai", "gemini", "mock"];

/** Any string map works (process.env, a test fixture), without requiring framework-specific keys. */
export type Env = Record<string, string | undefined>;
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface Config {
  /** Routing order. The first healthy vendor serves; the rest are fallbacks. */
  vendors: VendorSpec[];
  anthropicEffort: Effort;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  quotaCooldownMs: number;
  budgetUsd: number;
  budgetWarnAt: number;
  alertWebhook: string | undefined;
  home: string;
  maxImageBytes: number;
}

export function parseVendorSpec(spec: string, env: Env = process.env): VendorSpec {
  const [name = "", ...rest] = spec.trim().split(":");
  const vendor = VENDORS.find((v) => v === name);
  if (!vendor) {
    throw new Error(`Unknown vendor "${name}". Expected one of: ${VENDORS.join(", ")}`);
  }
  const model = rest.join(":") || env[`MODELGATE_${vendor.toUpperCase()}_MODEL`] || DEFAULT_MODELS[vendor];
  return { vendor, model };
}

export function specId(spec: VendorSpec): string {
  return `${spec.vendor}:${spec.model}`;
}

export function hasCredentials(vendor: VendorId, env: Env = process.env): boolean {
  switch (vendor) {
    case "anthropic":
      return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    case "openai":
      return Boolean(env.OPENAI_API_KEY);
    case "gemini":
      return Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
    case "mock":
      return true;
  }
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Expected a non-negative number, got "${value}"`);
  return parsed;
}

function effort(value: string | undefined): Effort {
  if (!value) return "medium";
  const match = EFFORTS.find((e) => e === value);
  if (!match) throw new Error(`MODELGATE_ANTHROPIC_EFFORT must be one of ${EFFORTS.join(", ")}`);
  return match;
}

export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
  const explicit = env.MODELGATE_VENDORS?.trim();
  const vendors = explicit
    ? explicit
        .split(",")
        .filter((s) => s.trim())
        .map((s) => parseVendorSpec(s, env))
    : (["anthropic", "openai", "gemini"] as const)
        .filter((v) => hasCredentials(v, env))
        .map((v) => parseVendorSpec(v, env));

  return {
    vendors,
    anthropicEffort: effort(env.MODELGATE_ANTHROPIC_EFFORT),
    timeoutMs: num(env.MODELGATE_TIMEOUT_MS, 60_000),
    maxAttempts: Math.max(1, num(env.MODELGATE_MAX_ATTEMPTS, 3)),
    baseDelayMs: num(env.MODELGATE_BASE_DELAY_MS, 500),
    breakerThreshold: Math.max(1, num(env.MODELGATE_BREAKER_THRESHOLD, 3)),
    breakerCooldownMs: num(env.MODELGATE_BREAKER_COOLDOWN_MS, 60_000),
    quotaCooldownMs: num(env.MODELGATE_QUOTA_COOLDOWN_MS, 15 * 60_000),
    budgetUsd: num(env.MODELGATE_BUDGET_USD, 5),
    budgetWarnAt: Math.min(1, num(env.MODELGATE_BUDGET_WARN_AT, 0.8)),
    alertWebhook: env.MODELGATE_ALERT_WEBHOOK || undefined,
    home: env.MODELGATE_HOME || join(cwd, ".modelgate"),
    maxImageBytes: num(env.MODELGATE_MAX_IMAGE_BYTES, 5 * 1024 * 1024),
  };
}
