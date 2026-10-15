"use client";

import { useActionState } from "react";
import { extractReceipt, type ExtractState } from "./actions";

const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(n);
  } catch {
    return n.toFixed(2);
  }
};

export function ExtractForm() {
  const [state, action, pending] = useActionState<ExtractState, FormData>(extractReceipt, { status: "idle" });

  return (
    <>
      <form action={action} className="card upload">
        <input type="file" name="receipt" accept="image/png,image/jpeg,image/gif,image/webp" required />
        <button type="submit" disabled={pending}>
          {pending ? "Extracting…" : "Extract"}
        </button>
      </form>

      {state.status === "error" && <p className="card error">{state.message}</p>}

      {state.status === "ok" && (
        <section className="result">
          <div className="card">
            <h2>{state.result.receipt.merchant}</h2>
            <p className="muted">
              {state.result.receipt.date} · {state.result.receipt.currency} · {state.fileName}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {state.result.receipt.items.map((item, i) => (
                  <tr key={i}>
                    <td>{item.description}</td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">{money(item.amount, state.result.receipt.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Subtotal</td>
                  <td className="num">{money(state.result.receipt.subtotal, state.result.receipt.currency)}</td>
                </tr>
                <tr>
                  <td colSpan={2}>Tax</td>
                  <td className="num">{money(state.result.receipt.tax, state.result.receipt.currency)}</td>
                </tr>
                <tr className="total">
                  <td colSpan={2}>Total</td>
                  <td className="num">{money(state.result.receipt.total, state.result.receipt.currency)}</td>
                </tr>
              </tfoot>
            </table>
            {state.result.warnings.map((w) => (
              <p key={w} className="warning">
                {w}
              </p>
            ))}
          </div>

          <div className="card">
            <h3>How it was served</h3>
            <dl className="facts">
              <dt>Vendor</dt>
              <dd>
                {state.result.vendor} · {state.result.model}
                {state.result.fell_back && <span className="tag">fallback</span>}
              </dd>
              <dt>Cost</dt>
              <dd>${state.result.cost_usd.toFixed(5)}</dd>
              <dt>Latency</dt>
              <dd>{(state.result.latency_ms / 1000).toFixed(1)} s</dd>
              <dt>Prompt</dt>
              <dd>v{state.result.prompt_version}</dd>
            </dl>
            <ol className="attempts">
              {state.result.attempts.map((a, i) => (
                <li key={i} className={a.outcome}>
                  <strong>{a.outcome}</strong> {a.vendor}:{a.model}
                  {a.attempt > 0 && ` #${a.attempt}`} · {a.latencyMs} ms{a.reason && ` · ${a.reason}`}
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </>
  );
}
