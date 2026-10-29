import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SkillEntry, SkillOrigin } from "../../shared/types";

export interface ParsedSkill {
  name?: string;
  description?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  argumentHint?: string;
  /** `mode: design` in the frontmatter: delivered to design threads only. */
  mode?: "design";
  /** Everything after the closing `---`. */
  body: string;
}

/** Strip one pair of surrounding single or double quotes. */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The small subset of YAML frontmatter a SKILL.md uses: scalar `key: value`
 * lines. `true`/`false` become booleans, surrounding quotes are stripped, and
 * anything the harness doesn't know is ignored.
 */
export function parseSkillMd(text: string): ParsedSkill {
  const lines = text.split(/\r?\n/);
  const empty: ParsedSkill = { disableModelInvocation: false, userInvocable: true, body: text };
  if (lines[0]?.trim() !== "---") return empty;
  const end = lines.indexOf("---", 1);
  if (end === -1) return empty;

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), unquote(match[2]!.trim()));
  }
  const parsed: ParsedSkill = {
    disableModelInvocation: fields.get("disable-model-invocation") === "true",
    userInvocable: fields.get("user-invocable") !== "false",
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
  };
  const name = fields.get("name");
  if (name) parsed.name = name;
  const description = fields.get("description");
  if (description) parsed.description = description;
  const argumentHint = fields.get("argument-hint");
  if (argumentHint) parsed.argumentHint = argumentHint;
  if (fields.get("mode") === "design") parsed.mode = "design";
  return parsed;
}

export interface SkillSource {
  origin: SkillOrigin;
  dir: string;
}

/**
 * Every `<name>/SKILL.md` under `source.dir`, as SkillEntries. A missing root
 * is no skills; one unreadable or frontmatter-less skill is skipped, never
 * allowed to take the whole discovery down.
 */
export function discoverSkills(source: SkillSource): SkillEntry[] {
  if (!source.dir || !existsSync(source.dir)) return [];
  let folders: string[];
  try {
    folders = readdirSync(source.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const skills: SkillEntry[] = [];
  for (const folder of folders) {
    const dir = join(source.dir, folder);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf-8");
      const parsed = parseSkillMd(text);
      const description = parsed.description?.trim();
      if (!description) continue;
      const name = parsed.name?.trim() || folder;
      skills.push({
        name,
        description,
        invocation: parsed.disableModelInvocation ? "user" : "model",
        ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
        ...(parsed.mode ? { mode: parsed.mode } : {}),
        calls: [],
        files: [],
        sha256: createHash("sha256").update(text).digest("hex"),
        origin: source.origin,
        dir,
        userInvocable: parsed.userInvocable,
      });
    } catch {
      // One bad skill doesn't stop the rest.
    }
  }
  return skills;
}
