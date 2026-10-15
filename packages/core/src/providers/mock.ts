import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Receipt } from "../schema.js";
import type { ExtractInput, ProviderOutput, VisionProvider } from "./types.js";

export type MockResponder = (input: ExtractInput, call: number) => Promise<ProviderOutput> | ProviderOutput;

/**
 * Offline vendor for tests and keyless demos. It never calls a network API and
 * costs nothing, so the whole MCP flow can be exercised without credentials.
 */
export class MockProvider implements VisionProvider {
  readonly vendor = "mock" as const;
  calls = 0;

  constructor(
    private readonly respond: MockResponder,
    readonly model = "mock-vision",
  ) {}

  async extract(input: ExtractInput): Promise<ProviderOutput> {
    this.calls += 1;
    if (input.signal.aborted) throw input.signal.reason;
    return this.respond(input, this.calls);
  }

  /** Answers with the ground-truth label for images from the eval dataset, and an empty receipt otherwise. */
  static fromDataset(
    dir = process.env.MODELGATE_MOCK_DATASET || fileURLToPath(new URL("../../../eval/dataset", import.meta.url)),
  ): MockProvider {
    const labels = new Map<string, Receipt>();
    const file = join(dir, "labels.json");
    if (existsSync(file)) {
      const entries = JSON.parse(readFileSync(file, "utf8")) as Array<{ file: string; receipt: Receipt }>;
      for (const entry of entries) {
        const path = join(dir, entry.file);
        if (existsSync(path)) labels.set(sha256(readFileSync(path)), entry.receipt);
      }
    }
    const empty: Receipt = { merchant: "", date: "", currency: "", items: [], subtotal: 0, tax: 0, total: 0 };
    return new MockProvider((input) => ({
      text: JSON.stringify(labels.get(sha256(input.image)) ?? empty),
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "mock-vision",
      refused: false,
      truncated: false,
    }));
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
