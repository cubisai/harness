import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expertFromMarkdown, parseExpertMarkdown, type ExpertDef, type ExpertMember, type ExpertSkill } from "../../shared/experts";

/**
 * The Library's expert catalogue: bundled experts shipped with the app, plus
 * the user's imported ones. A bundled expert is a file `<bundledDir>/<id>.md`
 * or a folder `<bundledDir>/<id>/expert.md`; a team's members sit under
 * `members/<memberId>.md` beside it. Imported experts use the same folder
 * layout under `<userDir>`, and an imported id overrides a bundled one of the
 * same name. Every read is best-effort: a missing folder or a bad file is
 * skipped, never thrown. The listing is cached by the candidate paths' mtimes.
 */
export function createExpertCatalog(opts: { bundledDir: string; userDir: string }): {
  list(): ExpertDef[];
  get(id: string): ExpertDef | null;
  skillsDir(id: string): string | null;
  packageSkills(id: string): ExpertSkill[];
} {
  let cached: { sig: string; defs: ExpertDef[] } | null = null;

  /** Bundled expert.md paths: a bare `<id>.md`, or a folder `<id>/expert.md`, in file-name order. */
  const bundledPaths = (): string[] => expertPaths(opts.bundledDir, false);

  /** Imported expert.md paths: the folder layout `<id>/expert.md` only. */
  const importedPaths = (): string[] => expertPaths(opts.userDir, true);

  /** Every candidate expert.md and member.md path tagged with its mtime: the cache signature. */
  const signature = (): string =>
    [...bundledPaths(), ...importedPaths()]
      .flatMap((path) => [path, ...readDir(join(dirname(path), "members")).map((name) => join(dirname(path), "members", name))])
      .map(withMtime)
      .join("\n");

  /** Bundled first in file-name order, then imported by name; an imported id replaces a bundled def. */
  const load = (): ExpertDef[] => {
    const defs: ExpertDef[] = [];
    for (const path of bundledPaths()) {
      const def = readDef(path, "builtin");
      if (def) defs.push(def);
    }
    const imported: ExpertDef[] = [];
    for (const path of importedPaths()) {
      const def = readDef(path, "imported");
      if (def) imported.push(def);
    }
    imported.sort((a, b) => a.name.localeCompare(b.name));
    for (const def of imported) {
      const at = defs.findIndex((d) => d.id === def.id);
      if (at >= 0) defs[at] = def;
      else defs.push(def);
    }
    return defs;
  };

  const all = (): ExpertDef[] => {
    const sig = signature();
    if (cached?.sig === sig) return cached.defs;
    const defs = load();
    cached = { sig, defs };
    return defs;
  };

  /** A folder expert's own `skills/` (an imported package's), or null: a bare `<id>.md` has none. */
  const skillsDirOf = (id: string): string | null => {
    const path = all().find((d) => d.id === id)?.path;
    if (!path || basename(path) !== "expert.md") return null;
    const dir = join(dirname(path), "skills");
    return isDir(dir) ? dir : null;
  };

  return {
    list(): ExpertDef[] {
      return all();
    },
    get(id: string): ExpertDef | null {
      return all().find((d) => d.id === id) ?? null;
    },
    skillsDir(id: string): string | null {
      return skillsDirOf(id);
    },
    /** The expert's own package skills (`<expert folder>/skills/<name>/SKILL.md`), sorted by folder name; [] when it has none. */
    packageSkills(id: string): ExpertSkill[] {
      const dir = skillsDirOf(id);
      if (!dir) return [];
      const out: ExpertSkill[] = [];
      for (const entry of readDir(dir)) {
        const file = join(dir, entry, "SKILL.md");
        if (!isFile(file)) continue;
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const { meta } = parseExpertMarkdown(text, entry);
        out.push({
          name: metaStr(meta, "name") || entry,
          description: metaStr(meta, "description").replace(/\s+/g, " ").slice(0, 300),
          file,
        });
      }
      return out;
    },
  };
}

/** The expert.md paths under a root: a bare `<id>.md` (unless folders only), or `<id>/expert.md`. */
function expertPaths(root: string, foldersOnly: boolean): string[] {
  const out: string[] = [];
  for (const entry of readDir(root)) {
    const asIs = join(root, entry);
    if (!foldersOnly && entry.endsWith(".md") && isFile(asIs)) {
      out.push(asIs);
      continue;
    }
    const folder = join(root, entry, "expert.md");
    if (isFile(folder)) out.push(folder);
  }
  return out;
}

/** Read one expert.md into a def; its members come from the sibling `members/` folder. */
function readDef(path: string, source: "builtin" | "imported"): ExpertDef | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const def = expertFromMarkdown(text, fallbackIdOf(path), source);
  if (!def) return null;
  // A folder expert's package skills are private to the agent it's bound to,
  // so they never appear among the def's skills (the UI pre-adds those as
  // global chips when the expert is summoned).
  let skills = def.skills;
  const skillsFolder = join(dirname(path), "skills");
  if (basename(path) === "expert.md" && isDir(skillsFolder)) {
    const pkg = new Set(readDir(skillsFolder).filter((entry) => isDir(join(skillsFolder, entry))));
    skills = skills.filter((name) => !pkg.has(name));
  }
  const members = readMembers(join(dirname(path), "members"));
  return { ...def, skills, path, ...(members.length ? { members } : {}) };
}

/** Members from `members/<memberId>.md`: id = the file name, prompt = the body, the rest from meta. */
function readMembers(dir: string): ExpertMember[] {
  const out: ExpertMember[] = [];
  for (const name of readDir(dir)) {
    if (!name.endsWith(".md")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const memberId = name.slice(0, -3);
    const { meta, body } = parseExpertMarkdown(text, memberId);
    const prompt = body.trim();
    if (!prompt) continue;
    out.push({
      id: memberId,
      name: metaStr(meta, "name") || memberId,
      profession: metaStr(meta, "profession"),
      description: metaStr(meta, "description"),
      prompt,
      skills: metaList(meta, "skills"),
      ...maxTurnsOf(metaStr(meta, "maxTurns")),
    });
  }
  return out;
}

/** A package's `maxTurns` (1–500) as a member field; nothing when absent or out of range. */
function maxTurnsOf(value: string): { maxTurns?: number } {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? { maxTurns: n } : {};
}

/** A meta value as one trimmed string, or "" when it's a list/absent. */
function metaStr(meta: Record<string, string | string[]>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value.trim() : "";
}

/** A meta value as a trimmed string list (inline, dash list, or a lone string). */
function metaList(meta: Record<string, string | string[]>, key: string): string[] {
  const value = meta[key];
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter((v) => v.length > 0);
  return value && value.trim() ? [value.trim()] : [];
}

/** The fallback id when a file has no `id` meta: a bare `<id>.md`, or its folder name. */
function fallbackIdOf(path: string): string {
  const base = path.replace(/\\/g, "/");
  const withoutExpert = base.endsWith("/expert.md") ? base.slice(0, -"/expert.md".length) : base.slice(0, -3);
  const slash = withoutExpert.lastIndexOf("/");
  return slash === -1 ? withoutExpert : withoutExpert.slice(slash + 1);
}

function readDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A path tagged with its mtime, so the listing's signature moves when a file changes. */
function withMtime(path: string): string {
  try {
    return `${path}@${statSync(path).mtimeMs}`;
  } catch {
    return path;
  }
}
