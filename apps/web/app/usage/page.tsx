import { api, type ReportResponse, type StatusResponse } from "../../lib/api";

// Always render with live numbers; never prerender at build time.
export const dynamic = "force-dynamic";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(4)}`;

export default async function Usage() {
  const [status, report] = await Promise.all([api<StatusResponse>("/v1/status"), api<ReportResponse>("/v1/report")]);
  if (!status.ok || !report.ok) {
    return <p className="card error">{!status.ok ? status.message : !report.ok ? report.message : ""}</p>;
  }
  const { budget } = status.data;
  const r = report.data;
  const used = budget.limitUsd > 0 ? Math.min(1, budget.spentUsd / budget.limitUsd) : 0;

  return (
    <>
      <h1>Usage · {r.period}</h1>

      <div className="card">
        <h3>Budget</h3>
        <div className={`meter ${used >= budget.warnAt ? "hot" : ""}`}>
          <span style={{ width: `${used * 100}%` }} />
        </div>
        <p className="muted">
          {usd(budget.spentUsd)} of {budget.limitUsd > 0 ? usd(budget.limitUsd) : "no limit"} spent
          {budget.remainingUsd !== null && ` · ${usd(budget.remainingUsd)} left`}
        </p>
      </div>

      <div className="stats">
        <div className="card stat">
          <span>Requests</span>
          <strong>{r.requests}</strong>
        </div>
        <div className="card stat">
          <span>Success rate</span>
          <strong>{pct(r.successRate)}</strong>
        </div>
        <div className="card stat">
          <span>Served after fallback</span>
          <strong>{pct(r.fallbackRate)}</strong>
        </div>
        <div className="card stat">
          <span>Silent failures caught</span>
          <strong>{r.silentFailuresCaught}</strong>
        </div>
        <div className="card stat">
          <span>Cost per extraction</span>
          <strong>{usd(r.costPerSuccessUsd)}</strong>
        </div>
        <div className="card stat">
          <span>Latency p50 / p95</span>
          <strong>
            {(r.latencyP50Ms / 1000).toFixed(1)} / {(r.latencyP95Ms / 1000).toFixed(1)} s
          </strong>
        </div>
      </div>

      <div className="card">
        <h3>Routing · prompt v{status.data.prompt.version}</h3>
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th>Breaker</th>
              <th className="num">Served</th>
              <th className="num">Spend</th>
            </tr>
          </thead>
          <tbody>
            {status.data.breakers.map((b) => {
              const vendor = b.id.split(":")[0] ?? b.id;
              return (
                <tr key={b.id}>
                  <td>{b.id}</td>
                  <td>
                    {b.state === "open" ? (
                      <span className="tag hot">open · {b.reason ?? "failing"}</span>
                    ) : (
                      <span className="tag">closed</span>
                    )}
                  </td>
                  <td className="num">{r.servedByVendor[vendor] ?? 0}</td>
                  <td className="num">{usd(r.costByVendor[vendor] ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {Object.keys(r.silentFailuresByIssue).length > 0 && (
          <p className="muted">
            Rejected outputs:{" "}
            {Object.entries(r.silentFailuresByIssue)
              .map(([issue, n]) => `${issue} ${n}`)
              .join(", ")}
          </p>
        )}
      </div>
    </>
  );
}
