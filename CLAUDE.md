# ModelGate

Routes receipt extraction across vision LLMs (Claude, GPT, Gemini) with retries, fallback, silent-failure detection and a monthly budget. Turborepo monorepo, TypeScript, ESM, Node 22+.

## Workspaces

- `packages/core`: router, providers, validation, budget, pricing, alerts, prompts. No I/O beyond vendor calls and local files.
- `packages/db`: Drizzle schema, migrations, and Postgres implementations of the budget ledger and usage log. PGlite when there is no `DATABASE_URL`.
- `packages/eval`: dataset generator, eval runner, scorer, regression gate, Claude Code reference provider.
- `apps/mcp`: MCP server and the Claude Code plugin's runtime. Started by `bin/modelgate.mjs`.
- `apps/api`: Express API (deployed on Render via `render.yaml`).
- `apps/web`: Next.js app (deployed on Vercel), which calls the API from server code only.
- Repo root: plugin files (`.claude-plugin/`, `.mcp.json`, `skills/`, `commands/`, `hooks/`, `bin/`) and contributor tooling (`.claude/`).

## Commands

- `npm run typecheck` / `npm test` / `npm run build`: all must pass before any commit (`npm test` runs every workspace's tests from the root).
- `npm run check:plugin`: validates plugin manifests, hooks, skills and commands.
- `npm run smoke`: starts the shipped MCP server over stdio with the mock vendor. Free.
- `npm run eval -- --candidates <specs> --max-usd <cap>`: spends real money. Ask before running it, and always pass `--max-usd`.
- `npm run eval -- --candidates mock --markdown none`: free offline eval.
- `npm run eval -- --candidates claude-code:<model>` and `npm run test:agent`: use the local Claude Code login (no API key) and count against the user's subscription. Ask first.
- `npm run eval:gate`: compares `packages/eval/results/latest.json` to `packages/eval/baseline.json`.
- `npm run db:generate`: generates a migration after a schema change.
- `npx turbo run dev --filter=@modelgate/api --filter=@modelgate/web`: API on :3001 and web on :3000 locally.

## Rules

- Never write to stdout from MCP server code. stdout is the MCP protocol; log to stderr.
- Providers construct SDK clients with retries disabled. The router owns retries, and SDK retries would hide attempts and latency from the measurements.
- Providers return raw text. Do not parse or validate JSON inside a provider; `validateExtraction` does it for every vendor identically.
- Use each SDK's typed error classes to classify failures. Add a string match only where the vendor gives no other signal, with a comment saying so.
- Storage goes through `BudgetGuard` and `UsageSink`. Do not import `@modelgate/db` from `packages/core`.
- `MODELGATE_API_TOKEN` is read only in server code in `apps/web`, never in a `"use client"` file.
- A prompt edit bumps `version` in its front matter and comes with an eval run in the same change. Use the prompt-change skill.
- `packages/eval/baseline.json` changes only through `npm run eval:baseline`, and migrations only through `npm run db:generate`. A hook blocks hand edits.
- A new or changed price row updates the verification date and source in `packages/core/src/pricing.ts`.
- New behaviour gets a test in its workspace. Router behaviour is tested through `scripted()` providers in `packages/core/test/helpers.ts`, never with live APIs.
- Keep error messages actionable for an agent or API client: say what happened and what to do next.
