/**
 * Eval-only vendor: runs the same extraction through the Claude Agent SDK, which
 * authenticates with a local Claude Code login instead of an API key. It lets
 * the prompt, dataset and scoring be checked against real Claude vision with no
 * key. It lives under eval/ on purpose: production routing should use API keys,
 * not a personal Claude Code login.
 *
 * Accuracy is comparable with API runs; cost and latency are not. Each call
 * carries the Claude Code harness (about 47k tokens of context and a process
 * start), and a subscription is not metered per call, so this provider reports
 * zero usage and the eval marks its candidates as accuracy-only references.
 *
 *   npm run eval -- --candidates claude-code:claude-opus-5-5 --limit 6
 */
import { query, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { VendorError, type ExtractInput, type ProviderOutput, type VisionProvider } from "@modelgate/core";

// Variables that mark the current process as a Claude Code session. Removing
// them lets the SDK start a clean child session when the eval runs inside one.
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_.*)$/;

export class ClaudeCodeProvider implements VisionProvider {
  // Reported as "anthropic": the model is Claude, so it gets the same schema, pricing and breaker handling.
  readonly vendor = "anthropic" as const;

  constructor(readonly model: string) {}

  async extract(input: ExtractInput): Promise<ProviderOutput> {
    const abortController = new AbortController();
    input.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    async function* prompt(): AsyncIterable<SDKUserMessage> {
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: input.mimeType, data: input.image.toString("base64") } },
            { type: "text", text: "Extract this receipt." },
          ],
        },
      };
    }

    let result: SDKResultMessage | undefined;
    try {
      for await (const message of query({
        prompt: prompt(),
        options: {
          model: this.model,
          systemPrompt: input.instructions,
          outputFormat: { type: "json_schema", schema: input.jsonSchema },
          tools: [], // one vision answer; no file, shell or web access
          settingSources: [], // ignore user and project settings, CLAUDE.md and hooks
          permissionMode: "dontAsk",
          persistSession: false,
          maxTurns: 4,
          abortController,
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !SESSION_VARS.test(key))),
        },
      })) {
        if (message.type === "result") result = message;
      }
    } catch (err) {
      if (input.signal.aborted) throw new VendorError("anthropic", "timeout", "request aborted", { cause: err });
      throw new VendorError("anthropic", "unknown", err instanceof Error ? err.message : String(err), { cause: err });
    }

    if (!result) throw new VendorError("anthropic", "unknown", "Claude Code ended without a result message");

    // modelUsage also lists Claude Code's own small housekeeping calls (on Haiku),
    // so report the model that did the most generation, normally the one requested.
    const model =
      Object.entries(result.modelUsage).sort(([, a], [, b]) => b.outputTokens - a.outputTokens)[0]?.[0] ?? this.model;
    const usage = { inputTokens: 0, outputTokens: 0 };

    if (result.subtype !== "success") {
      if (result.subtype === "error_max_structured_output_retries") {
        // The model never produced schema-valid output: a silent failure, not an outage.
        return { text: "", usage, model, refused: false, truncated: false, detail: result.subtype };
      }
      const kind = result.subtype === "error_during_execution" ? "server" : "unknown";
      throw new VendorError("anthropic", kind, `Claude Code returned ${result.subtype}`);
    }
    if (result.is_error) {
      // API failures surface as an errored "success" result carrying the HTTP status.
      const status = result.api_error_status ?? undefined;
      const kind = status === 429 ? "rate_limit" : status !== undefined && status >= 500 ? "server" : "unknown";
      throw new VendorError("anthropic", kind, `Claude Code API error: ${result.result.slice(0, 200)}`, status !== undefined ? { status } : {});
    }

    const refused = result.stop_reason === "refusal";
    return {
      text: result.structured_output !== undefined ? JSON.stringify(result.structured_output) : result.result,
      usage,
      model,
      refused,
      truncated: result.stop_reason === "max_tokens",
      ...(refused ? { detail: "refusal" } : {}),
    };
  }
}
