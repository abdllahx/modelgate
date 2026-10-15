---
name: add-vendor
description: Add a new vision LLM vendor or model to ModelGate (provider class, error mapping, pricing, tests, eval). Use when asked to support another provider such as Mistral or Bedrock, or to evaluate a new model from an existing vendor.
---

# Adding a vendor to ModelGate

A new **model** from an existing vendor needs no code: add its price row (step 3) and evaluate it with `--candidates vendor:model-id` (step 6).

A new **vendor** needs all of the steps.

## 1. Provider class: `packages/core/src/providers/<vendor>.ts`

Implement `VisionProvider` the way `packages/core/src/providers/openai.ts` does. All paths below are under `packages/core/` unless stated.

- Construct the SDK client with its retries disabled (`maxRetries: 0` or the vendor's equivalent). The router owns retries.
- Send the image, `input.instructions` as the system prompt, and `input.jsonSchema` through the vendor's structured-output feature.
- Pass `input.signal` to the request so router timeouts cancel it.
- Return raw `text`, token `usage` (count reasoning tokens as output), the `model` that served the request, and `refused` / `truncated` flags. Do not parse the JSON.
- Map errors with the SDK's typed error classes to a `VendorError` kind: `rate_limit`, `server`, `timeout`, `network` (retried), or `quota`, `auth`, `bad_request`, `unknown` (not retried). Read `retry-after` with `retryAfterMs()` where the SDK exposes headers.

## 2. Wiring

- Add the id to `VendorId` in `src/providers/types.ts`, `VENDORS` and `DEFAULT_MODELS` in `src/config.ts`, the key check in `hasCredentials`, and the case in `createProvider`.
- Add the vendor to the `VENDOR` enum in `apps/mcp/src/server.ts`, the `ExtractBody` enum in `apps/api/src/app.ts`, the `.mcp.json` env block, `render.yaml`, and `.env.example`.
- If the vendor rejects part of the JSON Schema, adapt it in `receiptJsonSchema()` and cover it in `test/units.test.ts`.
- Accept the `ClientOptions` base URL so it works behind gateways, and add a contract test in `test/contract.test.ts` that replays the vendor's wire format from the local server.

## 3. Pricing

Add a row to `PRICING` in `src/pricing.ts` from the vendor's official pricing page, and update the verification date and source in the comment above it.

## 4. Tests

- An error-mapping test for each `VendorError` kind the SDK can produce.
- Run `npm run typecheck && npm test && npm run check:plugin`.

## 5. Docs

Add the vendor to the README's vendor table and environment variables.

## 6. Evaluate (costs money: ask first)

```bash
npm run eval -- --candidates <vendor>,<current primary> --max-usd 2
npm run eval:gate
```

Report the vendor's field accuracy, valid-output rate, p95 latency and cost per 1k documents next to the current primary, and say whether `EVAL.md` now recommends a different routing order. Do not change `MODELGATE_VENDORS` defaults without the user agreeing.
