interface State {
  failures: number;
  openUntil: number;
  reason?: string;
}

export interface BreakerSnapshot {
  /** `vendor:model`, so two models from one vendor are tracked separately. */
  id: string;
  state: "closed" | "open";
  consecutiveFailures: number;
  reopensInMs: number;
  reason?: string;
}

/**
 * Per-route circuit breaker, keyed by `vendor:model`. After `threshold`
 * consecutive failures a route is skipped for `cooldownMs`, so a struggling
 * vendor costs one fast skip instead of a full retry cycle on every request.
 */
export class CircuitBreaker {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private get(id: string): State {
    let state = this.states.get(id);
    if (!state) {
      state = { failures: 0, openUntil: 0 };
      this.states.set(id, state);
    }
    return state;
  }

  isOpen(id: string): boolean {
    return this.get(id).openUntil > this.now();
  }

  recordSuccess(id: string): void {
    this.states.set(id, { failures: 0, openUntil: 0 });
  }

  recordFailure(id: string, reason?: string): void {
    const state = this.get(id);
    state.failures += 1;
    if (reason) state.reason = reason;
    if (state.failures >= this.threshold) state.openUntil = this.now() + this.cooldownMs;
  }

  /** Opens immediately, e.g. when a vendor reports exhausted quota or credits. */
  trip(id: string, ms: number, reason: string): void {
    const state = this.get(id);
    state.failures = Math.max(state.failures, this.threshold);
    state.openUntil = this.now() + ms;
    state.reason = reason;
  }

  snapshot(ids: string[]): BreakerSnapshot[] {
    return ids.map((id) => {
      const state = this.get(id);
      const reopensInMs = Math.max(0, state.openUntil - this.now());
      return {
        id,
        state: reopensInMs > 0 ? "open" : "closed",
        consecutiveFailures: state.failures,
        reopensInMs,
        ...(state.reason ? { reason: state.reason } : {}),
      };
    });
  }
}
