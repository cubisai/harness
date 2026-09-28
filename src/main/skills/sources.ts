import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Catalog, SkillsRoot } from "./catalog";
import { loadCatalog, mergeCatalog } from "./catalog";
import type { SkillOrigin, SkillsDelivery, SkillEntry } from "../../shared/types";
import { discoverSkills } from "./discover";

export interface SkillCatalogOptions {
  legacyRoot: SkillsRoot | null;
  bundledDir: string;
  harnessDir: string;
  disabled: () => string[];
}

function mtimeMs(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/** A stamp that moves when a skill folder is added or removed, or any SKILL.md is edited in place. */
function stamp(dir: string): string {
  let children = "";
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) children += `${entry.name}:${mtimeMs(join(dir, entry.name, "SKILL.md"))};`;
    }
  } catch {
    // A missing root stamps as 0 and discovers nothing.
  }
  return `${mtimeMs(dir)}|${children}`;
}

/**
 * The standard Agent Skills folders, merged by precedence: the project's
 * `.agents/skills` then `.claude/skills`, the app's own (global) folder, the
 * bundled set, and finally the legacy skills.json root. Discovered layers are
 * cached by their folders' mtimes, so repeated lookups are cheap and an edit
 * shows up.
 */
export class SkillCatalogs {
  private cache = new Map<string, { stamp: string; entries: SkillEntry[] }>();

  constructor(private opts: SkillCatalogOptions) {}

  private discovered(origin: SkillOrigin, dir: string): SkillEntry[] {
    const key = `${origin}|${dir}`;
    const now = stamp(dir);
    const hit = this.cache.get(key);
    if (hit && hit.stamp === now) return hit.entries;
    const entries = discoverSkills({ origin, dir });
    this.cache.set(key, { stamp: now, entries });
    return entries;
  }

  private legacy(): SkillEntry[] {
    return loadCatalog(this.opts.legacyRoot).skills;
  }

  /** The folders this app reads, for the UI. `project` and `projectClaude` are "" without a cwd. */
  dirs(cwd: string | null): { project: string; projectClaude: string; harness: string; bundled: string } {
    return {
      project: cwd ? join(cwd, ".agents", "skills") : "",
      projectClaude: cwd ? join(cwd, ".claude", "skills") : "",
      harness: this.opts.harnessDir,
      bundled: this.opts.bundledDir,
    };
  }

  global(): Catalog {
    const disabled = new Set(this.opts.disabled());
    return mergeCatalog(
      [this.discovered("harness", this.opts.harnessDir), this.discovered("bundled", this.opts.bundledDir), this.legacy()],
      disabled,
      this.opts.legacyRoot,
    );
  }

  forProject(cwd: string | null): Catalog {
    const disabled = new Set(this.opts.disabled());
    const layers: SkillEntry[][] = [];
    // .agents comes first so it wins a name in both. The .claude folder has its own origin:
    // Claude reads it natively, but Codex and OpenCode only read .agents, so the app delivers it to them.
    if (cwd) layers.push(this.discovered("project", join(cwd, ".agents", "skills")), this.discovered("projectClaude", join(cwd, ".claude", "skills")));
    layers.push(this.discovered("harness", this.opts.harnessDir), this.discovered("bundled", this.opts.bundledDir), this.legacy());
    return mergeCatalog(layers, disabled, this.opts.legacyRoot);
  }

  /**
   * Names of the skills in folders an agent reads on its own that aren't
   * catalog sources (Claude's `~/.claude/skills` and `<cwd>/.claude/skills`),
   * so the same skill isn't delivered to it a second time.
   */
  namesIn(dirs: string[]): Set<string> {
    return new Set(dirs.flatMap((dir) => this.discovered("shared", dir).map((s) => s.name)));
  }

  invalidate(): void {
    this.cache.clear();
  }
}

/**
 * Model skills to deliver, minus the origins the agent already loads itself
 * and any name it already has from its own folders (`native`).
 */
export function forAgent(catalog: Catalog, delivery: SkillsDelivery, native: Set<string> = new Set()): SkillEntry[] {
  const reads = delivery.reads ?? [];
  return catalog.modelSkills.filter((s) => !(s.origin && reads.includes(s.origin)) && !native.has(s.name));
}
