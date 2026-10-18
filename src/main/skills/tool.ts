import { z } from "zod";
import type { SkillEntry } from "../../shared/types";
import type { HarnessTool } from "../agents/types";
import { readSkillBodyAt } from "./catalog";

const MAX_DESCRIPTION = 160;

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/**
 * The `skill` tool: agents that get skills over MCP list them in the tool's
 * description and load one by name. Its `base` is the skill's own folder, so
 * relative links in the body resolve.
 */
export function skillTool(skills: () => SkillEntry[]): HarnessTool {
  const list = [...skills()].sort((a, b) => a.name.localeCompare(b.name));
  const lines = list.map((s) => {
    const description = s.description.length > MAX_DESCRIPTION ? `${s.description.slice(0, MAX_DESCRIPTION)}…` : s.description;
    return `- ${s.name}: ${description}`;
  });
  const description = lines.length
    ? `Load a skill: returns its instructions and its folder (relative links resolve against it). Use it when the task matches one of these skills:\n${lines.join("\n")}`
    : "No skills are installed.";

  return define({
    name: "skill",
    description,
    autoAllow: true,
    effect: "read",
    input: { name: z.string().describe("Skill name from the list") },
    run: async ({ name }) => {
      const found = skills().find((s) => s.name === name);
      if (!found) {
        const names = skills().map((s) => s.name);
        return { text: names.length ? `Unknown skill "${name}". Available: ${names.join(", ")}.` : `Unknown skill "${name}". No skills are installed.`, isError: true };
      }
      const base = found.dir ?? "";
      return { text: `<skill name="${name}" base="${base}">\n${readSkillBodyAt(base)}\n</skill>` };
    },
  });
}
