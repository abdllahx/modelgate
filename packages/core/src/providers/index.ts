import type { Config, VendorSpec } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import type { VisionProvider } from "./types.js";

export function createProvider(spec: VendorSpec, config: Pick<Config, "anthropicEffort">): VisionProvider {
  switch (spec.vendor) {
    case "anthropic":
      return new AnthropicProvider(spec.model, config.anthropicEffort);
    case "openai":
      return new OpenAIProvider(spec.model);
    case "gemini":
      return new GeminiProvider(spec.model);
    case "mock":
      return MockProvider.fromDataset();
  }
}

export * from "./types.js";
export { AnthropicProvider } from "./anthropic.js";
export { GeminiProvider } from "./gemini.js";
export { OpenAIProvider } from "./openai.js";
