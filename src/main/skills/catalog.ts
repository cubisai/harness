import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import type { SkillEntry } from "../../shared/types";

/**
 * A skills library root: `skills.json` plus the `skills/` directory beside it.
 */
export interface SkillsRoot {
  /** Directory holding skills.json. */
  dir: string;
  /** Directory holding one folder per skill. */
  skillsDir: string;
}

export function findSkillsRoot(candidates: string[]): SkillsRoot | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const dir = resolve(candidate);
    if (existsSync(join(dir, "skills.json")) && existsSync(join(dir, "skills"))) {
      return { dir, skillsDir: join(dir, "skills") };
    }
  }
  return null;
}

/** Candidate locations, most specific first. Default is clean (no default skills). */
export function defaultSkillsCandidates(_opts: { resourcesPath?: string; appPath: string }): string[] {
  const list: string[] = [];
  if (process.env.AIHARNESS_SKILLS_DIR) list.push(process.env.AIHARNESS_SKILLS_DIR);
  if (process.env.UNSKILLED_SKILLS_DIR) list.push(process.env.UNSKILLED_SKILLS_DIR);
  return list;
}

export interface Catalog {
  root: SkillsRoot;
  skills: SkillEntry[];
  byName: Map<string, SkillEntry>;
  modelSkills: SkillEntry[];
  userSkills: SkillEntry[];
}

export function createEmptyCatalog(root?: SkillsRoot): Catalog {
  return {
    root: root ?? { dir: "", skillsDir: "" },
    skills: [],
    byName: new Map(),
    modelSkills: [],
    userSkills: [],
  };
}

export function loadCatalog(root: SkillsRoot | null): Catalog {
  if (!root || !root.dir || !existsSync(join(root.dir, "skills.json"))) {
    return createEmptyCatalog(root ?? undefined);
  }
  const raw = JSON.parse(readFileSync(join(root.dir, "skills.json"), "utf-8")) as {
    version: number;
    skills: SkillEntry[];
  };
  if (raw.version !== 1 || !Array.isArray(raw.skills)) {
    throw new Error(`unsupported skills.json version ${String(raw.version)}`);
  }
  const skills = raw.skills;
  return {
    root,
    skills,
    byName: new Map(skills.map((s) => [s.name, s])),
    modelSkills: skills.filter((s) => s.invocation === "model"),
    userSkills: skills.filter((s) => s.invocation === "user"),
  };
}

/** SKILL.md without its frontmatter block. */
export function readSkillBody(root: SkillsRoot, name: string): string {
  if (!root.skillsDir) return "";
  const file = join(root.skillsDir, name, "SKILL.md");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  const end = lines.indexOf("---", 1);
  return end === -1 ? text : lines.slice(end + 1).join("\n").replace(/^\n+/, "");
}
