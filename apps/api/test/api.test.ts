import type { AddressInfo } from "node:net";
import { Alerts, createRuntime, loadConfig } from "@modelgate/core";
import { connect, PostgresBudget, PostgresUsageLog, type Connection } from "@modelgate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { output, PNG_1PX, RECEIPT, scripted } from "../../../packages/core/test/helpers.js";
import { createApi } from "../src/app.js";

let base = "";
let connection: Connection;
let server: ReturnType<ReturnType<typeof createApi>["listen"]>;

beforeAll(async () => {
  connection = await connect(); // in-memory PGlite with real migrations
  const config = loadConfig({ MODELGATE_BUDGET_USD: "1" });
  const alerts = new Alerts({ log: () => {} });
  const budget = new PostgresBudget(connection.db, { limitUsd: 1, warnAt: 0.8, alerts });
  const usage = new PostgresUsageLog(connection.db, "api");
  // First call costs 2,000,000 input tokens on Haiku ($0.20); the provider is scripted, no network.
  const provider = scripted("anthropic", [output({ usage: { inputTokens: 2_000_000, outputTokens: 0 } })]);
  const { router, breaker, prompt } = createRuntime(config, { budget, usage, alerts }, { providers: [provider], sleep: async () => {} });
  const app = createApi({ router, budget, usage, breaker, prompt, maxImageBytes: 50_000, token: "secret" });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await connection.close();
});

const post = (path: string, body: unknown, token = "secret") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: "Bearer secret" } });

describe("API", () => {
  it("serves an unauthenticated health check", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, promptVersion: 1 });
  });

  it("rejects a missing or wrong bearer token", async () => {
    expect((await post("/v1/extract", { image_base64: "x" }, "nope")).status).toBe(401);
    expect((await fetch(`${base}/v1/status`)).status).toBe(401);
  });

  it("extracts a receipt and records spend and usage in Postgres", async () => {
    const res = await post("/v1/extract", { image_base64: PNG_1PX.toString("base64") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ receipt: RECEIPT, vendor: "anthropic", prompt_version: 1, fell_back: false });

    const status = (await (await get("/v1/status")).json()) as { budget: { spentUsd: number } };
    expect(status.budget.spentUsd).toBeCloseTo(0.2);
    const report = (await (await get("/v1/report")).json()) as { requests: number; successRate: number };
    expect(report).toMatchObject({ requests: 1, successRate: 1 });
  });

  it.each([
    ["400 for a body that fails validation", { vendors: ["anthropic"] }, 400, "invalid_request"],
    ["400 for malformed JSON", "{not json", 400, "invalid_request"],
    ["422 for content that is not an image", { image_base64: Buffer.from("hello").toString("base64") }, 422, "invalid_image"],
    ["413 for an image over the size limit", { image_base64: "A".repeat(200_000) }, 413, "too_large"],
  ])("returns %s", async (_label, body, status, error) => {
    const res = await post("/v1/extract", body);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error });
  });

  it("returns 402 once the shared monthly budget is spent", async () => {
    for (let i = 0; i < 4; i++) await post("/v1/extract", { image_base64: PNG_1PX.toString("base64") }); // $0.20 each
    const res = await post("/v1/extract", { image_base64: PNG_1PX.toString("base64") });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "budget_exhausted" });
  });

  it("validates the report period", async () => {
    expect((await get("/v1/report?period=october")).status).toBe(400);
  });
});
