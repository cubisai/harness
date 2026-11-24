import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SkillEntry } from "../../shared/types";
import { parseSkillMd } from "./discover";

export const PLUGIN_NAME = "harness-skills";

/**
 * Skill bodies call each other as `Call the Skill tool with "tdd"`. Inside a
 * plugin, Claude Code names skills `<plugin>:<skill>`, so every quoted skill name
 * on a line that mentions the Skill tool is qualified. Only names in
 * `known` are touched, so ordinary quoted text is left alone.
 */
export function qualifySkillCalls(text: string, known: Set<string>, prefix = `${PLUGIN_NAME}:`): string {
  if (!prefix) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!/Skill tool/.test(line)) return line;
      return line.replace(/(["`])([a-z0-9_-]+)\1/g, (match, quote: string, name: string) =>
        known.has(name) ? `${quote}${prefix}${name}${quote}` : match,
      );
    })
    .join("\n");
}

function rewriteMarkdown(dir: string, known: Set<string>, names: Map<string, string>, prefix: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // A standalone skill may contain links. Never rewrite through one into user/native files.
    if (entry.isDirectory()) {
      rewriteMarkdown(full, known, names, prefix);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const text = readFileSync(full, "utf-8");
      const renamed = text.split("\n").map((line) => /Skill tool/.test(line)
        ? line.replace(/(["`])([a-z0-9_-]+)\1/g, (match, quote: string, name: string) => names.has(name) ? `${quote}${names.get(name)}${quote}` : match)
        : line).join("\n");
      const next = qualifySkillCalls(renamed, known, prefix);
      if (next !== text) writeFileSync(full, next);
    }
  }
}

export interface SkillCopyOptions {
  /** Main's reviewed owner/revision validator; plugin copies fail closed without it. */
  assertSkill?: (entry: SkillEntry) => void;
  /** All active plugin skills, including user-only siblings whose calls need runtime names. */
  pluginSkills?: () => SkillEntry[];
}
type CopyKind = "plugin" | "directory";
interface CopiedOwner { name: string; key: string; revision: string }
interface CopyOwners { version: 1; kind: CopyKind; owners: CopiedOwner[] }
const OWNERS_FILE = ".cubiq-skill-owners.json";
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Every bundled resource participates, not just SKILL.md. No links or special files in reviewed copies. */
export function pluginSkillFingerprint(dir: string): string {
  const digest = createHash("sha256");
  const walk = (path: string, rel: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Plugin skill resources must be plain files, not symlinks.");
    if (stat.isDirectory()) {
      digest.update(JSON.stringify(["dir", rel]));
      for (const name of readdirSync(path).sort()) walk(join(path, name), rel ? `${rel}/${name}` : name);
    } else if (stat.isFile()) {
      const content = readFileSync(path);
      digest.update(JSON.stringify(["file", rel, content.length])).update(content);
    } else throw new Error("Plugin skill resources must be plain files.");
  };
  walk(dir, "");
  return digest.digest("hex");
}

function assertTarget(targetDir: string, skills: SkillEntry[] = []): void {
  // Check existing parents too: a linked delivery root must not lead writes/deletes into native folders.
  for (let path = resolve(targetDir); ; path = dirname(path)) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Generated skill destination is not a plain directory.");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (dirname(path) === path) break;
  }
  for (const s of skills) {
    if (!SAFE_NAME.test(s.name)) throw new Error("Invalid generated skill name.");
    if (!s.dir) continue;
    const source = existsSync(s.dir) ? realpathSync(s.dir) : resolve(s.dir), target = resolve(targetDir);
    const inside = (a: string, b: string) => { const rel = relative(a, b); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };
    if (inside(source, target) || inside(target, source)) throw new Error("Generated skill destination overlaps a source folder.");
  }
}

function copyStamp(skills: SkillEntry[], opts: SkillCopyOptions, kind: CopyKind): string {
  return JSON.stringify([2, kind, skills.map((s) => {
    if (s.origin !== "plugin") return [s.origin, s.name, s.sha256];
    if (!opts.assertSkill || !s.owner?.enabled || !s.owner.revision || !s.dir) throw new Error("Plugin skill delivery requires an active reviewed owner.");
    opts.assertSkill(s);
    return [s.origin, s.name, s.sha256, s.owner.key, s.owner.revision, pluginSkillFingerprint(s.dir)];
  })]);
}

function copySkills(skills: SkillEntry[], targetDir: string, kind: CopyKind, opts: SkillCopyOptions): string | null {
  assertTarget(targetDir, skills);
  if (!skills?.length) {
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    return null;
  }
  // Check before a cache hit too: an old generated copy is not a capability.
  const stamp = copyStamp(skills, opts, kind), stampFile = join(targetDir, ".stamp");
  if (existsSync(stampFile) && readFileSync(stampFile, "utf-8") === stamp) return targetDir;
  const siblings = opts.pluginSkills?.() ?? skills;
  const known = new Set([...skills, ...siblings].map((s) => s.name));
  const namesFor = (skill: SkillEntry): Map<string, string> => new Map(siblings.filter((s) => s.origin === "plugin" && s.owner?.key === skill.owner?.key && s.dir)
    .map((s) => [parseSkillMd(readFileSync(join(s.dir!, "SKILL.md"), "utf8")).name ?? basename(s.dir!), s.name]));
  // Preflight every resource/name before replacing any owned delivery files.
  const names = new Map(skills.filter((s) => s.origin === "plugin").map((s) => [s.name, namesFor(s)]));
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  try {
    if (kind === "plugin") {
      mkdirSync(join(targetDir, ".claude-plugin"));
      writeFileSync(join(targetDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN_NAME, description: "Model-invoked skills loaded by CubiQ.", version: "1.0.0" }, null, 2) + "\n");
    }
    for (const skill of skills) {
      if (!skill.dir || !existsSync(skill.dir)) continue;
      const dest = join(targetDir, ...(kind === "plugin" ? ["skills"] : []), skill.name);
      // A native source root can be a link, but its generated destination must be an actual copy.
      cpSync(realpathSync(skill.dir), dest, { recursive: true });
      if (skill.origin === "plugin") {
        const file = join(dest, "SKILL.md"), text = readFileSync(file, "utf8");
        const lines = text.split(/\r?\n/), end = lines.indexOf("---", 1);
        if (lines[0] !== "---" || end < 1) throw new Error("Plugin skill has no reviewed frontmatter.");
        // The frozen snapshot is unchanged; only this generated delivery copy gets a runtime identity.
        const front = lines.slice(1, end).filter((line) => !/^\s*name\s*:/i.test(line));
        writeFileSync(file, ["---", `name: ${skill.name}`, ...front, "---", ...lines.slice(end + 1)].join("\n"));
      }
      rewriteMarkdown(dest, known, names.get(skill.name) ?? new Map(), kind === "plugin" ? `${PLUGIN_NAME}:` : "");
    }
    // Detect an Off/Update or resource replacement during the copy before publishing the stamp.
    if (copyStamp(skills, opts, kind) !== stamp) throw new Error("Plugin skill changed during delivery.");
    const owners: CopyOwners = { version: 1, kind, owners: skills.filter((s) => s.origin === "plugin").map((s) => ({ name: s.name, key: s.owner!.key, revision: s.owner!.revision! })) };
    writeFileSync(join(targetDir, OWNERS_FILE), JSON.stringify(owners));
    writeFileSync(stampFile, stamp);
    return targetDir;
  } catch (e) {
    // Only this invocation's generated files exist here; never leave a partial active copy.
    rmSync(targetDir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Build the local Claude Code plugin that carries model-invoked skills.
 * If there are no skills, returns null.
 */
export function ensurePlugin(skills: SkillEntry[], targetDir: string, opts: SkillCopyOptions = {}): string | null {
  return copySkills(skills, targetDir, "plugin", opts);
}

/**
 * A plain copy of the model-invoked skills, names unqualified, for agents
 * that load skills from a directory. If there are no skills, returns null.
 */
export function ensureModelSkillsDir(skills: SkillEntry[], targetDir: string, opts: SkillCopyOptions = {}): string | null {
  return copySkills(skills, targetDir, "directory", opts);
}

/** Revoke owned copies in every previously generated scope, without touching native/user skills. */
export function prunePluginSkillCopies(roots: { plugin: string; model: string; projects: string }, live: SkillEntry[]): void {
  const prune = (target: string): void => {
    if (!existsSync(target)) return;
    assertTarget(target);
    const file = join(target, OWNERS_FILE);
    if (!existsSync(file)) return; // Legacy generated folders contain no bundle copies.
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Invalid generated skill ownership file.");
    const owners = JSON.parse(readFileSync(file, "utf8")) as CopyOwners;
    if (owners.version !== 1 || !["plugin", "directory"].includes(owners.kind) || !Array.isArray(owners.owners) || owners.owners.some((o) => !SAFE_NAME.test(o.name) || !/^g~[a-z0-9][a-z0-9-]{0,63}$/.test(o.key) || typeof o.revision !== "string")) throw new Error("Invalid generated skill ownership record.");
    const stale = owners.owners.filter((o) => !live.some((s) => s.origin === "plugin" && s.enabled !== false && s.owner?.enabled && s.name === o.name && s.owner.key === o.key && s.owner.revision === o.revision));
    if (!stale.length) return;
    const base = owners.kind === "plugin" ? join(target, "skills") : target;
    if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new Error("Generated skill folder is a symlink.");
    for (const o of stale) rmSync(join(base, o.name), { recursive: true, force: true });
    rmSync(join(target, ".stamp"), { force: true });
    writeFileSync(file, JSON.stringify({ ...owners, owners: owners.owners.filter((o) => !stale.includes(o)) }));
  };
  const scopes = (root: string): void => {
    if (!existsSync(root)) return;
    assertTarget(root);
    for (const entry of readdirSync(root, { withFileTypes: true })) if (/^[a-f0-9]{12}$/.test(entry.name)) prune(join(root, entry.name));
  };
  scopes(roots.plugin);
  prune(roots.model);
  scopes(roots.projects);
}
