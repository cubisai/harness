import { z } from "zod";
import type { SkillEntry } from "../../shared/types";
import type { HarnessTool } from "../agents/types";
import { bm25Rank } from "../search/bm25";
import { readSkillBodyAt } from "./catalog";

const MAX_DESCRIPTION = 160;

/** Past either limit the skill tool stops listing every description and becomes a searchable, names-only index. */
export const SKILL_INDEX_THRESHOLD = { skills: 40, chars: 6000 };

/** Matches a `query` search returns. */
const SEARCH_LIMIT = 8;

/** Names a no-match answer lists before the ellipsis. */
const NO_MATCH_NAMES = 20;

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/** One `- name: description` line, the description clipped as the full listing clips it. */
function line(s: SkillEntry): string {
  const description = s.description.length > MAX_DESCRIPTION ? `${s.description.slice(0, MAX_DESCRIPTION)}…` : s.description;
  return `- ${s.name}: ${description}`;
}

/**
 * The `skill` tool: agents that get skills over MCP list them in the tool's
 * description and load one by name. Its `base` is the skill's own folder, so
 * relative links in the body resolve.
 *
 * The catalog (list, mode and description) is snapshotted once, when the tool is
 * built: search and the index-mode decision never see skills added mid-session.
 * A `name` load still checks the live list first and falls back to the snapshot,
 * so a skill added mid-session can be loaded by exact name.
 *
 * While the catalog has at most SKILL_INDEX_THRESHOLD.skills skills and its
 * listing fits in the char budget, the description is the full
 * `- name: description` listing. Past either limit the description is names
 * only and the tool takes a `query` to search.
 */
export function skillTool(skills: () => SkillEntry[]): HarnessTool {
  const list = [...skills()].sort((a, b) => a.name.localeCompare(b.name));
  const lines = list.map(line);
  const legacyDescription = lines.length
    ? `Load a skill: returns its instructions and its folder (relative links resolve against it). Use it when the task matches one of these skills:\n${lines.join("\n")}`
    : "No skills are installed.";

  // Live first, snapshot second: a skill added after the tool was built still loads.
  const load = async (name: string): Promise<{ text: string; isError?: boolean }> => {
    const found = skills().find((s) => s.name === name) ?? list.find((s) => s.name === name);
    if (!found) {
      const names = skills().map((s) => s.name);
      return { text: names.length ? `Unknown skill "${name}". Available: ${names.join(", ")}.` : `Unknown skill "${name}". No skills are installed.`, isError: true };
    }
    const base = found.dir ?? "";
    return { text: `<skill name="${name}" base="${base}">\n${readSkillBodyAt(base)}\n</skill>` };
  };

  if (list.length <= SKILL_INDEX_THRESHOLD.skills && legacyDescription.length <= SKILL_INDEX_THRESHOLD.chars) {
    return define({
      name: "skill",
      description: legacyDescription,
      autoAllow: true,
      effect: "read",
      input: { name: z.string().describe("Skill name from the list") },
      run: async ({ name }) => load(name),
    });
  }

  const names = list.map((s) => s.name).join(", ");
  const search = (query: string): { text: string } => {
    const ranked = bm25Rank(list, (s) => `${s.name} ${s.name} ${s.description}`, query, SEARCH_LIMIT, (a, b) => a.name.localeCompare(b.name));
    if (!ranked.length) {
      return { text: `No skill matched "${query}". Try other words; skills: ${list.slice(0, NO_MATCH_NAMES).map((s) => s.name).join(", ")}…` };
    }
    return { text: [...ranked.map((r) => line(r.item)), "Load one with name."].join("\n") };
  };

  return define({
    name: "skill",
    description: `${list.length} skills are installed. Call skill with query to search them, or name to load one.\n${names}`,
    autoAllow: true,
    effect: "read",
    input: {
      name: z.string().optional().describe("Exact skill name to load"),
      query: z.string().optional().describe("Words describing the task, to search the skills"),
    },
    run: async ({ name, query }) => {
      if (name) {
        const out = await load(name);
        return out.isError ? { ...out, text: `${out.text} Try query to search.` } : out;
      }
      if (query) return search(query);
      return { text: "Pass name or query.", isError: true };
    },
  });
}
