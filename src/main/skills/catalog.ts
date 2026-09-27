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
  /** The enabled winners, by precedence. */
  skills: SkillEntry[];
  byName: Map<string, SkillEntry>;
  modelSkills: SkillEntry[];
  userSkills: SkillEntry[];
  /** Every discovered entry, shadowed and disabled included, for the Library. */
  all: SkillEntry[];
}

export function createEmptyCatalog(root?: SkillsRoot): Catalog {
  return {
    root: root ?? { dir: "", skillsDir: "" },
    skills: [],
    byName: new Map(),
    modelSkills: [],
    userSkills: [],
    all: [],
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
  const skills = raw.skills.map((s) => ({ ...s, origin: "legacy" as const, dir: join(root.skillsDir, s.name) }));
  return {
    root,
    skills,
    byName: new Map(skills.map((s) => [s.name, s])),
    modelSkills: skills.filter((s) => s.invocation === "model"),
    userSkills: skills.filter((s) => s.invocation === "user"),
    all: skills,
  };
}

/**
 * Fold discovery layers into one catalog. Layers are highest precedence first;
 * the first entry for a name wins, and a lower duplicate is kept in `all` with
 * the winner's origin as `shadowedBy`. An entry the user disabled (its
 * `${origin}:${name}` is in `disabled`) keeps its place in `all` but not in the
 * enabled lists.
 */
export function mergeCatalog(layers: SkillEntry[][], disabled: Set<string>, legacyRoot?: SkillsRoot | null): Catalog {
  const all: SkillEntry[] = [];
  const winners = new Map<string, SkillEntry>();
  for (const layer of layers) {
    for (const entry of layer) {
      const off = entry.origin !== undefined && disabled.has(`${entry.origin}:${entry.name}`);
      const normalized: SkillEntry = off ? { ...entry, enabled: false } : { ...entry };
      const winner = winners.get(entry.name);
      if (winner) {
        all.push({ ...normalized, ...(winner.origin ? { shadowedBy: winner.origin } : {}) });
      } else {
        winners.set(entry.name, normalized);
        all.push(normalized);
      }
    }
  }
  const skills = [...winners.values()].filter((s) => s.enabled !== false);
  return {
    root: legacyRoot ?? { dir: "", skillsDir: "" },
    skills,
    byName: new Map(skills.map((s) => [s.name, s])),
    modelSkills: skills.filter((s) => s.invocation === "model"),
    // Every enabled winner a user can run explicitly, model-invoked ones included.
    userSkills: skills.filter((s) => s.userInvocable !== false),
    all,
  };
}

/** SKILL.md without its frontmatter block, from the skill's own folder. */
export function readSkillBodyAt(dir: string): string {
  if (!dir) return "";
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  const end = lines.indexOf("---", 1);
  return end === -1 ? text : lines.slice(end + 1).join("\n").replace(/^\n+/, "");
}

/** SKILL.md without its frontmatter block, from a legacy root and a name. */
export function readSkillBody(root: SkillsRoot, name: string): string {
  if (!root.skillsDir) return "";
  return readSkillBodyAt(join(root.skillsDir, name));
}

/** A named skill's body, using its own folder when the entry has one. */
export function bodyOf(catalog: Catalog, name: string): string {
  const entry = catalog.byName.get(name);
  if (entry?.dir) return readSkillBodyAt(entry.dir);
  return catalog.root.skillsDir ? readSkillBody(catalog.root, name) : "";
}
