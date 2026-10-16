import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveInside } from "../artifacts";
import { isVariant } from "../../shared/design";
import type { DesignDevice } from "../../shared/types";

/** How many pages one design folder can hold; a listing past this is a bug, not a design. */
export const MAX_PAGES = 40;

const HTML_RE = /\.html?$/i;

/** True when `path` names an existing regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The design folder's pages: `index.html` first, then the other pages, then the
 * variants. Only files in the folder's root count (never `system/` or `refs/`),
 * and nothing here throws on a missing or unreadable folder.
 */
export function listDesignPages(root: string): string[] {
  let entries: { name: string; isFile: boolean }[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() }));
  } catch {
    return [];
  }
  const pages = entries
    .filter((e) => e.isFile && !e.name.startsWith(".") && HTML_RE.test(e.name))
    .map((e) => e.name);
  const index = pages.filter((n) => n === "index.html");
  const byName = (a: string, b: string): number => a.localeCompare(b);
  const rest = pages.filter((n) => n !== "index.html").sort(byName);
  return [...index, ...rest.filter((n) => !isVariant(n)), ...rest.filter(isVariant)].slice(0, MAX_PAGES);
}

/**
 * Make the variant `rel` the design's main page: the current `index.html` is
 * recorded as a version first, then the variant's bytes take its place. The
 * variant file itself stays, so the choice can be undone.
 */
export function promoteVariant(root: string, rel: string, record: (rel: string) => void): void {
  if (!isVariant(rel)) throw new Error("Not a variant.");
  const index = join(root, "index.html");
  if (resolveInside(root, rel) !== rel || !isFile(join(root, rel))) throw new Error("No such variant.");
  // Record before copying, so the version store holds the page the variant replaces.
  if (existsSync(index)) record("index.html");
  copyFileSync(join(root, rel), index);
  record("index.html");
}
/**
 * The frame a page asks to be drawn in: its `<meta name="cubiq-device" content="mobile">`, else "mobile" for a
 * one-screen phone page (a status bar plus a tab bar or home indicator, at most one `.phone`, and no `.board` backdrop
 * of several phones), else null.
 */
export function pageDevice(html: string): DesignDevice | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']?cubiq-device["'\s>]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']?\s*([a-z]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (content === "mobile" || content === "tablet" || content === "desktop" || content === "slide") return content;
  }
  const classes = new Map<string, number>();
  for (const m of html.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gi)) {
    for (const c of (m[2] ?? "").split(/\s+/)) if (c) classes.set(c, (classes.get(c) ?? 0) + 1);
  }
  const has = (c: string): boolean => (classes.get(c) ?? 0) > 0;
  if (has("status-bar") && (has("home-indicator") || has("tab-bar")) && (classes.get("phone") ?? 0) <= 1 && !has("board")) return "mobile";
  return null;
}
