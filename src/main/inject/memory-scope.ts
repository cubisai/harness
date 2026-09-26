// The duplication trap (plan Ch. 10 §10.2): agents load their own conventions,
// so the harness never injects CLAUDE.md / AGENTS.md content or a skill body.
// What it can do is say when a project would load the same conventions twice.

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Warnings about conventions files an agent would load twice in this project.
 * Both files can legitimately coexist (a Claude + Codex repo), so this is a
 * notice, never a block.
 */
export function memoryScopeCheck(projectPath: string): string[] {
  if (!existsSync(join(projectPath, "CLAUDE.md")) || !existsSync(join(projectPath, "AGENTS.md"))) return [];
  return [
    "This project has both CLAUDE.md and AGENTS.md. Claude loads CLAUDE.md, Codex loads AGENTS.md, and OpenCode reads AGENTS.md and falls back to CLAUDE.md, so if one imports the other, the same conventions load twice and cost tokens on every turn.",
  ];
}
