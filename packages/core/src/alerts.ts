export type AlertKind =
  | "budget_warning"
  | "budget_exhausted"
  | "quota_exhausted"
  | "all_vendors_failed"
  | "unpriced_model";

export interface Alert {
  kind: AlertKind;
  message: string;
  data: Record<string, unknown>;
  at: string;
}

export interface AlertsOptions {
  /** Slack-compatible incoming webhook. Receives `{ text }`. */
  webhook?: string | undefined;
  /** Same kind + key inside this window is sent once. */
  dedupeMs?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Alerts go to stderr (stdout is the MCP protocol channel and must stay clean)
 * and, when configured, to a webhook so a person hears about spend and vendor
 * problems without reading logs.
 */
export class Alerts {
  readonly sent: Alert[] = [];
  private readonly lastSent = new Map<string, number>();
  private readonly dedupeMs: number;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: AlertsOptions = {}) {
    this.dedupeMs = options.dedupeMs ?? 10 * 60_000;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async send(kind: AlertKind, message: string, data: Record<string, unknown> = {}, key = ""): Promise<void> {
    const dedupeKey = `${kind}:${key}`;
    const last = this.lastSent.get(dedupeKey);
    if (last !== undefined && this.now() - last < this.dedupeMs) return;
    this.lastSent.set(dedupeKey, this.now());

    const alert: Alert = { kind, message, data, at: new Date(this.now()).toISOString() };
    this.sent.push(alert);
    this.log(JSON.stringify({ level: "alert", ...alert }));

    if (!this.options.webhook) return;
    try {
      const res = await this.fetchImpl(this.options.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[modelgate] ${kind}: ${message}` }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) this.log(JSON.stringify({ level: "warn", msg: "alert webhook rejected", status: res.status }));
    } catch (err) {
      // An alerting outage must never break extraction.
      this.log(JSON.stringify({ level: "warn", msg: "alert webhook failed", error: String(err) }));
    }
  }
}
