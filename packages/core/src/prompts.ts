import { readFileSync } from "node:fs";

export interface Prompt {
  id: string;
  version: number;
  text: string;
}

/**
 * Prompts live in prompts/*.md under version control, with the version in
 * front matter. The version is stamped on every usage record and eval result,
 * so a quality or cost change can always be traced to the prompt that caused it.
 */
export function parsePrompt(raw: string): Prompt {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("Prompt file is missing front matter");
  const meta = Object.fromEntries(
    match[1]!.split("\n").map((line) => {
      const [key = "", ...value] = line.split(":");
      return [key.trim(), value.join(":").trim()];
    }),
  );
  const version = Number(meta.version);
  if (!meta.id || !Number.isInteger(version) || version < 1) {
    throw new Error("Prompt front matter needs an id and a positive integer version");
  }
  return { id: meta.id, version, text: match[2]!.trim() };
}

export function loadPrompt(name = "extract-receipt"): Prompt {
  // Resolves from both src/ (tsx) and dist/ (compiled): each sits one level below the repo root.
  return parsePrompt(readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8"));
}
