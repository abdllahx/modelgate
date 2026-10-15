---
description: Run every pre-merge check and draft the commit message
allowed-tools: Bash(npm run typecheck), Bash(npm test), Bash(npm run build), Bash(npm run check:plugin), Bash(npm run eval:gate), Bash(git status:*), Bash(git diff:*)
---

Prepare the current changes for review.

1. Run `npm run typecheck`, `npm test`, `npm run build` and `npm run check:plugin`. Stop and fix anything that fails.
2. Check `git diff` for changes under `packages/core/prompts/` or `packages/core/src/providers/`. If there are any and `packages/eval/results/latest.json` is older than those changes, say an eval is needed (do not run it; it costs money) and stop.
3. If `packages/eval/results/latest.json` exists, run `npm run eval:gate` and include the result.
4. If `packages/db/src/schema.ts` changed, check that `packages/db/migrations/` has a matching new migration (`npm run db:generate`).
5. Draft a commit message: an imperative subject of 50 characters or fewer, then a body explaining why. Include eval numbers when a prompt or provider changed. Do not commit.
