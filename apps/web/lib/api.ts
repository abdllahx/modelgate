// Server-side client for the ModelGate API. The bearer token is read from the
// server environment and never sent to the browser.

export interface Attempt {
  vendor: string;
  model: string;
  attempt: number;
  outcome: "ok" | "error" | "invalid" | "skipped";
  reason?: string;
  latencyMs: number;
  costUsd: number;
}

export interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface ExtractResponse {
  request_id: string;
  receipt: { merchant: string; date: string; currency: string; items: LineItem[]; subtotal: number; tax: number; total: number };
  vendor: string;
  model: string;
  cost_usd: number;
  latency_ms: number;
  prompt_version: number;
  fell_back: boolean;
  warnings: string[];
  attempts: Attempt[];
}

export interface StatusResponse {
  routing: Array<{ vendor: string; model: string }>;
  breakers: Array<{ id: string; state: "open" | "closed"; consecutiveFailures: number; reopensInMs: number; reason?: string }>;
  prompt: { id: string; version: number };
  budget: { period: string; spentUsd: number; limitUsd: number; remainingUsd: number | null; warnAt: number };
}

export interface ReportResponse {
  period: string;
  requests: number;
  succeeded: number;
  successRate: number;
  fallbackRate: number;
  silentFailuresCaught: number;
  silentFailuresByIssue: Record<string, number>;
  budgetBlocked: number;
  totalCostUsd: number;
  costPerSuccessUsd: number;
  costByVendor: Record<string, number>;
  servedByVendor: Record<string, number>;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

const baseUrl = () => process.env.MODELGATE_API_URL ?? "http://localhost:3001";

export async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const token = process.env.MODELGATE_API_TOKEN;
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) return { ok: false, status: res.status, message: body.message ?? res.statusText };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, message: `The ModelGate API is not reachable at ${baseUrl()}.` };
  }
}
