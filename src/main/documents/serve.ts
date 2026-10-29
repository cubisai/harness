// cubiq-doc:// serves a thread's folder to the hidden window that prints its
// HTML documents to PDF: that folder only (realpath-checked), no scripts and no
// network, so a page can't reach anything the user didn't put next to it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveInside } from "../artifacts";
import { contentTypeOf } from "../design/serve";

export const DOC_SCHEME = "cubiq-doc";

/** The CSP on every document response: the folder's own files and inline styles; no scripts, no fetches. */
export function documentCsp(): string {
  return "default-src cubiq-doc: data: blob:; script-src 'none'; style-src cubiq-doc: 'unsafe-inline'; img-src cubiq-doc: data: blob:; font-src cubiq-doc: data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
}

/** The URL of `rel` in `threadId`'s folder. */
export function documentUrl(threadId: string, rel: string): string {
  return `${DOC_SCHEME}://${threadId}/${rel.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
}

/** Answers one cubiq-doc:// request from the thread's folder, or 404. */
export function serveDocument(url: string, folderOf: (threadId: string) => string | null): Response {
  try {
    const u = new URL(url);
    const root = folderOf(u.hostname);
    const rel = root ? resolveInside(root, decodeURIComponent(u.pathname.replace(/^\/+/, ""))) : null;
    if (!root || !rel) return new Response(null, { status: 404 });
    return new Response(readFileSync(join(root, rel)), { headers: { "content-type": contentTypeOf(rel), "content-security-policy": documentCsp() } });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/** The number of pages in a PDF, from its page objects. */
export function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}
