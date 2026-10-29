// Project instruction files: the "AGENTS.md" / "CLAUDE.md" a project keeps at
// its root, read once per session and folded into the system prompt. A file
// that duplicates an earlier one (a copy or symlink) is dropped, and long files
// are cut so a single project can't crowd out the rest of the context.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export const CONTEXT_FILE_CAP = 12_000;

/** Read the project's instruction files, in order, deduped and capped. */
export function contextFiles(cwd: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(cwd, name);
    let text: string;
    try {
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      text = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (text.length > CONTEXT_FILE_CAP) text = text.slice(0, CONTEXT_FILE_CAP) + "\n…[cut]";
    out.push({ name, text });
  }
  return out;
}
