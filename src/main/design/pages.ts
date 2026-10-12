import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveInside } from "../artifacts";
import { isVariant } from "../../shared/design";

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