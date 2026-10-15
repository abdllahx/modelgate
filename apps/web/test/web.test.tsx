import type { AddressInfo } from "node:net";
import { Alerts, createRuntime, loadConfig } from "@modelgate/core";
import { connect, PostgresBudget, PostgresUsageLog, type Connection } from "@modelgate/db";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../api/src/app.js";
import { output, PNG_1PX, RECEIPT, scripted } from "../../../packages/core/test/helpers.js";
import { extractReceipt } from "../app/actions.js";
import Usage from "../app/usage/page.js";

// The web app's server code runs against a real API (Express + PGlite), with a scripted vendor.
let connection: Connection;
let server: ReturnType<ReturnType<typeof createApi>["listen"]>;

beforeAll(async () => {
  connection = await connect();
  const config = loadConfig({});
  const alerts = new Alerts({ log: () => {} });
  const budget = new PostgresBudget(connection.db, { limitUsd: 5, warnAt: 0.8, alerts });
  const usage = new PostgresUsageLog(connection.db, "api");
  const { router, breaker, prompt } = createRuntime(config, { budget, usage, alerts }, { providers: [scripted("anthropic", [output()])] });
  const app = createApi({ router, budget, usage, breaker, prompt, maxImageBytes: 1_000_000, token: "web-secret" });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  process.env.MODELGATE_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.MODELGATE_API_TOKEN = "web-secret";
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await connection.close();
});

const upload = (bytes: Buffer, name: string, type: string) => {
  const form = new FormData();
  form.set("receipt", new File([new Uint8Array(bytes)], name, { type }));
  return form;
};

describe("extract server action", () => {
  it("uploads the image to the API with the server-side token and returns the receipt", async () => {
    const state = await extractReceipt({ status: "idle" }, upload(PNG_1PX, "receipt.png", "image/png"));
    expect(state).toMatchObject({ status: "ok", fileName: "receipt.png", result: { receipt: RECEIPT, vendor: "anthropic" } });
  });

  it("passes API errors through as a readable message", async () => {
    const state = await extractReceipt({ status: "idle" }, upload(Buffer.from("not an image"), "notes.png", "image/png"));
    expect(state).toEqual({ status: "error", message: "Unsupported content: expected a PNG, JPEG, GIF or WebP image." });
  });

  it("asks for a file when none was chosen", async () => {
    expect(await extractReceipt({ status: "idle" }, new FormData())).toEqual({ status: "error", message: "Choose a receipt image first." });
  });
});

describe("usage page", () => {
  it("renders live budget, outcome and routing numbers from the API", async () => {
    const html = renderToStaticMarkup(await Usage());
    expect(html).toContain("Success rate");
    expect(html).toMatch(/<strong>1<\/strong>/); // one successful request so far
    expect(html).toContain("anthropic:claude-haiku-5-5");
    expect(html).toMatch(/of \$5\.0000 spent/);
  });

  it("explains when the API is unreachable instead of crashing", async () => {
    const saved = process.env.MODELGATE_API_URL;
    process.env.MODELGATE_API_URL = "http://127.0.0.1:9";
    try {
      const html = renderToStaticMarkup(await Usage());
      expect(html).toContain("not reachable at http://127.0.0.1:9");
    } finally {
      process.env.MODELGATE_API_URL = saved;
    }
  });
});
