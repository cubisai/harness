import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";

/**
 * The shape of a design kit: a folder of HTML and CSS components that a design
 * thread drops into a page. This module is the contract and its validator. Kit
 * content is only ever read as text here, never run.
 */

/** Every ceiling a kit has to stay under. */
export const KIT_LIMITS = {
  /** The zip a kit arrives in. */
  archiveBytes: 10 * 1024 * 1024,
  /** What the zip expands to. */
  expandedBytes: 25 * 1024 * 1024,
  /** Files and folders together. */
  entries: 2000,
  /** One file. */
  fileBytes: 8 * 1024 * 1024,
  /** Expanded bytes over archive bytes; a zip bomb's tell. */
  maxRatio: 200,
  /** Folders deep. */
  maxDepth: 8,
  manifestBytes: 1024 * 1024,
  /** The kit's own script; it only drives previews. */
  uiJsBytes: 32 * 1024,
  snippetChars: 4096,
  components: 200,
  props: 32,
} as const;

/** The only file kinds a kit may hold. */
export const KIT_EXTENSIONS: readonly string[] = [".md", ".css", ".js", ".json", ".html", ".svg", ".woff2", ".png", ".jpg", ".webp"];

/** A lowercase slug: a kit id, a component's `data-ui`, a theme folder, a prop name. */
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a lowercase slug (a-z, 0-9, dashes)");

const propSchema = z.object({
  name: slugSchema,
  label: z.string().min(1).max(80),
  type: z.enum(["choice", "boolean", "text"]),
  options: z.array(z.string().min(1)).min(1).max(32).optional(),
  default: z.union([z.string(), z.boolean()]).optional(),
});

const componentSchema = z.object({
  name: z.string().min(1).max(80),
  /** The `data-ui` attribute value in the kit's HTML. */
  ui: slugSchema,
  kind: z.enum(["component", "composition"]).default("component"),
  category: z.string().max(40).optional(),
  description: z.string().max(300).optional(),
  props: z.array(propSchema).max(KIT_LIMITS.props).default([]),
  snippet: z.string().min(1).max(KIT_LIMITS.snippetChars),
  /** The real library import, for Code view and handoff. */
  import: z.object({ package: z.string().min(1).max(200), name: z.string().min(1).max(200) }).optional(),
  source: z.string().max(300).optional(),
});

/**
 * `components.json`: what a kit offers. Every refusal names its component,
 * because a kit is written by hand and one bad entry should be easy to find.
 */
export const kitManifestSchema = z
  .object({
    kitId: slugSchema,
    name: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be a version like 1.2.3"),
    contractVersion: z.string().regex(/^\d+\.\d+$/, "must be a contract version like 1.0"),
    /** The npm package the kit models, when it models one. */
    package: z.string().min(1).max(200).optional(),
    compat: z.object({
      /** A theme folder name, or "*" for every theme. */
      themes: z.array(z.string().min(1)),
      migratesFrom: z.array(slugSchema),
    }),
    components: z.array(componentSchema).min(1).max(KIT_LIMITS.components),
  })
  .superRefine((m, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: "custom", path: path.split("."), message });
    };
    m.compat.themes.forEach((theme, i) => {
      // "*" or a slug; checked here rather than as a union so an editor sees a plain string.
      if (theme !== "*" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(theme)) fail(`compat.themes.${i}`, `theme "${theme}" must be "*" or a lowercase slug`);
    });

    const seenUi = new Set<string>();
    m.components.forEach((c, i) => {
      if (seenUi.has(c.ui)) fail(`components.${i}.ui`, `another component already uses data-ui="${c.ui}"`);
      seenUi.add(c.ui);

      const seenProps = new Set<string>();
      c.props.forEach((p, j) => {
        const at = `components.${i}.props.${j}.name`;
        // A prop `foo` is written `data-foo`, so `ui` would clash with the component's own attribute.
        if (p.name === "ui") fail(at, `"${c.ui}" has a prop named "ui", which would clash with its data-ui attribute`);
        if (seenProps.has(p.name)) fail(at, `"${c.ui}" has two props named "${p.name}"`);
        seenProps.add(p.name);

        if (p.type === "choice") {
          if (!p.options) fail(`components.${i}.props.${j}`, `choice prop "${p.name}" of "${c.ui}" needs options`);
          else if (typeof p.default === "string" && !p.options.includes(p.default)) {
            fail(`components.${i}.props.${j}`, `default "${p.default}" of "${c.ui}" prop "${p.name}" is not one of its options`);
          }
        } else if (p.options) {
          fail(`components.${i}.props.${j}`, `${p.type} prop "${p.name}" of "${c.ui}" must not have options`);
        } else if (p.type === "boolean" && typeof p.default === "string") {
          fail(`components.${i}.props.${j}`, `boolean prop "${p.name}" of "${c.ui}" must default to true or false`);
        } else if (p.type === "text" && typeof p.default === "boolean") {
          fail(`components.${i}.props.${j}`, `text prop "${p.name}" of "${c.ui}" must default to a string`);
        }
      });

      // The snippet is what a page gets, so it has to carry the attribute ui.css styles.
      if (!c.snippet.includes(`data-ui="${c.ui}"`)) fail(`components.${i}.snippet`, `snippet of "${c.ui}" must contain data-ui="${c.ui}"`);
    });
  });

export type KitManifest = z.infer<typeof kitManifestSchema>;

/** The parsed manifest of a kit folder, or the reasons it is refused. */
export type KitResult = { ok: true; manifest: KitManifest } | { ok: false; errors: string[] };

/** Zod issues as `path: message`, the way a hand-written check would report them. */
function issues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/**
 * Parse `components.json`. Bad JSON, an oversize file or a broken field all
 * come back as errors; this never throws for a bad kit.
 */
export function parseKitManifest(text: string): KitResult {
  if (Buffer.byteLength(text, "utf-8") > KIT_LIMITS.manifestBytes) {
    return { ok: false, errors: [`components.json: over ${KIT_LIMITS.manifestBytes} bytes`] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`components.json: not valid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  const parsed = kitManifestSchema.safeParse(data);
  return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, errors: issues(parsed.error) };
}

const IN_URL = /url\(\s*['"]?([^'")\s]+)/gi;
const IN_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)/gi;
/** A URL-carrying attribute, in any of the three ways HTML writes a value. */
const IN_ATTR = /\b(?:src|href|srcset|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
const BARE_REMOTE = /https?:\/\/[^\s"'<>()]*/gi;
const IS_REMOTE = /^(?:https?:\/\/|\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i;
/** SVG's namespace is an identifier, not a fetch, so it is allowed everywhere. */
const W3_NAMESPACE = /^https?:\/\/www\.w3\.org(?:\/|$)/i;

/**
 * The remote references in `text`: absolute and protocol-relative URLs inside
 * url(), @import and anywhere else, except the SVG namespace. The canvas has
 * no network, so a kit with one of these would render half done.
 */
export function findRemoteUrls(text: string): string[] {
  const found = new Set<string>();
  const add = (raw: string): void => {
    const url = raw.trim();
    if (url && IS_REMOTE.test(url) && !W3_NAMESPACE.test(url)) found.add(url);
  };
  for (const m of text.matchAll(IN_URL)) add(m[1] ?? "");
  for (const m of text.matchAll(IN_IMPORT)) add(m[1] ?? "");
  for (const m of text.matchAll(IN_ATTR)) add(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of text.matchAll(BARE_REMOTE)) add(m[0]);
  return [...found];
}

const SCRIPT_TAG = /<\s*script\b/i;
const INLINE_HANDLER = /\son[a-z]+\s*=/i;
const JAVASCRIPT_URL = /javascript:/i;

/** Why `html` is unsafe to render as a kit block or snippet, or null when it is fine. */
function unsafeHtml(html: string): string | null {
  if (SCRIPT_TAG.test(html)) return "has a <script> tag";
  if (INLINE_HANDLER.test(html)) return "has an inline on* handler";
  if (JAVASCRIPT_URL.test(html)) return "has a javascript: URL";
  return null;
}

/** The scalar frontmatter fields of a markdown file, keys lowercased; empty without any. */
function frontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return fields;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return fields;
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields.set(m[1]!.toLowerCase(), value);
  }
  return fields;
}

/** What a walk of the kit folder found. */
interface KitTree {
  /** Folder-relative paths with forward slashes, and their sizes. */
  files: Map<string, number>;
  /** Folder-relative paths of the folders, so an expected one can be looked up. */
  dirs: Set<string>;
}

/**
 * Walk `dir` without following links, collecting every problem it meets. Links
 * and other odd entries are faults, not skipped: a kit ships plain files only.
 */
function walk(dir: string): { tree: KitTree; errors: string[] } {
  const tree: KitTree = { files: new Map(), dirs: new Set() };
  const errors: string[] = [];
  let count = 0;
  let total = 0;

  const visit = (abs: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      errors.push(`${rel || "."}: folder cannot be read (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    for (const entry of entries) {
      count++;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (count > KIT_LIMITS.entries) {
        errors.push(`${relPath}: the kit is over ${KIT_LIMITS.entries} entries`);
        return;
      }
      if (entry.isSymbolicLink()) {
        errors.push(`${relPath}: symbol links are not allowed in a kit`);
        continue;
      }
      if (entry.isDirectory()) {
        if (depth + 1 > KIT_LIMITS.maxDepth) {
          errors.push(`${relPath}/: folder is deeper than ${KIT_LIMITS.maxDepth}`);
          continue;
        }
        tree.dirs.add(relPath);
        visit(join(abs, entry.name), relPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        errors.push(`${relPath}: is not a plain file or folder`);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!KIT_EXTENSIONS.includes(ext)) {
        errors.push(`${relPath}: file type ${ext || "(none)"} is not allowed (allowed: ${KIT_EXTENSIONS.join(" ")})`);
        continue;
      }
      let size: number;
      try {
        // The size alone, because this runs on files before their size is known to be sane.
        size = statSync(join(abs, entry.name)).size;
      } catch (err) {
        errors.push(`${relPath}: file cannot be read (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      tree.files.set(relPath, size);
      total += size;
      if (size > KIT_LIMITS.fileBytes) errors.push(`${relPath}: ${size} bytes is over ${KIT_LIMITS.fileBytes}`);
      if (total > KIT_LIMITS.expandedBytes) {
        errors.push(`${relPath}: the kit is over ${KIT_LIMITS.expandedBytes} bytes expanded`);
        return;
      }
    }
  };

  visit(dir, "", 0);
  return { tree, errors };
}

/** A walked kit file as text, or null when it was not there or would not read. */
function readKit(dir: string, tree: KitTree, rel: string): string | null {
  if (!tree.files.has(rel)) return null;
  try {
    return readFileSync(join(dir, rel), "utf-8");
  } catch {
    return null;
  }
}

/** Accepts `[data-ui="x"]`, `[data-ui='x']` and `[data-ui=x]`, which all mean the same in CSS. */
function hasSelector(css: string, ui: string): boolean {
  return new RegExp(`\\[\\s*data-ui\\s*=\\s*(?:"${ui}"|'${ui}'|${ui})\\s*\\]`).test(css);
}

const REQUIRED_FILES = ["index.md", "DESIGN.md", "tokens.css", "ui.css", "components.json"] as const;

/**
 * Check the kit in `dir` against the contract, collecting every problem rather
 * than stopping at the first. A missing folder is an error, not a throw.
 */
export function validateKitDir(dir: string, expectedId?: string): KitResult {
  // A folder that is not there is a refusal like any other, never a throw.
  try {
    readdirSync(dir);
  } catch (err) {
    return { ok: false, errors: [`${dir}: kit folder cannot be read (${err instanceof Error ? err.message : String(err)})`] };
  }

  const { tree, errors } = walk(dir);
  const problems: string[] = [...errors];

  for (const name of REQUIRED_FILES) {
    if (!tree.files.has(name)) problems.push(`${name}: required file is missing`);
  }

  const index = readKit(dir, tree, "index.md");
  if (index !== null && frontmatter(index).get("type") !== "design-kit") {
    problems.push("index.md: frontmatter must have type: design-kit");
  }

  const raw = readKit(dir, tree, "components.json");
  const parsed = raw === null ? null : parseKitManifest(raw);
  const manifest = parsed?.ok ? parsed.manifest : null;
  if (parsed && !parsed.ok) problems.push(...parsed.errors);
  if (manifest && expectedId !== undefined && manifest.kitId !== expectedId) {
    problems.push(`components.json: kitId "${manifest.kitId}" does not match "${expectedId}"`);
  }

  const tokens = readKit(dir, tree, "tokens.css");
  if (tokens !== null) {
    if (!tokens.includes("--color-bg:")) problems.push("tokens.css: must define --color-bg:");
    if (!tokens.includes("--color-text:")) problems.push("tokens.css: must define --color-text:");
  }

  // Remote URLs and markup that could run, in every file the canvas renders.
  for (const [rel, size] of tree.files) {
    const ext = extname(rel).toLowerCase();
    if (ext !== ".css" && ext !== ".js" && ext !== ".html" && ext !== ".svg") continue;
    if (size > KIT_LIMITS.fileBytes) continue;
    const text = readKit(dir, tree, rel);
    if (text === null) continue;
    for (const url of findRemoteUrls(text)) problems.push(`${rel}: remote URL ${url} (the canvas has no network)`);
    // An SVG is markup too: opened directly, it can run its own script.
    if (ext === ".html" || ext === ".svg") {
      const bad = unsafeHtml(text);
      if (bad) problems.push(`${rel}: ${bad}`);
    }
  }

  const uiJs = tree.files.get("ui.js");
  if (uiJs !== undefined && uiJs > KIT_LIMITS.uiJsBytes) problems.push(`ui.js: ${uiJs} bytes is over ${KIT_LIMITS.uiJsBytes}`);

  if (manifest) {
    for (const c of manifest.components) {
      const bad = unsafeHtml(c.snippet);
      if (bad) problems.push(`components.json: snippet of "${c.ui}" ${bad}`);
      for (const url of findRemoteUrls(c.snippet)) {
        problems.push(`components.json: snippet of "${c.ui}" has remote URL ${url}`);
      }
    }

    const css = readKit(dir, tree, "ui.css");
    if (css !== null) {
      for (const c of manifest.components) {
        if (c.kind === "component" && !hasSelector(css, c.ui)) {
          problems.push(`ui.css: no [data-ui="${c.ui}"] selector for "${c.name}"`);
        }
      }
    }

    for (const theme of manifest.compat.themes) {
      if (theme === "*") continue;
      if (!tree.files.has(`themes/${theme}/tokens.css`)) {
        problems.push(`components.json: theme "${theme}" has no themes/${theme}/tokens.css`);
      }
    }
  }

  if (problems.length) return { ok: false, errors: problems };
  if (!manifest) return { ok: false, errors: ["components.json: could not be read"] };
  return { ok: true, manifest };
}
