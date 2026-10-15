import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPlugin } from "../scripts/check-plugin.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function runHook(script: string, input: object, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("node", [join(ROOT, script)], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("plugin structure", () => {
  it("passes check:plugin", () => {
    expect(checkPlugin()).toEqual([]);
  });
});

describe("budget-guard hook", () => {
  const home = mkdtempSync(join(tmpdir(), "modelgate-hook-"));
  const period = new Date().toISOString().slice(0, 7);
  const ledger = (spentUsd: number) =>
    writeFileSync(join(home, "ledger.json"), JSON.stringify({ period, spentUsd, limitUsd: 5, warned: true }));

  it("blocks extraction with exit 2 once the ledger is at the limit", () => {
    ledger(5.01);
    const result = runHook("hooks/budget-guard.mjs", { tool_name: "mcp__modelgate__extract_receipt" }, { MODELGATE_HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/budget exhausted.*Do not retry/);
  });

  it("allows extraction under the limit and when no ledger exists", () => {
    ledger(1);
    expect(runHook("hooks/budget-guard.mjs", {}, { MODELGATE_HOME: home }).status).toBe(0);
    expect(runHook("hooks/budget-guard.mjs", {}, { MODELGATE_HOME: join(home, "missing") }).status).toBe(0);
  });
});

describe("log-adoption hook", () => {
  it("appends one record per tool call", () => {
    const home = mkdtempSync(join(tmpdir(), "modelgate-hook-"));
    runHook("hooks/log-adoption.mjs", { session_id: "s1", tool_name: "mcp__modelgate__extract_receipt", tool_response: { isError: true } }, { MODELGATE_HOME: home });
    const [line] = readFileSync(join(home, "adoption.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(line!)).toMatchObject({ sessionId: "s1", tool: "mcp__modelgate__extract_receipt", ok: false });
  });
});

describe("protect-files hook", () => {
  const project = mkdtempSync(join(tmpdir(), "modelgate-proj-"));
  mkdirSync(join(project, "eval"), { recursive: true });
  const edit = (path: string) =>
    runHook(".claude/hooks/protect-files.mjs", { tool_name: "Edit", tool_input: { file_path: join(project, path) } }, { CLAUDE_PROJECT_DIR: project });

  it.each([
    ".env",
    ".env.local",
    "packages/eval/baseline.json",
    "packages/eval/dataset/labels.json",
    "packages/eval/results/latest.json",
    "packages/db/migrations/0000_init.sql",
  ])("blocks hand edits to %s", (path) => {
    const result = edit(path);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^Blocked:/);
  });

  it.each(["packages/core/src/router.ts", "packages/core/prompts/extract-receipt.md", "packages/db/src/schema.ts", ".env.example"])("allows %s", (path) => {
    expect(edit(path).status).toBe(0);
  });
});
