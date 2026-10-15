---
name: prompt-change
description: Change an extraction prompt in packages/core/prompts/ safely, with a version bump, an eval against the baseline, and a regression check. Use for any edit to packages/core/prompts/*.md, including wording tweaks, new rules, or fixes for extraction mistakes.
---

# Changing a prompt

Prompts are code here: versioned, evaluated, and gated in CI. A small wording change can move accuracy by several points on one vendor while leaving another unchanged, so every change is measured.

## Steps

1. **Find the failure first.** Open `packages/eval/results/latest.json` (or run the eval). Each candidate's `misses` lists the files, difficulty levels and wrong fields; name the pattern with two or three example files. Write down what the change is meant to fix.
2. **Edit `packages/core/prompts/<name>.md`** and bump `version` in the front matter by one. Keep rules short and specific. Do not add examples taken from `packages/eval/dataset`, because the eval would then measure memorisation.
3. **Run the checks:** `npm run typecheck && npm test`.
4. **Evaluate (costs money: ask first):**
   ```bash
   npm run eval -- --candidates <vendors in MODELGATE_VENDORS> --max-usd 2
   npm run eval:gate
   ```
5. **Decide.** Keep the change only if the targeted fields improve and the gate passes for every vendor. If one vendor regresses, report it and do not tune the prompt for a single vendor without asking.
6. **Promote the baseline** with `npm run eval:baseline`, in the same change as the prompt edit, so reviewers see both together.
7. **Summarise for the pull request:** old and new version, field accuracy and cost per 1k documents before and after for each vendor, and anything that got worse.

## Never

- Edit `packages/eval/baseline.json` by hand (a hook blocks it).
- Change a prompt without bumping its version: usage logs and eval results would attribute the new behaviour to the old prompt.
