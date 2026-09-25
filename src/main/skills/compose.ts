import { join } from "node:path";
import type { Catalog } from "./catalog";
import { readSkillBody } from "./catalog";
import { qualifySkillCalls } from "./plugin";

/**
 * The prompt for a turn. With a user-invoked skill picked from the / menu,
 * the skill's body goes in first -- the harness does what Claude Code does
 * for a typed /command -- followed by whatever the user typed after it.
 * The body's own relative links resolve against `base`.
 */
export function composePrompt(catalog: Catalog, text: string, skillName?: string, skillCallPrefix = "skilled:"): string {
  if (!skillName) return text;
  const skill = catalog.byName.get(skillName);
  if (!skill) throw new Error(`unknown skill: ${skillName}`);
  if (skill.invocation !== "user") {
    throw new Error(`${skillName} is model-invoked; the agent loads it on its own`);
  }
  const known = new Set(catalog.modelSkills.map((s) => s.name));
  const body = qualifySkillCalls(readSkillBody(catalog.root, skillName), known, skillCallPrefix);
  const base = join(catalog.root.skillsDir, skillName);
  const args = text.trim();
  return [
    `<skill name="${skillName}" base="${base}">`,
    `The user ran /${skillName}. Follow these instructions. Relative links in them resolve against the base directory above.`,
    "",
    body.trimEnd(),
    "</skill>",
    "",
    args ? `Arguments: ${args}` : "(no arguments)",
  ].join("\n");
}
