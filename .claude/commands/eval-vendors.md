---
description: Run the vendor eval with a spending cap and recommend a routing order
argument-hint: [candidates, e.g. anthropic,openai:gpt-5.4-mini,gemini] [max USD]
allowed-tools: Bash(npm run eval:*), Bash(npm run dataset:*), Read
---

Run the ModelGate vendor evaluation.

1. Candidates are the first argument in `$ARGUMENTS`; if none were given, use the vendors configured in the environment. The spending cap is the second argument, or $2.
2. Tell the user the candidates, the number of receipts in `packages/eval/dataset/labels.json`, and the cap, then ask for confirmation before spending anything.
3. If `packages/eval/dataset/labels.json` is missing, run `npm run dataset` first.
4. Run `npm run eval -- --candidates <candidates> --max-usd <cap>`, then `npm run eval:gate`.
5. Report from `EVAL.md` (repo root): a short table (candidate, field accuracy, valid output, p95 latency, cost per 1k documents), the recommended `MODELGATE_VENDORS` order and why, the weakest field and difficulty level for the recommended primary, and the gate result.
