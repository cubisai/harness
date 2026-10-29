import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The skill folders (holding a SKILL.md) in these directories, by folder name. Symlinked skills count, as the agents follow them. */
export function skillFolders(dirs: string[]): string[] {
  return dirs.flatMap((dir) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => {
      try {
        return statSync(join(dir, name, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    });
  });
}

/**
 * Skills claude.ai syncs into `~/.claude/skills/synced/<account>/<name>`, minus any name
 * that is also a real skill in `others`. They need claude.ai's own tools (connectors,
 * computer use, Chrome), and CubiQ ships its own Office ones, so no agent here should list them.
 */
export function claudeAiSyncedSkills(claudeSkills: string, others: string[]): string[] {
  const synced = join(claudeSkills, "synced");
  let accounts: string[];
  try {
    accounts = readdirSync(synced);
  } catch {
    return [];
  }
  const real = new Set(skillFolders([claudeSkills, ...others]));
  return [...new Set(skillFolders(accounts.map((a) => join(synced, a))))].filter((name) => !real.has(name)).sort();
}
