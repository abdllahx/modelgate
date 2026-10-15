# Vendor evaluation

Generated 2026-10-15T11:31:34.960Z · prompt `extract-receipt` v1 · 28 synthetic receipts

| Candidate | Field accuracy | Exact match | Valid output | Silent failures caught | Latency p50 / p95 | Cost / doc | Cost / 1k docs |
|---|---|---|---|---|---|---|---|
| `claude-code:claude-haiku-5-5` (reference) | 100.0% | 100.0% | 100.0% | 0 | n/a | n/a | n/a |
| `claude-code:claude-sonnet-5-5` (reference) | 100.0% | 100.0% | 100.0% | 0 | n/a | n/a | n/a |
| `claude-code:claude-opus-5-5` (reference) | 100.0% | 100.0% | 100.0% | 0 | n/a | n/a | n/a |
| **routed (production chain)** (reference) | 99.5% | 96.4% | 100.0% | 0 | n/a | n/a | n/a |

## Recommendation

Only reference candidates (Claude Code login) were run, so there is no cost to compare. Run API-key vendors for a routing recommendation.

## Accuracy by difficulty

| Candidate | clean | faded | rotated | noisy | small | thermal | skewed |
|---|---|---|---|---|---|---|---|
| `claude-code:claude-haiku-5-5` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `claude-code:claude-sonnet-5-5` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `claude-code:claude-opus-5-5` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `routed` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 96.4% |

## Accuracy by field

| Candidate | merchant | date | currency | items | subtotal | tax | total |
|---|---|---|---|---|---|---|---|
| `claude-code:claude-haiku-5-5` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `claude-code:claude-sonnet-5-5` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `claude-code:claude-opus-5-5` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `routed` | 100.0% | 100.0% | 100.0% | 96.4% | 100.0% | 100.0% | 100.0% |

## Misses

- `routed`: receipt-28.png (skewed; wrong items via anthropic:claude-haiku-5-5)

## Method

- Each candidate runs alone with production settings (same prompt, retries and validation, no fallback). "routed" runs the full chain in `MODELGATE_VENDORS` order.
- Field accuracy is the share of 7 fields (merchant, date, currency, items, subtotal, tax, total) that match the label. Money matches within 0.01; items match by name and amount.
- Silent failures caught are HTTP 200 responses rejected by validation (refusals, truncation, invalid JSON, schema misses, empty fields, totals that do not add up).
- Cost is computed from each response's token usage and the price table in `src/pricing.ts`.
- Reference rows ran through the Claude Agent SDK on a Claude Code login, not an API key. Their accuracy is comparable; cost and latency are not (the Claude Code harness adds context and a process start to every call), so they are excluded from the recommendation.
- Reproduce: `npm run eval -- --candidates claude-code:claude-haiku-5-5,claude-code:claude-sonnet-5-5,claude-code:claude-opus-5-5`
