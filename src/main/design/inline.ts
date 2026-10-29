import { posix } from "node:path";
import { contentTypeOf } from "./serve";

/** Read a design-root-relative file (posix separators, already normalized), or null. */
export type ReadRel = (rel: string) => Buffer | null;

/** Resolve a CSS/url() reference against the file that contains it; null leaves it untouched. */
export function resolveRef(fromRel: string, ref: string): string | null {
  const raw = ref.trim();
  if (!raw) return null;
  if (raw.startsWith("#") || raw.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

  let clean = raw;
  const hash = clean.indexOf("#");
  if (hash !== -1) clean = clean.slice(0, hash);
  const query = clean.indexOf("?");
  if (query !== -1) clean = clean.slice(0, query);
  if (!clean) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  if (decoded.startsWith("/")) return null;

  const resolved = posix.normalize(posix.join(posix.dirname(fromRel), decoded));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) return null;
  return resolved;
}

/** A file's content as a base64 `data:` URI, dropping any `; charset=...` from the MIME type. */
export function dataUri(rel: string, bytes: Buffer): string {
  const mime = contentTypeOf(rel).split(";")[0]!.trim();
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Inline every resolvable `@import` and `url(...)` in a stylesheet. */
export function inlineCss(css: string, fromRel: string, read: ReadRel, seen?: Set<string>): string {
  const visited = seen ?? new Set<string>();
  visited.add(fromRel);

  const withImports = css.replace(IMPORT_RE, (match, q1, q2, q3, q4, q5, mediaPart) => {
    const path = (q1 ?? q2 ?? q3 ?? q4 ?? q5 ?? "").trim();
    const media = String(mediaPart ?? "").trim();
    const resolved = resolveRef(fromRel, path);
    if (!resolved) return match;
    if (visited.has(resolved) || visited.size >= 5) return "";
    const bytes = read(resolved);
    if (!bytes) return match;
    const inner = inlineCss(bytes.toString("utf-8"), resolved, read, visited);
    return media ? `@media ${media} { ${inner} }` : inner;
  });

  return inlineUrls(withImports, fromRel, read);
}

/** Inline every resolvable `url(...)` in a CSS fragment. */
function inlineUrls(css: string, fromRel: string, read: ReadRel): string {
  return css.replace(URL_RE, (match, q1, q2, q3) => {
    const ref = q1 ?? q2 ?? q3 ?? "";
    const resolved = resolveRef(fromRel, ref);
    if (!resolved) return match;
    const bytes = read(resolved);
    if (!bytes) return match;
    return `url("${dataUri(resolved, bytes)}")`;
  });
}

/** Inline a design HTML page's linked CSS, scripts, images, and other local assets. */
export function inlineDesign(html: string, htmlRel: string, read: ReadRel): string {
  // <style> blocks.
  let out = html.replace(/<\s*style\b([^>]*)>([\s\S]*?)<\s*\/\s*style\s*>/gi, (match, attrs: string, body: string) => {
    return `<style${attrs}>${inlineCss(body, htmlRel, read)}</style>`;
  });

  // <link rel="stylesheet"> and <link rel="icon">.
  out = out.replace(/<\s*link\b([^>]*?)\/?>/gi, (match, attrs: string) => {
    const rel = attrValue(attrs, "rel");
    if (!rel) return match;
    const kinds = rel.toLowerCase().split(/\s+/);
    const href = attrValue(attrs, "href");
    if (kinds.includes("stylesheet") && href) {
      const resolved = resolveRef(htmlRel, href);
      const bytes = resolved ? read(resolved) : null;
      if (resolved && bytes) {
        const media = attrValue(attrs, "media");
        const css = inlineCss(bytes.toString("utf-8"), resolved, read);
        return `<style${media ? ` media="${media}"` : ""}>${css}</style>`;
      }
    }
    if (kinds.includes("icon") && href) {
      const resolved = resolveRef(htmlRel, href);
      const bytes = resolved ? read(resolved) : null;
      if (resolved && bytes) return setAttr(match, "href", dataUri(resolved, bytes));
    }
    return match;
  });

  // <script src>.
  out = out.replace(/<\s*script\b([^>]*)>([\s\S]*?)<\s*\/\s*script\s*>/gi, (match, attrs: string) => {
    const src = attrValue(attrs, "src");
    if (!src) return match;
    const resolved = resolveRef(htmlRel, src);
    const bytes = resolved ? read(resolved) : null;
    if (!resolved || !bytes) return match;
    const js = bytes.toString("utf-8").replace(/<\/script/gi, "<\\/script");
    return `<script${removeAttr(attrs, "src")}>${js}</script>`;
  });

  // Media elements.
  out = out.replace(/<\s*(img|source|video|audio|input)\b([^>]*?)\/?>/gi, (match, tagName: string, attrs: string) => {
    if (tagName.toLowerCase() === "input") {
      const type = attrValue(attrs, "type");
      if (!type || type.toLowerCase() !== "image") return match;
    }
    let updated = replaceUrlAttr(match, "src", htmlRel, read);
    updated = replaceUrlAttr(updated, "poster", htmlRel, read);
    updated = replaceSrcset(updated, htmlRel, read);
    return updated;
  });

  // Inline style="" attributes.
  out = out.replace(/(\bstyle\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, (match, prefix: string, d, s, u) => {
    const value: string = d ?? s ?? u ?? "";
    const inlined = inlineUrls(value, htmlRel, read);
    if (inlined === value) return match;
    if (d !== undefined) return `${prefix}"${inlined}"`;
    if (s !== undefined) return `${prefix}'${inlined}'`;
    return `${prefix}${inlined}`;
  });

  return out;
}

/** The `@import` forms we inline: url() or bare string, optional media list. */
const IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;

/** `url(...)`, quoted or unquoted. */
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]*))\s*\)/gi;

/** Read an attribute value from a tag's attribute text, or null. */
function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`(^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, "i");
  const match = re.exec(attrs);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

/** Remove an attribute (and its value) from a tag string. */
function removeAttr(tag: string, name: string): string {
  const re = new RegExp(`(^|\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\\x60]+)`, "i");
  return tag.replace(re, "");
}

/** Set an attribute on a tag string, replacing it if present. */
function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`((?:^|\\s)${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'=<>\\x60]+)`, "i");
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  return tag.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
}

/** Replace one url-bearing attribute on a tag with a data URI, when it resolves. */
function replaceUrlAttr(tag: string, name: string, fromRel: string, read: ReadRel): string {
  const value = attrValue(tag, name);
  if (value === null) return tag;
  const resolved = resolveRef(fromRel, value);
  const bytes = resolved ? read(resolved) : null;
  if (!resolved || !bytes) return tag;
  return setAttr(tag, name, dataUri(resolved, bytes));
}

/** Replace a srcset with a single data URI of its first candidate, when it resolves. */
function replaceSrcset(tag: string, fromRel: string, read: ReadRel): string {
  const value = attrValue(tag, "srcset");
  if (value === null) return tag;
  const first = value.split(",")[0]?.trim() ?? "";
  const url = first.split(/\s+/)[0] ?? "";
  const resolved = resolveRef(fromRel, url);
  const bytes = resolved ? read(resolved) : null;
  if (!resolved || !bytes) return tag;
  return setAttr(tag, "srcset", dataUri(resolved, bytes));
}
