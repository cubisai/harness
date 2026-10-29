import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { resolveInside } from "../artifacts";

/** The custom scheme design pages and their assets are served under. */
export const DESIGN_SCHEME = "cubiq-design";

export { designDirName } from "../../shared/design";

/** The URL a design page or asset is reached at; a positive `version` names a saved copy. */
export function designUrl(threadId: string, rel: string, version?: number | null): string {
  const path = rel.split("/").map(encodeURIComponent).join("/");
  const base = `${DESIGN_SCHEME}://d/${encodeURIComponent(threadId)}/${path}`;
  return typeof version === "number" && Number.isInteger(version) && version > 0 ? `${base}?v=${version}` : base;
}

/** A parsed design URL, or null when it is malformed or tries to leave the design folder. */
export function parseDesignUrl(url: string): { threadId: string; rel: string; version: number | null } | null {
  try {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(?:#[\s\S]*)?$/i.exec(url);
    if (!match) return null;
    if (match[1]!.toLowerCase() !== DESIGN_SCHEME || match[2] !== "d") return null;

    const segments = (match[3] ?? "").replace(/^\/+/, "").split("/").map(decodeURIComponent);
    for (const segment of segments) {
      if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return null;
    }
    const threadId = segments[0] ?? "";
    const rel = segments.slice(1).join("/");
    if (!threadId || !rel) return null;

    const query = match[4];
    let version: number | null = null;
    if (query !== undefined) {
      const raw = new URLSearchParams(query).get("v");
      if (raw !== null) {
        if (!/^\d+$/.test(raw)) return null;
        version = Number.parseInt(raw, 10);
        if (version <= 0) return null;
      }
    }
    return { threadId, rel, version };
  } catch {
    return null;
  }
}

/** The sandbox CSP for every design response: the scheme's own files, and inline assets. */
export function designCsp(): string {
  return "default-src cubiq-design: data: blob:; script-src cubiq-design: 'unsafe-inline'; style-src cubiq-design: 'unsafe-inline'; img-src cubiq-design: data: blob:; font-src cubiq-design: data:; media-src cubiq-design: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
}

/** The content type served for a design path, by its lowercase extension. */
export function contentTypeOf(rel: string): string {
  const ext = extname(rel).replace(/^\./, "").toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

/** Response headers for a design file: sandboxed, same-scheme only, never cached. */
export function designHeaders(rel: string): Record<string, string> {
  return {
    "Content-Type": contentTypeOf(rel),
    "Content-Security-Policy": designCsp(),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Insert the bridge script right after `<head>`, else `<html>`, else at the very start. */
export function injectBridge(html: string, script: string): string {
  const tag = `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length);
  return tag + html;
}

/** `index.html` if present in `root`, else the newest direct `*.html`/`*.htm`, else null. */
export function entryFile(root: string): string | null {
  try {
    if (!statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  if (existsSync(join(root, "index.html"))) return "index.html";
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { name: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name.toLowerCase();
    if (!name.endsWith(".html") && !name.endsWith(".htm")) continue;
    try {
      const mtime = statSync(join(root, entry.name)).mtimeMs;
      if (!best || mtime > best.mtime) best = { name: entry.name, mtime };
    } catch {
      // Gone between readdir and stat.
    }
  }
  return best ? best.name : null;
}

/** The main-process services the design server leans on; injected so it stays testable. */
export interface DesignDeps {
  designRoot(threadId: string): string | null;
  readVersion(threadId: string, rel: string, version: number): Buffer | null;
  bridge: string;
}

/** Serve one design request: a file on disk, or a saved version; never throws. */
export function serveDesign(url: string, deps: DesignDeps): Response {
  try {
    const parsed = parseDesignUrl(url);
    if (!parsed) return notFound();
    const { threadId, rel, version } = parsed;

    let root: string | null;
    try {
      root = deps.designRoot(threadId);
    } catch {
      return notFound();
    }
    if (!root) return notFound();

    let body: Buffer;
    if (version !== null) {
      // A file that is gone still resolves for a saved version, as long as its path can't escape.
      if (!resolveInside(root, rel) && !versionableRel(rel)) return notFound();
      const read = deps.readVersion(threadId, rel, version);
      if (!read) return notFound();
      body = read;
    } else {
      const r = resolveInside(root, rel);
      if (!r) return notFound();
      const abs = join(realpathSync(root), r);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        return notFound();
      }
      if (!stat.isFile()) return notFound();
      body = readFileSync(abs);
    }

    let payload: string | Uint8Array<ArrayBuffer>;
    if (contentTypeOf(rel).startsWith("text/html")) {
      payload = injectBridge(body.toString("utf-8"), deps.bridge);
    } else {
      const binary = new Uint8Array(body.byteLength);
      binary.set(body);
      payload = binary;
    }
    return new Response(payload, { status: 200, headers: designHeaders(rel) });
  } catch {
    return notFound();
  }
}

/** A version path stays usable after its file is gone, as long as it can't escape. */
function versionableRel(rel: string): boolean {
  return !isAbsolute(rel) && !rel.split("/").includes("..");
}

/** Every miss in this module is an empty 404. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}
