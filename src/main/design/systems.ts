import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One design system a design thread can be started from. */
export interface DesignSystemInfo {
  /** "project" (repo-root DESIGN.md), "project:<folder>" (.agents/design-systems), or the built-in folder name. */
  id: string;
  name: string;
  description: string;
  /** Up to 4 CSS colors from index.md `swatches:` (comma-separated), for the picker. */
  swatches: string[];
  source: "project" | "projectFolder" | "builtin";
  /** Absolute path of its DESIGN.md. */
  designMd: string;
  /** Absolute path of its tokens.css, when it has one. */
  tokensCss?: string;
}

/** Strip one pair of surrounding single or double quotes. */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The frontmatter a design system's `index.md` uses: scalar `key: value` lines
 * between two `---` lines. `swatches` is a comma-separated list, at most four.
 */
export function parseSystemIndex(text: string): { type?: string; name?: string; description?: string; swatches: string[] } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { swatches: [] };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { swatches: [] };

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), unquote(match[2]!.trim()));
  }
  const swatches = (fields.get("swatches") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  const parsed: { type?: string; name?: string; description?: string; swatches: string[] } = { swatches };
  const type = fields.get("type");
  if (type) parsed.type = type;
  const name = fields.get("name");
  if (name) parsed.name = name;
  const description = fields.get("description");
  if (description) parsed.description = description;
  return parsed;
}

/** True when `path` names an existing regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A file's text, or null when it can't be read. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Design-system folders under `root`, sorted by name. A folder counts when its
 * `index.md` says `type: design-system` and it has a `DESIGN.md`; anything else
 * is skipped silently.
 */
function collectSystems(
  root: string,
  source: "projectFolder" | "builtin",
  out: DesignSystemInfo[],
  seen: Set<string>,
): void {
  let folders: string[];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  for (const folder of folders) {
    const id = source === "projectFolder" ? `project:${folder}` : folder;
    if (seen.has(id)) continue;
    const dir = join(root, folder);
    const index = parseSystemIndex(readText(join(dir, "index.md")) ?? "");
    if (index.type !== "design-system") continue;
    const designMd = join(dir, "DESIGN.md");
    if (!isFile(designMd)) continue;
    seen.add(id);
    const tokensCss = join(dir, "tokens.css");
    out.push({
      id,
      name: index.name || folder,
      description: index.description || "",
      swatches: index.swatches,
      source,
      designMd,
      ...(isFile(tokensCss) ? { tokensCss } : {}),
    });
  }
}

/**
 * The design systems available at `projectPath` (its own `DESIGN.md` and
 * `.agents/design-systems`), then the built-ins in `builtinDir`. Earlier
 * sources win a duplicate id; a missing or unreadable folder contributes
 * nothing.
 */
export function listDesignSystems(projectPath: string | null, builtinDir: string): DesignSystemInfo[] {
  const out: DesignSystemInfo[] = [];
  const seen = new Set<string>();
  if (projectPath) {
    const designMd = join(projectPath, "DESIGN.md");
    if (isFile(designMd)) {
      seen.add("project");
      out.push({ id: "project", name: "Project", description: "This project's DESIGN.md", swatches: [], source: "project", designMd });
    }
    collectSystems(join(projectPath, ".agents", "design-systems"), "projectFolder", out, seen);
  }
  collectSystems(builtinDir, "builtin", out, seen);
  return out;
}

/** The entry with `id`, else the project's own, else "clean", else the first. */
export function resolveDesignSystem(list: DesignSystemInfo[], id: string | null | undefined): DesignSystemInfo | null {
  if (id) {
    const exact = list.find((s) => s.id === id);
    if (exact) return exact;
  }
  return list.find((s) => s.id === "project") ?? list.find((s) => s.id === "clean") ?? list[0] ?? null;
}

/** True when `src` and `dest` hold the same bytes; a missing dest is different. */
function sameContent(src: Buffer, dest: string): boolean {
  try {
    const hash = createHash("sha256");
    hash.update(src);
    const want = hash.digest("hex");
    return createHash("sha256").update(readFileSync(dest)).digest("hex") === want;
  } catch {
    return false;
  }
}

/** Copy `src` over `dest` when it's missing or differs. A source read error copies nothing. */
function copyIfChanged(src: string, dest: string): boolean {
  let data: Buffer;
  try {
    data = readFileSync(src);
  } catch {
    return false;
  }
  if (sameContent(data, dest)) return false;
  try {
    writeFileSync(dest, data);
    return true;
  } catch {
    return false;
  }
}

/** Write `text` to `file` unless it already holds exactly that. */
function writeIfChanged(file: string, text: string): boolean {
  if (readText(file) === text) return false;
  try {
    writeFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Materialize `system` into `destDir`: its DESIGN.md and tokens.css, plus a
 * `.system` marker with its id. Only changed files (and a now-stale tokens.css)
 * are touched; returns whether anything was written or deleted.
 */
export function materializeSystem(system: DesignSystemInfo, destDir: string): boolean {
  mkdirSync(destDir, { recursive: true });
  let changed = copyIfChanged(system.designMd, join(destDir, "DESIGN.md"));
  if (system.tokensCss) {
    changed = copyIfChanged(system.tokensCss, join(destDir, "tokens.css")) || changed;
  } else {
    const tokensCss = join(destDir, "tokens.css");
    if (existsSync(tokensCss)) {
      try {
        rmSync(tokensCss);
        changed = true;
      } catch {
        // Leave it; the caller can retry.
      }
    }
  }
  changed = writeIfChanged(join(destDir, ".system"), system.id) || changed;
  return changed;
}
