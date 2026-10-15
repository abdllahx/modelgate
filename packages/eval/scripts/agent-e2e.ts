/**
 * Plugin test inside a real Claude agent, through the Claude Agent SDK and a
 * local Claude Code login (no API key). ModelGate loads as a plugin with the
 * offline mock vendor, and the checks cover what unit tests cannot: that the
 * plugin's MCP server, skill and commands load, that Claude discovers and calls
 * the tool, and that the plugin's hooks fire on the real tool names.
 *
 *   npm run test:agent
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATASET = join(ROOT, "packages/eval/dataset");
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_.*)$/;
const labels = JSON.parse(readFileSync(join(DATASET, "labels.json"), "utf8")) as Array<{
  file: string;
  receipt: { merchant: string; total: number };
}>;

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

interface Run {
  init?: Extract<SDKMessage, { type: "system"; subtype: "init" }>;
  toolCalls: string[];
  toolResults: string[];
  answer: string;
}

async function run(prompt: string, home: string): Promise<Run> {
  const out: Run = { toolCalls: [], toolResults: [], answer: "" };
  for await (const message of query({
    prompt,
    options: {
      model: "claude-haiku-5-5",
      cwd: ROOT,
      plugins: [{ type: "local", path: ROOT }],
      settingSources: [], // only the plugin: no user settings, project .mcp.json or CLAUDE.md
      tools: [], // no built-in tools, so the agent has to go through ModelGate
      maxTurns: 6,
      persistSession: false,
      permissionMode: "default",
      canUseTool: async (name) =>
        /modelgate/.test(name) ? { behavior: "allow" } : { behavior: "deny", message: "Only ModelGate tools are allowed in this test." },
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !SESSION_VARS.test(key))),
        MODELGATE_VENDORS: "mock",
        MODELGATE_HOME: home,
        MODELGATE_BUDGET_USD: "5",
      },
    },
  })) {
    if (message.type === "system" && message.subtype === "init") out.init = message;
    if (message.type === "assistant") {
      for (const block of message.message.content) if (block.type === "tool_use") out.toolCalls.push(block.name);
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === "object" && block.type === "tool_result") out.toolResults.push(JSON.stringify(block.content));
      }
    }
    if (message.type === "result" && message.subtype === "success") out.answer = message.result;
  }
  return out;
}

const sample = labels[0]!;
const image = join(DATASET, sample.file);

// 1. Happy path: plugin loads, Claude calls the tool, hooks and logs record it.
const home = mkdtempSync(join(tmpdir(), "modelgate-agent-"));
const first = await run(`Extract the receipt at ${image} and reply with only the merchant name and the total.`, home);

const tools = first.init?.tools ?? [];
console.log(`plugins: ${JSON.stringify(first.init?.plugins.map((p) => p.name))}, mcp: ${JSON.stringify(first.init?.mcp_servers)}`);
console.log(`modelgate tools: ${tools.filter((t) => /modelgate/.test(t)).join(", ")}`);
console.log(`skills: ${first.init?.skills.filter((s) => /receipt|modelgate/.test(s)).join(", ")}; commands: ${first.init?.slash_commands.filter((c) => /modelgate/.test(c)).join(", ")}`);

check(Boolean(first.init?.plugins.some((p) => p.name === "modelgate")), "plugin loads");
check(Boolean(first.init?.mcp_servers.some((s) => /modelgate/.test(s.name) && s.status === "connected")), "MCP server connects through bin/modelgate.mjs");
const extractTool = tools.find((t) => /modelgate.*__extract_receipt$/.test(t));
check(Boolean(extractTool) && /^mcp__.*modelgate.*__extract_receipt$/.test(extractTool ?? ""), `tool name ${extractTool} matches the hook matcher mcp__.*modelgate.*__extract_receipt`);
check(Boolean(first.init?.skills.some((s) => /extract-receipts/.test(s))), "extract-receipts skill is available");
check(Boolean(first.init?.slash_commands.some((c) => /modelgate:extract/.test(c))), "/modelgate:extract command is available");
check(first.toolCalls.some((t) => t === extractTool), `Claude called extract_receipt (calls: ${first.toolCalls.join(", ") || "none"})`);
check(first.answer.toLowerCase().includes(sample.receipt.merchant.toLowerCase()) && first.answer.includes(String(sample.receipt.total)), `answer has the right merchant and total: "${first.answer.trim()}"`);
check(existsSync(join(home, "usage.jsonl")), "server wrote the usage log");
const adoption = existsSync(join(home, "adoption.jsonl")) ? readFileSync(join(home, "adoption.jsonl"), "utf8") : "";
check(adoption.includes("extract_receipt"), "PostToolUse hook logged adoption");

// 2. Budget guard: with the month's ledger at the limit, the PreToolUse hook blocks the call.
const period = new Date().toISOString().slice(0, 7);
writeFileSync(join(home, "ledger.json"), JSON.stringify({ period, spentUsd: 5.5, limitUsd: 5, warned: true }));
const usageBefore = readFileSync(join(home, "usage.jsonl"), "utf8").trim().split("\n").length;
const second = await run(`Extract the receipt at ${image}. If it cannot be extracted, say why in one sentence.`, home);
const usageAfter = readFileSync(join(home, "usage.jsonl"), "utf8").trim().split("\n").length;

check(second.toolResults.some((r) => /budget exhausted/i.test(r)), "PreToolUse hook blocked extract_receipt with the budget message");
check(usageAfter === usageBefore, "no extraction reached the server after the block");
check(/budget/i.test(second.answer), `agent explained the block: "${second.answer.trim()}"`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nagent end-to-end passed");
