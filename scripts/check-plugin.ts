/**
 * Validates everything Claude Code loads from this repo, because a broken
 * manifest, hook path or skill front matter fails silently for plugin users.
 *
 *   npm run check:plugin
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readJson(path: string, problems: string[]): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;
  } catch (err) {
    problems.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function frontMatter(path: string): Record<string, string> | undefined {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(ROOT, path), "utf8"));
  if (!match) return undefined;
  return Object.fromEntries(
    match[1]!.split("\n").map((line) => {
      const [key = "", ...rest] = line.split(":");
      return [key.trim(), rest.join(":").trim()];
    }),
  );
}

/** Collects script paths a hook command runs, resolving the two root variables Claude Code provides. */
function hookScripts(config: unknown): string[] {
  const scripts: string[] = [];
  const hooks = (config as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks ?? {};
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const match = /"?\$\{?(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}?\/([^"\s]+)"?/.exec(hook.command ?? "");
        if (match) scripts.push(match[1]!);
      }
    }
  }
  return scripts;
}

export function checkPlugin(): string[] {
  const problems: string[] = [];

  const plugin = readJson(".claude-plugin/plugin.json", problems);
  if (plugin) {
    for (const field of ["name", "version", "description"]) {
      if (typeof plugin[field] !== "string" || !plugin[field]) problems.push(`plugin.json: missing "${field}"`);
    }
    const pkg = readJson("package.json", problems);
    if (pkg && pkg.version !== plugin.version) problems.push(`plugin.json version ${String(plugin.version)} differs from package.json ${String(pkg.version)}`);
  }

  const marketplace = readJson(".claude-plugin/marketplace.json", problems);
  const listed = (marketplace?.plugins as Array<{ name?: string }> | undefined) ?? [];
  if (marketplace && !listed.some((p) => p.name === plugin?.name)) problems.push("marketplace.json does not list the plugin");

  const mcp = readJson(".mcp.json", problems);
  if (mcp && !(mcp.mcpServers as Record<string, unknown> | undefined)?.modelgate) problems.push(".mcp.json: no modelgate server");
  if (!existsSync(join(ROOT, "bin/modelgate.mjs"))) problems.push("bin/modelgate.mjs is missing");

  for (const path of ["hooks/hooks.json", ".claude/settings.json"]) {
    const config = readJson(path, problems);
    for (const script of config ? hookScripts(config) : []) {
      if (!existsSync(join(ROOT, script))) problems.push(`${path}: hook script ${script} does not exist`);
    }
  }

  for (const dir of ["skills", ".claude/skills"]) {
    for (const name of existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : []) {
      const path = `${dir}/${name}/SKILL.md`;
      if (!existsSync(join(ROOT, path))) {
        problems.push(`${path} is missing`);
        continue;
      }
      const meta = frontMatter(path);
      if (!meta) problems.push(`${path}: no front matter`);
      else {
        if (meta.name !== name) problems.push(`${path}: name "${meta.name}" should match its folder "${name}"`);
        if (!meta.description || meta.description.length < 40) problems.push(`${path}: description is missing or too short to trigger reliably`);
      }
    }
  }

  for (const dir of ["commands", ".claude/commands"]) {
    for (const file of existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md")) : []) {
      if (!frontMatter(`${dir}/${file}`)?.description) problems.push(`${dir}/${file}: missing description front matter`);
    }
  }

  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkPlugin();
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log("✓ plugin manifest, MCP config, hooks, skills and commands are valid");
}
