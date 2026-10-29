import { join } from "node:path";
import type { SkillsDelivery } from "../../shared/types";
import type { Catalog } from "./catalog";
import { bodyOf } from "./catalog";
import { qualifySkillCalls } from "./plugin";

/**
 * The prompt for a turn. With one or more skills picked from the / menu --
 * user- or model-invoked -- each skill's body goes in first, the harness does
 * what Claude Code does for a typed /command, followed by whatever the user
 * typed after them. The body's own relative links resolve against `base`.
 * `delivery` picks the Skill-call prefix: a bare string is treated as one, for
 * older callers.
 */
export function composePrompt(
  catalog: Catalog,
  text: string,
  skillNames?: string | readonly string[],
  delivery: SkillsDelivery | string = { mode: "plugin", prefix: "harness-skills:" },
): string {
  const names = typeof skillNames === "string" ? [skillNames] : [...new Set(skillNames ?? [])];
  if (names.length === 0) return text;
  // Every name must resolve before anything is built; an unknown one is fatal.
  const skills = names.map((name) => {
    const skill = catalog.byName.get(name);
    if (!skill) throw new Error(`unknown skill: ${name}`);
    return { name, skill };
  });
  const d: SkillsDelivery = typeof delivery === "string" ? { mode: "plugin", prefix: delivery } : delivery;
  const prefix = d.mode === "none" ? "" : d.prefix ?? "";
  const known = new Set(catalog.modelSkills.map((s) => s.name));
  const blocks = skills.map(({ name, skill }) => {
    const body = qualifySkillCalls(bodyOf(catalog, name), known, prefix);
    const base = skill.dir ?? join(catalog.root.skillsDir, name);
    return [
      `<skill name="${name}" base="${base}">`,
      `The user ran /${name}. Follow these instructions. Relative links in them resolve against the base directory above.`,
      "",
      body.trimEnd(),
      "</skill>",
    ].join("\n");
  });
  const args = text.trim();
  return [blocks.join("\n\n"), "", args ? `Arguments: ${args}` : "(no arguments)"].join("\n");
}
