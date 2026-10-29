import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DesignExportFormat } from "../../shared/types";
import { resolveInside } from "../artifacts";
import { inlineDesign } from "./inline";
import type { Shot } from "./shooter";

/** What an export needs from the app; injected so it stays testable. */
export interface DesignExportDeps {
  root(threadId: string): string | null;
  readVersion(threadId: string, rel: string, version: number): Buffer | null;
  url(threadId: string, rel: string, version: number | null): string;
  screenshot(url: string, opts: { width: number; height: number; fullPage: boolean }): Promise<Shot>;
  pdf(url: string, width: number): Promise<Buffer>;
}

export interface DesignExportInput {
  threadId: string;
  format: DesignExportFormat;
  /** The page, relative to the design folder. */
  rel: string;
  /** A saved version of the page, or null for the file as it is now. */
  version: number | null;
  /** The canvas viewport's width (PNG and PDF layout). */
  width: number;
}

const EXTENSIONS: Record<DesignExportFormat, string> = { html: "html", png: "png", pdf: "pdf" };

/** A file read from inside the design folder, or null when it is missing, a folder, or outside it. */
function readInside(root: string, rel: string): Buffer | null {
  const inside = resolveInside(root, rel);
  if (!inside) return null;
  try {
    const abs = join(root, inside);
    return statSync(abs).isFile() ? readFileSync(abs) : null;
  } catch {
    return null;
  }
}

/** The page's html: a saved version, or the file now. */
function readPage(deps: DesignExportDeps, input: DesignExportInput): string {
  const root = deps.root(input.threadId);
  if (!root) throw new Error("This thread has no design folder.");
  const bytes = input.version ? deps.readVersion(input.threadId, input.rel, input.version) : readInside(root, input.rel);
  if (!bytes) throw new Error(`${input.rel} not found.`);
  return bytes.toString("utf-8");
}

/** The default file name: the page's <title>, else `design-<id8>`, made safe on every OS. */
export function exportFileName(html: string | null, threadId: string, format: DesignExportFormat, version: number | null): string {
  const title = html ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "" : "";
  const clean = title
    .replace(/&amp;/g, "&")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  const base = clean || `design-${threadId.slice(0, 8)}`;
  return `${base}${version ? ` v${version}` : ""}.${EXTENSIONS[format]}`;
}

/** The page's html for naming the file, or null when it can't be read. */
export function pageTitleSource(deps: DesignExportDeps, input: DesignExportInput): string | null {
  try {
    return readPage(deps, input);
  } catch {
    return null;
  }
}

/**
 * Build one export of a design page: a single html file with its local
 * stylesheets, scripts and images inlined (the canvas bridge is never in it:
 * this reads the files, not the served page), a full-page PNG, or a PDF (the
 * page's own @page size wins, so a deck prints one slide per page).
 */
export async function buildDesignExport(deps: DesignExportDeps, input: DesignExportInput): Promise<Buffer> {
  if (input.format === "html") {
    const root = deps.root(input.threadId);
    if (!root) throw new Error("This thread has no design folder.");
    return Buffer.from(inlineDesign(readPage(deps, input), input.rel, (rel) => readInside(root, rel)), "utf-8");
  }
  // Fail early (with a clear message) when the page is gone.
  readPage(deps, input);
  const width = Math.min(2560, Math.max(320, Math.round(input.width) || 1440));
  const url = deps.url(input.threadId, input.rel, input.version);
  if (input.format === "png") return (await deps.screenshot(url, { width, height: 900, fullPage: true })).png;
  return deps.pdf(url, width);
}
