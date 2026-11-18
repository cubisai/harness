// Creator page themes: local inherited assets only; the model supplies token values, never code or paths.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { stableStringify } from "../cache-policy";
import type { DesignSystemInfo } from "../design/systems";
import { parseTokens, setToken } from "../design/tokens";
import type { ThemeDraft } from "../extensions/manifest";
import type { ThemeTokenOverride } from "../../shared/types";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CSS = 128 * 1024;
const BASE_ID = /^(?:kit:[a-z0-9-]+(?:\/[a-z0-9-]+)?|project:[a-z0-9-]+)$/;
export interface ThemeFile { path: string; content: Buffer }
type Resolver = (id: string) => DesignSystemInfo | null;

function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function exact(v: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new Error("Unexpected theme configuration field.");
}
function label(v: unknown, max: number, required = true): string {
  if (typeof v !== "string" || v.length > max || /[\r\n\0]/.test(v) || (required && !v.trim())) throw new Error("Invalid theme title or description.");
  return v.trim();
}

/** Strict atomic validation against this base's existing tokens, including dependencies in each scheme. */
export function validateThemeConfig(input: unknown, css: string): { title: string; description: string; base: string; tokens: ThemeTokenOverride[] } {
  if (!record(input)) throw new Error("Theme config must be an object.");
  exact(input, ["title", "description", "base", "tokens"]);
  const title = label(input.title, 120);
  const description = input.description === undefined ? "" : label(input.description, 500, false);
  if (typeof input.base !== "string" || !BASE_ID.test(input.base)) throw new Error("Choose an available local kit or project theme ID.");
  if (typeof css !== "string" || Buffer.byteLength(css) > MAX_CSS) throw new Error("Theme token file is too large.");
  const known = new Map(parseTokens(css).flatMap((g) => g.tokens.map((t) => [t.name, t] as const)));
  if (!Array.isArray(input.tokens) || !input.tokens.length || input.tokens.length > 64) throw new Error("Give 1–64 token overrides.");
  const seen = new Set<string>();
  const tokens = input.tokens.map((t): ThemeTokenOverride => {
    if (!record(t)) throw new Error("Invalid token override.");
    exact(t, ["name", "scheme", "value"]);
    if (typeof t.name !== "string" || !known.has(t.name)) throw new Error(`Unknown token ${String(t.name)}.`);
    if (t.scheme !== "light" && t.scheme !== "dark") throw new Error("Token scheme must be light or dark.");
    if (t.scheme === "light" && !known.get(t.name)!.light) throw new Error(`No light value for ${t.name}.`);
    const key = `${t.scheme}:${t.name}`;
    if (seen.has(key)) throw new Error(`Duplicate override ${key}.`);
    seen.add(key);
    if (typeof t.value !== "string" || !t.value.trim() || t.value.length > 200 || /[;{}\x00-\x1f\x7f\\<>@!]|\/\*|\*\/|(?:url|image-set|expression|paint)\s*\(/i.test(t.value)) throw new Error(`Invalid token value for ${t.name}.`);
    const value = t.value.trim();
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) if (!known.has(m[1]!)) throw new Error(`Unknown token reference ${m[1]}.`);
    // Reject malformed var() rather than allowing a network-bearing value hidden in CSS escapes/comments.
    if (/var\s*\(/i.test(value) && !/var\(\s*--[\w-]+(?:\s*,[^()]*)?\s*\)/.test(value)) throw new Error("Invalid token reference.");
    return { name: t.name, scheme: t.scheme, value };
  }).sort((a, b) => `${a.name}:${a.scheme}`.localeCompare(`${b.name}:${b.scheme}`));
  for (const scheme of ["light", "dark"] as const) {
    const values = new Map([...known].map(([name, t]) => [name, scheme === "dark" ? t.dark ?? t.light : t.light]));
    for (const t of tokens) if (t.scheme === scheme) values.set(t.name, t.value);
    const done = new Set<string>();
    const visit = (name: string, path: Set<string>): void => {
      if (path.has(name)) throw new Error(`Cyclic token reference ${name}.`);
      if (done.has(name)) return;
      const next = new Set(path).add(name);
      for (const m of (values.get(name) ?? "").matchAll(/var\(\s*(--[\w-]+)/g)) if (known.has(m[1]!)) visit(m[1]!, next);
      done.add(name);
    };
    for (const t of tokens) if (t.scheme === scheme) visit(t.name, new Set());
  }
  return { title, description, base: input.base, tokens };
}

/** Reads only trusted resolver paths. Every inherited file and each nested directory must be plain and contained. */
function sourceFiles(system: DesignSystemInfo): ThemeFile[] {
  if (!system.tokensCss) throw new Error("This theme has no tokens.css.");
  const files: ThemeFile[] = [];
  let bytes = 0;
  const add = (path: string, file: string, root = dirname(file)): void => {
    const rel = relative(realpathSync(root), realpathSync(file));
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || lstatSync(root).isSymbolicLink()) throw new Error("Theme source escapes its folder or is a symlink.");
    let cursor = root;
    for (const segment of relative(root, file).split(/[\\/]/)) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("Theme source is a symlink.");
    }
    const st = lstatSync(file);
    if (!st.isFile()) throw new Error("Theme source must be a regular file.");
    bytes += st.size;
    if (bytes > MAX_BYTES || files.length >= 128) throw new Error("Theme source exceeds its size limit.");
    if (files.some((f) => f.path.toLowerCase() === path.toLowerCase())) throw new Error("Duplicate theme asset path.");
    files.push({ path, content: readFileSync(file) });
  };
  add("tokens.css", system.tokensCss);
  add("DESIGN.md", system.designMd);
  for (const font of system.fontFiles ?? []) {
    if (!/^[\w.-]+\.woff2$/.test(basename(font))) throw new Error("Invalid theme font name.");
    add(`fonts/${basename(font)}`, font);
  }
  if (system.kit) {
    const root = system.kit.dir;
    for (const path of ["ui.css", "ui.js", "components.json", "migrations.json"]) {
      try { lstatSync(join(root, path)); } catch { continue; }
      add(path, join(root, path), root);
    }
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
        const path = `${rel}/${entry.name}`;
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) throw new Error("Theme asset is a symlink or hidden file.");
        if (entry.isDirectory()) walk(path);
        else if (/\.(?:html|css|js|json|md|svg|png)$/.test(path)) add(path, join(root, path), root);
        else throw new Error("Unsupported inherited theme asset.");
      }
    };
    try { lstatSync(join(root, "blocks")); } catch { return files.sort((a, b) => a.path.localeCompare(b.path)); }
    if (lstatSync(join(root, "blocks")).isSymbolicLink()) throw new Error("Theme blocks folder is a symlink.");
    walk("blocks");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function fingerprint(files: ThemeFile[]): string {
  return createHash("sha256").update(stableStringify(files.map((f) => ({ path: f.path, sha256: createHash("sha256").update(f.content).digest("hex") })))).digest("hex");
}

export function prepareTheme(name: string, input: unknown, resolve: Resolver): ThemeDraft {
  if (!record(input) || typeof input.base !== "string" || !BASE_ID.test(input.base)) throw new Error("Choose an available local theme ID.");
  const system = resolve(input.base);
  if (!system) throw new Error("That base theme is not available locally.");
  const files = sourceFiles(system);
  const baseCss = files.find((f) => f.path === "tokens.css")!.content.toString("utf8");
  const config = validateThemeConfig(input, baseCss);
  return { kind: "theme", name, ...config, baseName: system.name, baseCss, sourceDigest: fingerprint(files) };
}

/** Revalidates the persisted draft, not just the model-facing configuration. */
export function validateThemeDraft(input: Record<string, unknown>): ThemeDraft {
  exact(input, ["kind", "name", "title", "description", "base", "tokens", "baseName", "baseCss", "sourceDigest"]);
  if (typeof input.baseCss !== "string" || typeof input.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceDigest) || typeof input.name !== "string") throw new Error("Invalid reviewed theme source.");
  const config = validateThemeConfig({ title: input.title, description: input.description, base: input.base, tokens: input.tokens }, input.baseCss);
  return { kind: "theme", name: input.name, ...config, baseName: label(input.baseName, 240), baseCss: input.baseCss, sourceDigest: input.sourceDigest };
}

/** Deterministic files for preview/install; refuses a changed base before any destination write. */
export function readThemeFiles(draft: ThemeDraft, resolve: Resolver): ThemeFile[] {
  const system = resolve(draft.base);
  if (!system) throw new Error("Base theme is no longer available; create a new proposal.");
  const files = sourceFiles(system);
  if (fingerprint(files) !== draft.sourceDigest) throw new Error("Base theme changed after review; create a new proposal.");
  let css = files.find((f) => f.path === "tokens.css")!.content.toString("utf8");
  const config = validateThemeConfig({ title: draft.title, description: draft.description, base: draft.base, tokens: draft.tokens }, css);
  for (const t of config.tokens) css = setToken(css, t.name, t.scheme, t.value);
  const generated = files.map((f) => {
    if (f.path === "tokens.css") return { ...f, content: Buffer.from(css) };
    if (f.path === "components.json") {
      const manifest = JSON.parse(f.content.toString()) as { compat?: object };
      manifest.compat = { ...manifest.compat, themes: [] };
      return { ...f, content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") };
    }
    return f;
  });
  const index = `---\ntype: ${system.kit ? "design-kit" : "design-system"}\nname: ${JSON.stringify(draft.title)}\ndescription: ${JSON.stringify(draft.description)}\n---\n\nSaved from ${draft.baseName}.\n`;
  return [...generated, { path: "index.md", content: Buffer.from(index) }];
}
