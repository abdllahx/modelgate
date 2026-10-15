# ModelGate

Turns receipt images into validated JSON by routing each request across Claude, GPT and Gemini, with retries, fallback, silent-failure detection and a shared monthly budget. It ships as three surfaces over one core:

- **Claude Code plugin + MCP server**: agents extract receipts as a tool, with a skill, slash commands and guard hooks.
- **Express API on Render**: for backends and anything that is not an agent.
- **Next.js app on Vercel**: upload a receipt, and watch spend, success, fallback and silent-failure rates.

```
                      ┌──────────────┐   ┌──────────────┐   ┌────────────────┐
                      │ apps/mcp     │   │ apps/api     │◀──│ apps/web       │
 Claude Code ──MCP──▶ │ MCP server + │   │ Express      │   │ Next.js        │
                      │ plugin       │   │ (Render)     │   │ (Vercel)       │
                      └──────┬───────┘   └──────┬───────┘   └────────────────┘
                             ▼                  ▼
                 ┌─────────────────────────────────────────────┐
                 │ packages/core: router · validation · budget │──▶ Claude / GPT / Gemini
                 └──────────────────────┬──────────────────────┘
                                        ▼
                 ┌─────────────────────────────────────────────┐
                 │ packages/db: Drizzle · Postgres             │  shared ledger + usage
                 └─────────────────────────────────────────────┘
```

## Why

Vision APIs fail in two ways. The loud way (rate limits, outages, exhausted credits) is easy to see. The quiet way is worse: an HTTP 200 carrying a refusal, truncated JSON, an empty receipt, or totals that do not add up. Code that only checks the status code passes those downstream as success. ModelGate treats every response as untrusted until it validates, measures every vendor on the same labeled dataset, and keeps spend inside a budget someone set on purpose.

## Stack

| | |
|---|---|
| Monorepo | Turborepo, npm workspaces, TypeScript 7, ESM, Node 22 |
| Core | Anthropic, OpenAI and Google GenAI SDKs, Zod |
| Data | Drizzle ORM and migrations; Postgres in production, embedded PGlite locally and in tests |
| API | Express 5, deployed on Render (`render.yaml` blueprint with Postgres) |
| Web | Next.js 16 App Router with server actions, deployed on Vercel |
| Agent tooling | MCP TypeScript SDK, Claude Code plugin (skills, commands, hooks), Claude Agent SDK for keyless evals and agent tests |
| Quality | Vitest (130 tests), CI on GitHub Actions, CodeRabbit review policy |

## Run it

```bash
npm ci
cp .env.example .env            # add at least one vendor key, or MODELGATE_VENDORS=mock
npm run build
npm test && npm run smoke       # 130 tests, then an end-to-end MCP check with no keys needed

npx turbo run dev --filter=@modelgate/api --filter=@modelgate/web
# API on http://localhost:3001 (PGlite in .modelgate/pglite), web on http://localhost:3000
```

**In Claude Code**, as a plugin:

```
/plugin marketplace add abdllahx/modelgate
/plugin install modelgate@abdllahx
```

The first start installs only the MCP server's workspace and builds it (no Next.js). Then ask Claude to "extract the receipts in ./receipts", or run `/modelgate:extract ./receipts/*.jpg` and `/modelgate:status`.

**Deploy:**
- **API:** Render, "New > Blueprint" on this repo. `render.yaml` creates the service and a Postgres database, generates `MODELGATE_API_TOKEN`, and prompts for vendor keys.
- **Web:** Vercel, importing the repo with root directory `apps/web`. Set `MODELGATE_API_URL` and `MODELGATE_API_TOKEN`; the token is only read in server code.

## Surfaces

| | Endpoints / tools |
|---|---|
| MCP | `extract_receipt` (validated receipt plus vendor, model, cost, latency, prompt version, warnings, attempt trace), `get_status`, `get_report` |
| API | `POST /v1/extract` → 200, or 402 budget spent, 422 not an image, 502 every vendor failed (with attempts), 503 no vendors. `GET /v1/status`, `GET /v1/report?period=YYYY-MM`, `GET /healthz`. Bearer auth on `/v1`; required in production |
| Web | `/` uploads through a server action to the API; `/usage` shows budget, success, fallback and silent-failure rates, cost per extraction, latency and per-route breaker state |

With `DATABASE_URL` set, the API and every MCP server share one Postgres ledger: spend is added with an atomic `INSERT ... ON CONFLICT DO UPDATE`, and the 80% budget warning is claimed by exactly one process. Without it, the MCP server keeps a local file ledger.

## Failure handling

| Failure | Detection | Response |
|---|---|---|
| Rate limit, 5xx, overload | SDK typed errors (429, ≥500) | Retry the same vendor with jittered exponential backoff, honouring `Retry-After` |
| Hung request | Router-owned `AbortController` timeout | Counted as a timeout, retried, then fallback |
| Exhausted credits or quota | OpenAI `insufficient_quota`, Anthropic credit-balance 400 | No retry. Circuit opens for 15 min and an alert fires |
| Bad key, bad request | 401/403/400 | No retry, next vendor |
| Refusal | `stop_reason: "refusal"`, OpenAI refusal parts, Gemini block reasons | Silent failure, next vendor. Claude Opus/Sonnet also get server-side `fallbacks: "default"` |
| Truncated output | `max_tokens` / `incomplete` / `MAX_TOKENS` | Silent failure, next vendor |
| Not JSON, wrong shape, extra fields | `JSON.parse`, strict Zod schema | Silent failure, next vendor |
| Empty or invented receipt | Blank merchant, non-ISO date, no items, zero total | Silent failure, next vendor |
| Impossible numbers | `subtotal + tax ≠ total` | Silent failure. Item sum ≠ subtotal is a warning |
| Repeatedly failing route | 3 consecutive failures per `vendor:model` | Circuit opens for 60 s; requests skip it instantly |
| Budget spent | Ledger checked before every call | Hard stop with "do not retry". The plugin's PreToolUse hook blocks the call even earlier |

SDK-level retries are disabled in every client so the router owns them and the attempt trace reflects what actually happened. Silent failures move to the next vendor without a retry: resending the same image to the same model rarely fixes a refusal or a schema miss, and it doubles the spend.

## Evaluation

`npm run eval` runs each candidate alone with production settings on a labeled dataset, then the full routing chain, and writes [`EVAL.md`](EVAL.md) and `packages/eval/results/latest.json` (including every miss, by file, difficulty and field).

- **Dataset**: 28 synthetic receipts from `packages/eval/src/generate-dataset.ts` (seeded, reproducible) in USD, EUR and GBP, 4 at each of seven difficulty levels: clean, faded ink, rotated, speckled paper, small low-quality JPEG, faded thermal paper, and skewed (sheared as if photographed at an angle, so the price column drifts away from its rows). Content traps test reading rather than OCR: dates printed in regional formats, including day/month-ambiguous ones (`04.03.2026`) that only the currency resolves, and CASH and CHANGE amounts printed right under TOTAL.
- **Metrics**: field accuracy over 7 fields, exact-match rate, valid-output rate, silent failures caught, p50/p95 latency, cost per document and per 1k documents, by difficulty and by field.
- **Vendor selection**: the recommended primary is the cheapest candidate within one accuracy point of the best, among candidates with at least 90% valid output. The rest follow as fallbacks, with the rationale written to `EVAL.md`.
- **Cost guard**: `--max-usd` caps every run (default $2) in its own budget, separate from production. A run cut short by the cap is marked incomplete, and the gate refuses it.
- **Regression gate**: CI re-runs the eval when prompts, providers or validation change. `npm run eval:gate` fails the pull request on a drop of more than 2 points of accuracy or 5 points of valid output, or a cost increase above 25%.

```bash
npm run eval -- --candidates anthropic,openai:gpt-5.4-mini,gemini:gemini-3.8-flash --max-usd 3
npm run eval:gate
```

**Without an API key**, `claude-code[:model]` candidates run the same extraction through the Claude Agent SDK on a local Claude Code login. Their accuracy is comparable to API runs; their cost and latency are not, because the Claude Code harness adds context and a process start to every call. They are reported as references and left out of the routing recommendation.

Current results ([`EVAL.md`](EVAL.md)): Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 each extracted all 28 receipts exactly when run alone. In the routed run, one skewed receipt came back with a wrong line item that still passed validation, in two separate runs, which shows run-to-run variance on the hardest case. Matching Opus's accuracy with Haiku would cut list-price cost per receipt by about 40x, which is the decision an API-key run of this eval exists to confirm.

## Testing

| Layer | Command | Needs |
|---|---|---|
| Unit and integration: router, validation, budget, breaker, pricing, MCP tools, Express API status codes and auth, Postgres stores (real migrations on PGlite, concurrent increments, restarts), Next.js server action and usage page against a live API, hooks, plugin structure | `npm test` (130 tests) | nothing |
| SDK contracts: Anthropic, OpenAI and Gemini SDKs against a local server replaying each vendor's wire format | included in `npm test` | nothing |
| Shipped artefact: `bin/modelgate.mjs` over stdio, first-run install and build, MCP handshake, extraction | `npm run smoke` (`SMOKE_ROOT=<fresh clone>` tests a cold install) | nothing |
| Real model quality: the full dataset through Claude | `npm run eval -- --candidates claude-code:...` | Claude Code login |
| Plugin inside a real Claude agent: plugin and MCP load, tool discovery, real tool names matching hook matchers, PostToolUse logging, PreToolUse budget block, agent explains the block | `npm run test:agent` | Claude Code login |
| Live vendor APIs with metered cost | `npm run eval -- --max-usd 3` | API keys |

## Cost model

Each response's token usage (input including image tokens; output including reasoning tokens) is priced from `packages/core/src/pricing.ts`. Prices are list prices verified on 2026-10-15 against each vendor's pricing page. Unknown models are charged at the most expensive known rate and raise an alert, so the budget can overestimate spend but never undercount it. Spend accumulates per calendar month: an alert fires at 80% (configurable) to stderr and an optional Slack-compatible webhook, and calls stop at 100%.

## Claude Code tooling

**For plugin users** (`.claude-plugin/`, `.mcp.json`, `skills/`, `commands/`, `hooks/`, `bin/`)

- `extract-receipts` skill: when to call the tool, how to read warnings, fallbacks and errors, and when to stop (budget exhausted).
- `/modelgate:extract` and `/modelgate:status` commands.
- `budget-guard` PreToolUse hook: blocks `extract_receipt` before the call once the month's budget is spent.
- `log-adoption` PostToolUse hook: one line per tool call, feeding the adoption numbers in `get_report`.

**For contributors** (`CLAUDE.md`, `.claude/`)

- `CLAUDE.md`: the agent rules file. Workspaces, commands, and the invariants reviewers enforce.
- `add-vendor` and `prompt-change` skills: step-by-step procedures for the two most common changes, including when to ask before spending money on an eval.
- `/eval-vendors` and `/ship` commands.
- `protect-files` PreToolUse hook: blocks hand edits to `.env`, the eval baseline, generated data, results and migrations.
- `typecheck` PostToolUse hook: typechecks the edited file's workspace and returns errors to the agent in the same turn.
- `.coderabbit.yaml`: AI code review instructions per path, mirroring `CLAUDE.md`.
- `npm run check:plugin`: validates manifests, hook script paths, and skill and command front matter in CI.

## Layout

```
packages/core     router, providers (anthropic, openai, gemini, mock), validation, budget, pricing, alerts, prompts/
packages/db       Drizzle schema, migrations/, Postgres budget ledger and usage log, PGlite fallback
packages/eval     dataset generator + dataset/, eval runner, scorer, gate, Claude Code reference provider, agent test
apps/mcp          MCP server (started by bin/modelgate.mjs)
apps/api          Express API (render.yaml)
apps/web          Next.js app (Vercel)
skills/ commands/ hooks/ .claude-plugin/ .mcp.json   the Claude Code plugin
.claude/ CLAUDE.md                                    contributor tooling
```

## Configuration

See [`.env.example`](.env.example). The main settings are `MODELGATE_VENDORS` (routing order with optional `vendor:model` overrides), `MODELGATE_BUDGET_USD`, `MODELGATE_BUDGET_WARN_AT`, `MODELGATE_ALERT_WEBHOOK`, `DATABASE_URL`, `MODELGATE_API_TOKEN` and `MODELGATE_API_URL`.

Defaults: `claude-opus-5-5` (effort `medium`), `gpt-5-mini`, `gemini-2.5-flash`. Any model with a price row can be evaluated with `--candidates vendor:model`.

## Limitations

- The circuit breaker is per process. Several instances share the budget through Postgres but learn about a failing vendor separately.
- The plugin's budget-guard hook reads the local file ledger. With `DATABASE_URL`, the server still enforces the shared limit, but the early hook check does not see it.
- The dataset is synthetic. Current Claude models already read all of it, so it now works mainly as a regression and vendor-comparison check. Real receipts (crumples, handwriting, glare, multi-page invoices) belong in it before production use, and repeated runs per document would quantify the run-to-run variance seen on skewed receipts.
- A wrong line item with correct totals passes validation as a warning, not a failure. Stricter item checks would trade false rejections for fewer silent errors.

## How this was built

I built ModelGate with Claude Code as my implementation assistant. I set the scope and requirements and made the product and stack decisions:
- one small project focused on production AI reliability and agent tooling, not a broad toolkit;
- Turborepo, with Next.js on Vercel, Express on Render and Drizzle on Postgres;
- testing against real Claude models through the Claude Agent SDK when no API key was available;
- how and where it is published.

Claude Code proposed designs for my approval, wrote most of the code, and ran the checks. I reviewed and approved the plan at each stage, and pushed for verification beyond unit tests. That push is what produced the SDK contract tests, the cold-install smoke test, the real-agent plugin test and the harder eval dataset, and those surfaced the bugs listed in the commit history and limitations above.

Every number in this README comes from a test or an eval run in this repo.

## License

MIT
