import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { STYLE_PREFIX } from "../../shared/direction";
import type { StyleFacets } from "../../shared/types";
import { parseKitManifest } from "./kit-schema";

/** A kit system's id: `kit:<kitId>`, or `kit:<kitId>/<theme>` for one of its themes. */
export const KIT_PREFIX = "kit:";

/** One design system a design thread can be started from. */
export interface DesignSystemInfo {
  /** "project" (repo-root DESIGN.md), "project:<folder>" (.agents/design-systems), or "style:<folder>" (the style library). */
  id: string;
  name: string;
  description: string;
  /** Up to 4 CSS colors from index.md `swatches:` (comma-separated), for the picker. */
  swatches: string[];
  source: "project" | "projectFolder" | "style" | "kit";
  /** Set when it comes with components: the folder whose parts are copied into `system/` beside its tokens. */
  kit?: KitRef;
  /** Absolute path of its DESIGN.md. */
  designMd: string;
  /** Absolute path of its tokens.css, when it has one. */
  tokensCss?: string;
  /** What its tokens.css looks like (for the picker's filters and the shortlist); absent without one. */
  facets?: StyleFacets;
  /** Font files (absolute) copied into `system/fonts/` with it: a style's faces from the bundled font pack. */
  fontFiles?: string[];
}

/** The component kit behind a design system. */
export interface KitRef {
  id: string;
  dir: string;
  version: string;
  contractVersion: string;
}

/** A style from the style library: a design system plus what the agent matches it by. */
export interface DesignStyleInfo extends DesignSystemInfo {
  source: "style";
  tags: string[];
  modes: string[];
  /** web | mobile | deck | any */
  platform: string;
}

/** Strip one pair of surrounding single or double quotes. */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Scalar `key: value` lines between two leading `---` lines, keys lowercased; empty without frontmatter. */
function frontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return fields;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return fields;
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), unquote(match[2]!.trim()));
  }
  return fields;
}

/** A comma-separated frontmatter list, trimmed, empties dropped. */
function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The frontmatter a design system's `index.md` uses: scalar `key: value` lines
 * between two `---` lines. `swatches` is a comma-separated list, at most four.
 */
export function parseSystemIndex(text: string): { type?: string; name?: string; description?: string; swatches: string[] } {
  const fields = frontmatter(text);
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

/** The sRGB channels of `#rgb`, `#rrggbb`, `rgb(r g b)` or `rgb(r, g, b)` (alpha ignored), or null when it isn't one. */
function parseColor(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join("") : hex[1]!;
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  }
  // A kit may write oklch: its lightness alone says whether the ground is light or dark, as a grey of that lightness.
  const oklch = /^oklch\(\s*([\d.]+)(%?)/i.exec(value);
  if (oklch) {
    const lightness = Number(oklch[1]) / (oklch[2] ? 100 : 1);
    const y = Math.min(1, Math.max(0, lightness)) ** 3;
    const grey = Math.round(255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055));
    return [grey, grey, grey];
  }
  const rgb = /^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/i.exec(value);
  if (!rgb) return null;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

/** WCAG relative luminance of sRGB channels (0-255). */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * What a tokens.css looks like: light or dark base, display family and corner shape. Dark overrides after the first
 * `@media` are ignored. Null when its `--color-bg` is missing or unreadable.
 */
export function tokenFacets(css: string): StyleFacets | null {
  const base = css.split("@media")[0]!;
  const bg = /--color-bg:\s*([^;]+);/.exec(base)?.[1]?.trim();
  if (!bg) return null;
  const color = parseColor(bg);
  if (!color) return null;
  const stack = ((/--font-display:\s*([^;]+);/.exec(base) ?? /--font-sans:\s*([^;]+);/.exec(base))?.[1] ?? "").toLowerCase();
  const families = stack.split(",").map((entry) => unquote(entry.trim()));
  const radius = /--radius-md:\s*([\d.]+)px/.exec(base)?.[1];
  return {
    theme: luminance(color) < 0.2 ? "dark" : "light",
    darkPair: /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i.test(css),
    display: families.includes("monospace") ? "mono" : families.includes("serif") ? "serif" : "sans",
    shape: radius === undefined ? "soft" : Number(radius) <= 2 ? "sharp" : Number(radius) <= 9 ? "soft" : "round",
  };
}

/**
 * Design-system folders under `root` (a project's `.agents/design-systems`), sorted by name. A folder counts when its
 * `index.md` says `type: design-system` and it has a `DESIGN.md`; anything else
 * is skipped silently.
 */
function collectSystems(root: string, out: DesignSystemInfo[], seen: Set<string>): void {
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
    const id = `project:${folder}`;
    if (seen.has(id)) continue;
    const dir = join(root, folder);
    const index = parseSystemIndex(readText(join(dir, "index.md")) ?? "");
    if (index.type !== "design-system" && index.type !== "design-kit") continue;
    const designMd = join(dir, "DESIGN.md");
    if (!isFile(designMd)) continue;
    seen.add(id);
    const kit = kitRef(dir);
    const tokensCss = join(dir, "tokens.css");
    const text = readText(tokensCss);
    const facets = text ? tokenFacets(text) : null;
    const fontFiles = fontsIn(dir);
    out.push({
      id,
      name: index.name || folder,
      description: index.description || "",
      swatches: index.swatches,
      source: "projectFolder",
      designMd,
      ...(isFile(tokensCss) ? { tokensCss } : {}),
      ...(facets ? { facets } : {}),
      ...(fontFiles.length ? { fontFiles } : {}),
      ...(kit ? { kit } : {}),
    });
  }
}

/** The kit in `dir`, when it holds a valid manifest and the parts that manifest describes; else null. */
function kitRef(dir: string): KitRef | null {
  if (!isFile(join(dir, "ui.css"))) return null;
  const text = readText(join(dir, "components.json"));
  if (text === null) return null;
  const parsed = parseKitManifest(text);
  if (!parsed.ok) return null;
  const { kitId, version, contractVersion } = parsed.manifest;
  return { id: kitId, dir, version, contractVersion };
}

/**
 * The systems one kit offers: the kit on its own tokens, then each theme in its `themes/` folder. A kit whose
 * `compat.themes` has `*` is written against the style library's token names, so every style is a theme of it too.
 */
export function listKitSystems(dir: string, styles: readonly DesignStyleInfo[] = []): DesignSystemInfo[] {
  const kit = kitRef(dir);
  const designMd = join(dir, "DESIGN.md");
  const tokensCss = join(dir, "tokens.css");
  if (!kit || !isFile(designMd) || !isFile(tokensCss)) return [];
  const parsed = parseKitManifest(readText(join(dir, "components.json")) ?? "");
  if (!parsed.ok) return [];

  const index = parseSystemIndex(readText(join(dir, "index.md")) ?? "");
  const base = `${KIT_PREFIX}${kit.id}`;
  const fontFiles = fontsIn(dir);
  const fonts = fontFiles.length ? { fontFiles } : {};
  const facets = tokenFacets(readText(tokensCss) ?? "");
  const out: DesignSystemInfo[] = [
    {
      id: base,
      name: parsed.manifest.name,
      description: index.description || "",
      swatches: index.swatches,
      source: "kit",
      designMd,
      tokensCss,
      kit,
      ...(facets ? { facets } : {}),
      ...fonts,
    },
  ];

  let themes: string[] = [];
  try {
    themes = readdirSync(join(dir, "themes"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    // A kit may have only its own tokens.
  }
  for (const theme of themes) {
    const themeDir = join(dir, "themes", theme);
    const themeTokens = join(themeDir, "tokens.css");
    if (!isFile(themeTokens)) continue;
    const themeIndex = parseSystemIndex(readText(join(themeDir, "index.md")) ?? "");
    const themeDesign = join(themeDir, "DESIGN.md");
    const themeFacets = tokenFacets(readText(themeTokens) ?? "");
    out.push({
      id: `${base}/${theme}`,
      name: themeIndex.name || theme,
      description: themeIndex.description || "",
      swatches: themeIndex.swatches,
      source: "kit",
      designMd: isFile(themeDesign) ? themeDesign : designMd,
      tokensCss: themeTokens,
      kit,
      ...(themeFacets ? { facets: themeFacets } : {}),
      ...fonts,
    });
  }

  if (parsed.manifest.compat.themes.includes("*")) {
    for (const style of styles) {
      if (!style.tokensCss) continue;
      out.push({
        id: `${base}/${style.id.slice(STYLE_PREFIX.length)}`,
        name: style.name,
        description: style.description,
        swatches: style.swatches,
        source: "kit",
        designMd: style.designMd,
        tokensCss: style.tokensCss,
        kit,
        ...(style.facets ? { facets: style.facets } : {}),
        ...(style.fontFiles ? { fontFiles: style.fontFiles } : {}),
      });
    }
  }
  return out;
}

/**
 * The design systems available at `projectPath`: its own `DESIGN.md`, then
 * `.agents/design-systems`. A missing or unreadable folder contributes nothing.
 */
export function listDesignSystems(projectPath: string | null): DesignSystemInfo[] {
  const out: DesignSystemInfo[] = [];
  const seen = new Set<string>();
  if (projectPath) {
    const designMd = join(projectPath, "DESIGN.md");
    if (isFile(designMd)) {
      seen.add("project");
      out.push({ id: "project", name: "Project", description: "This project's DESIGN.md", swatches: [], source: "project", designMd });
    }
    collectSystems(join(projectPath, ".agents", "design-systems"), out, seen);
  }
  return out;
}

/**
 * The style library in `stylesDir`: one folder per style with `index.md`
 * (`type: design-style`, name, description, swatches, tags, modes, platform,
 * fonts), `DESIGN.md` and `tokens.css`. `fonts` names files in `fontsDir` that
 * travel with it. Sorted by folder; anything malformed is skipped.
 */
export function listDesignStyles(stylesDir: string, fontsDir: string): DesignStyleInfo[] {
  let folders: string[];
  try {
    folders = readdirSync(stylesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: DesignStyleInfo[] = [];
  for (const folder of folders) {
    const dir = join(stylesDir, folder);
    const fields = frontmatter(readText(join(dir, "index.md")) ?? "");
    const designMd = join(dir, "DESIGN.md");
    const tokensCss = join(dir, "tokens.css");
    if (fields.get("type") !== "design-style" || !isFile(designMd) || !isFile(tokensCss)) continue;
    const fontFiles = list(fields.get("fonts"))
      .filter((f) => /^[\w.-]+\.woff2$/.test(f))
      .map((f) => join(fontsDir, f))
      .filter(isFile);
    const text = readText(tokensCss);
    const facets = text ? tokenFacets(text) : null;
    out.push({
      id: `${STYLE_PREFIX}${folder}`,
      name: fields.get("name") || folder,
      description: fields.get("description") || "",
      swatches: list(fields.get("swatches")).slice(0, 4),
      source: "style",
      designMd,
      tokensCss,
      ...(facets ? { facets } : {}),
      ...(fontFiles.length ? { fontFiles } : {}),
      tags: list(fields.get("tags")),
      modes: list(fields.get("modes")),
      platform: fields.get("platform") || "any",
    });
  }
  return out;
}

/**
 * The style index the agent picks from, one short line per style (it rides in a tool description on every design
 * turn): the description's first clause, three tags, modes, platform, and dark when its base is dark. The full note
 * arrives once a style is picked.
 */
export function styleIndex(styles: DesignStyleInfo[]): string {
  return styles
    .map((s) => {
      const gist = s.description.split(/[:.;]/)[0]!.trim();
      const theme = s.facets?.theme === "dark" ? "; dark" : "";
      return `${s.id.slice(STYLE_PREFIX.length)}: ${gist} [${s.tags.slice(0, 3).join(", ")}; ${s.modes.join("/")}; ${s.platform}${theme}]`;
    })
    .join("\n");
}

/** FNV-1a 32-bit hash of `text` with murmur3's finalizer (FNV alone leaves the high bits poorly mixed), unsigned. */
function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The weight each rank of a shortlist gets before renormalizing over what is left. */
const SHORTLIST_WEIGHTS = [0.5, 0.3, 0.2];

/**
 * One id from a ranked shortlist (best first), weighted 0.5 / 0.3 / 0.2 by rank and renormalized over what is left,
 * seeded by `seed` (the thread id) so the same thread and list always get the same answer.
 */
export function pickFromShortlist(ids: string[], seed: string): string {
  const list = ids.slice(0, 3);
  const r = fnv1a(seed) / 2 ** 32;
  const total = list.reduce((sum, _, i) => sum + (SHORTLIST_WEIGHTS[i] ?? 0), 0);
  let cumulative = 0;
  for (let i = 0; i < list.length; i++) {
    cumulative += (SHORTLIST_WEIGHTS[i] ?? 0) / total;
    if (cumulative > r) return list[i]!;
  }
  return list[list.length - 1]!;
}

/** The entry with `id`, else the project's own DESIGN.md, else null. */
export function resolveDesignSystem(list: DesignSystemInfo[], id: string | null | undefined): DesignSystemInfo | null {
  if (id) {
    const exact = list.find((s) => s.id === id);
    if (exact) return exact;
  }
  return list.find((s) => s.id === "project") ?? null;
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
/**
 * Write a file whole or not at all: a temp file beside it, then a rename, so the canvas never loads a half-written
 * stylesheet. The temp name is one the folder watcher skips. Where the rename is refused (a file held open on
 * Windows), it writes in place as before.
 */
function writeWhole(dest: string, data: string | Buffer): void {
  const temp = `${dest}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(temp, data);
    renameSync(temp, dest);
  } catch {
    rmSync(temp, { force: true });
    writeFileSync(dest, data);
  }
}

function copyIfChanged(src: string, dest: string): boolean {
  let data: Buffer;
  try {
    data = readFileSync(src);
  } catch {
    return false;
  }
  if (sameContent(data, dest)) return false;
  try {
    writeWhole(dest, data);
    return true;
  } catch {
    return false;
  }
}

/** Write `text` to `file` unless it already holds exactly that. */
function writeIfChanged(file: string, text: string): boolean {
  if (readText(file) === text) return false;
  try {
    writeWhole(file, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Materialize `system` into `destDir`: its DESIGN.md and tokens.css, plus a
 * `.system` marker with its id. Only changed files (and a now-stale tokens.css)
 * are touched; returns whether anything was written or deleted.
 *
 * A system without tokens.css (the project's own DESIGN.md) leaves the agent to
 * derive one, so a tokens.css is deleted only when it came from a different
 * system; deleting it on the next turn of the same system unstyles every page.
 */
export function materializeSystem(system: DesignSystemInfo, destDir: string): boolean {
  mkdirSync(destDir, { recursive: true });
  const before = readText(join(destDir, ".system"))?.trim() ?? "";
  let changed = copyIfChanged(system.designMd, join(destDir, "DESIGN.md"));
  if (system.tokensCss) {
    changed = copyIfChanged(system.tokensCss, join(destDir, "tokens.css")) || changed;
  } else if (before && before !== system.id) {
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
  changed = syncFonts(system.fontFiles ?? [], join(destDir, "fonts")) || changed;
  changed = syncKit(system, destDir) || changed;
  changed = writeIfChanged(join(destDir, ".system"), system.id) || changed;
  return changed;
}

/** The files a kit adds to `system/`, beside `blocks/` and, when a theme's DESIGN.md took that name, `KIT.md`. */
const KIT_FILES: readonly string[] = ["ui.css", "ui.js", "components.json", "migrations.json"];

/** Delete a file or folder if it's there; true when something went. */
function removeIfPresent(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep `system/` holding exactly the system's kit parts. The `.kit` marker is what makes a removal safe: without it
 * nothing here ever touches `system/`, so a flat style writes exactly what it always did.
 */
function syncKit(system: DesignSystemInfo, destDir: string): boolean {
  const marker = join(destDir, ".kit");
  const blocks = join(destDir, "blocks");
  const kitMd = join(destDir, "KIT.md");
  if (!system.kit) {
    if (!existsSync(marker)) return false;
    let changed = false;
    for (const name of KIT_FILES) changed = removeIfPresent(join(destDir, name)) || changed;
    changed = removeIfPresent(blocks) || changed;
    changed = removeIfPresent(kitMd) || changed;
    return removeIfPresent(marker) || changed;
  }

  const { dir, id } = system.kit;
  let changed = false;
  for (const name of KIT_FILES) {
    const src = join(dir, name);
    changed = (isFile(src) ? copyIfChanged(src, join(destDir, name)) : removeIfPresent(join(destDir, name))) || changed;
  }
  const kitDesign = join(dir, "DESIGN.md");
  changed = (system.designMd !== kitDesign && isFile(kitDesign) ? copyIfChanged(kitDesign, kitMd) : removeIfPresent(kitMd)) || changed;
  changed = syncBlocks(join(dir, "blocks"), blocks) || changed;
  return writeIfChanged(marker, id) || changed;
}

/** Make `dest` hold exactly the `.html` files in `src`. A link or anything else in `src` is left behind. */
function syncBlocks(src: string, dest: string): boolean {
  let names: string[] = [];
  try {
    names = readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".html"))
      .map((e) => e.name);
  } catch {
    // A kit may have no blocks.
  }
  if (!names.length) return removeIfPresent(dest);

  let changed = false;
  let present: string[] = [];
  try {
    present = readdirSync(dest);
  } catch {
    mkdirSync(dest, { recursive: true });
  }
  for (const name of present) {
    if (!names.includes(name)) changed = removeIfPresent(join(dest, name)) || changed;
  }
  for (const name of names) changed = copyIfChanged(join(src, name), join(dest, name)) || changed;
  return changed;
}

/** Make `fontsDir` hold exactly `files` (by name): copy new or changed ones, delete other .woff2 files there. */
function syncFonts(files: string[], fontsDir: string): boolean {
  const want = new Set(files.map((f) => basename(f)));
  let changed = false;
  let present: string[] = [];
  try {
    present = readdirSync(fontsDir).filter((f) => f.endsWith(".woff2"));
  } catch {
    // No fonts folder yet.
  }
  for (const name of present) {
    if (want.has(name)) continue;
    try {
      rmSync(join(fontsDir, name));
      changed = true;
    } catch {
      // Leave it; a stray font is harmless.
    }
  }
  if (!files.length) return changed;
  mkdirSync(fontsDir, { recursive: true });
  for (const file of files) changed = copyIfChanged(file, join(fontsDir, basename(file))) || changed;
  return changed;
}

/**
 * Copy a style from the library into the project's `.agents/design-systems` as
 * `<id>-custom`, for edits to land in the project. Anything else passes through
 * unchanged; an existing copy is left as-is and its own index read back.
 */
export function forkSystem(system: DesignSystemInfo, projectPath: string): DesignSystemInfo {
  // A bundled or installed kit is never edited in place, and copying one comes with System mode.
  if (system.source === "kit") throw new Error("This kit can't be edited yet.");
  if (system.source !== "style") return system;
  const base = system.id.slice(STYLE_PREFIX.length);
  if (!/^[\w.-]+$/.test(base)) throw new Error("Can't copy this design system.");
  const folder = `${base}-custom`;
  const dir = join(projectPath, ".agents", "design-systems", folder);
  const index = join(dir, "index.md");
  const designMd = join(dir, "DESIGN.md");
  const tokensCss = join(dir, "tokens.css");

  if (isFile(index) && isFile(designMd)) {
    const parsed = parseSystemIndex(readText(index) ?? "");
    const fontFiles = fontsIn(dir);
    return {
      id: `project:${folder}`,
      name: parsed.name || folder,
      description: parsed.description || "",
      swatches: parsed.swatches,
      source: "projectFolder",
      designMd,
      ...(isFile(tokensCss) ? { tokensCss } : {}),
      ...(fontFiles.length ? { fontFiles } : {}),
    };
  }

  mkdirSync(dir, { recursive: true });
  const lines = ["---", "type: design-system", `name: ${system.name} (custom)`];
  if (system.description) lines.push(`description: ${system.description}`);
  if (system.swatches.length) lines.push(`swatches: ${system.swatches.join(", ")}`);
  lines.push("---", "", `A copy of ${system.name}, edited in CubiQ's System tab. Rules in \`DESIGN.md\`, tokens in \`tokens.css\`.`, "");
  writeFileSync(index, lines.join("\n"));
  copyFileSync(system.designMd, designMd);
  if (system.tokensCss) copyFileSync(system.tokensCss, tokensCss);
  // A style's faces travel with the copy, so its tokens.css keeps finding them.
  if (system.fontFiles?.length) {
    mkdirSync(join(dir, "fonts"), { recursive: true });
    for (const file of system.fontFiles) copyFileSync(file, join(dir, "fonts", basename(file)));
  }
  const fontFiles = fontsIn(dir);

  return {
    id: `project:${folder}`,
    name: `${system.name} (custom)`,
    description: system.description,
    swatches: system.swatches,
    source: "projectFolder",
    designMd,
    ...(isFile(tokensCss) ? { tokensCss } : {}),
    ...(fontFiles.length ? { fontFiles } : {}),
  };
}

/** The .woff2 files in a system folder's `fonts/`, absolute and sorted; [] when it has none. */
function fontsIn(dir: string): string[] {
  try {
    return readdirSync(join(dir, "fonts"))
      .filter((f) => f.endsWith(".woff2"))
      .sort()
      .map((f) => join(dir, "fonts", f));
  } catch {
    return [];
  }
}
