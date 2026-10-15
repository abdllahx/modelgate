import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { loadConfig, parseVendorSpec } from "../src/config.js";
import { ImageInputError, loadImage, sniffMime } from "../src/image.js";
import { costOf, priceFor } from "../src/pricing.js";
import { loadPrompt, parsePrompt } from "../src/prompts.js";
import { receiptJsonSchema } from "../src/schema.js";
import { PNG_1PX } from "./helpers.js";

describe("pricing", () => {
  it("prices by longest matching prefix", () => {
    expect(priceFor("gemini-2.5-flash-lite").price.input).toBe(0.1);
    expect(priceFor("gemini-2.5-flash-001").price.input).toBe(0.3);
    expect(priceFor("gpt-5-mini-2026-01-01").price.output).toBe(2);
  });

  it("charges unknown models at the most expensive known rate", () => {
    const { usd, estimated } = costOf("brand-new-model", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(estimated).toBe(true);
    expect(usd).toBe(Math.max(...["claude-opus-5", "claude-opus-5-5"].map((m) => priceFor(m).price.input)));
  });
});

describe("config", () => {
  it("routes only through vendors that have credentials, in a fixed order", () => {
    const config = loadConfig({ OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "g-test" }, "/tmp/project");
    expect(config.vendors).toEqual([
      { vendor: "openai", model: "gpt-5-mini" },
      { vendor: "gemini", model: "gemini-2.5-flash" },
    ]);
    expect(config.home).toBe("/tmp/project/.modelgate");
  });

  it("accepts an explicit order with model overrides", () => {
    const config = loadConfig({ MODELGATE_VENDORS: "gemini:gemini-3.8-flash, anthropic" });
    expect(config.vendors).toEqual([
      { vendor: "gemini", model: "gemini-3.8-flash" },
      { vendor: "anthropic", model: "claude-opus-5-5" },
    ]);
  });

  it("rejects unknown vendors and bad numbers loudly", () => {
    expect(() => parseVendorSpec("mistral")).toThrow(/Unknown vendor/);
    expect(() => loadConfig({ MODELGATE_BUDGET_USD: "five" })).toThrow(/non-negative number/);
  });
});

describe("prompts", () => {
  it("loads the versioned extraction prompt", () => {
    const prompt = loadPrompt();
    expect(prompt.id).toBe("extract-receipt");
    expect(prompt.version).toBeGreaterThanOrEqual(1);
    expect(prompt.text).toMatch(/ISO 8601/);
  });

  it("refuses a prompt without a version", () => {
    expect(() => parsePrompt("---\nid: x\n---\nbody")).toThrow(/version/);
  });
});

describe("schema", () => {
  it("sends strict schemas to OpenAI and Anthropic, and drops additionalProperties for Gemini", () => {
    expect(JSON.stringify(receiptJsonSchema("openai"))).toContain('"additionalProperties":false');
    expect(JSON.stringify(receiptJsonSchema("gemini"))).not.toContain("additionalProperties");
    expect(receiptJsonSchema("openai")).not.toHaveProperty("$schema");
  });
});

describe("image input", () => {
  const dir = mkdtempSync(join(tmpdir(), "modelgate-img-"));

  it("identifies images by content, not by file name", async () => {
    writeFileSync(join(dir, "receipt.txt"), PNG_1PX);
    const image = await loadImage({ path: join(dir, "receipt.txt") }, 1_000_000);
    expect(image.mimeType).toBe("image/png");
  });

  it("refuses non-image files so the tool cannot read arbitrary files", async () => {
    writeFileSync(join(dir, "secrets.png"), "OPENAI_API_KEY=sk-live");
    await expect(loadImage({ path: join(dir, "secrets.png") }, 1_000_000)).rejects.toThrow(/Unsupported content/);
  });

  it("enforces the size limit and exactly one source", async () => {
    await expect(loadImage({ base64: PNG_1PX.toString("base64") }, 10)).rejects.toThrow(/limit/);
    await expect(loadImage({}, 1_000)).rejects.toBeInstanceOf(ImageInputError);
    await expect(loadImage({ path: "a.png", base64: "AAAA" }, 1_000)).rejects.toBeInstanceOf(ImageInputError);
  });

  it("accepts data URLs", async () => {
    const image = await loadImage({ base64: `data:image/png;base64,${PNG_1PX.toString("base64")}` }, 1_000_000);
    expect(image.bytes.equals(PNG_1PX)).toBe(true);
  });

  it("sniffs JPEG, GIF and WebP", () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });
});

describe("alerts", () => {
  it("posts to the webhook and de-duplicates within the window", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const alerts = new Alerts({ webhook: "https://hooks.example/x", fetchImpl, log: () => {} });

    await alerts.send("quota_exhausted", "openai is out of credits", {}, "openai");
    await alerts.send("quota_exhausted", "openai is out of credits", {}, "openai");

    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ text: "[modelgate] quota_exhausted: openai is out of credits" });
  });

  it("never throws when the webhook is down", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const alerts = new Alerts({ webhook: "https://hooks.example/x", fetchImpl, log: () => {} });
    await expect(alerts.send("all_vendors_failed", "x")).resolves.toBeUndefined();
  });
});
