import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { resolveInside } from "./artifacts";
import type { LinkMeta } from "../shared/types";

/**
 * Pictures for `ui:cards` rows (a remote image, or a web page's `og:image`) and
 * reply link chips and cards (a page's site name, title, description, favicon and preview image).
 * Only public https hosts are reached. The address check runs inside the
 * socket's own DNS lookup, so the checked address is the one connected to
 * (no rebinding window), and again on every redirect hop. Bodies are read as
 * bytes, capped, and cached by URL (misses too).
 */

/** Largest image accepted, in bytes. */
export const IMAGE_MAX = 2 * 1024 * 1024;
/** Most HTML read while looking for `og:image` or link metadata. */
const PAGE_MAX = 512 * 1024;
const TIMEOUT_MS = 8_000;
const REDIRECTS_MAX = 3;
const CACHE_MAX = 200;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
/** Largest favicon accepted, in bytes. */
const ICON_MAX = 64 * 1024;
const ICON_TYPES = new Set([...IMAGE_TYPES, "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"]);

/** Whether an IP address is on the public internet (not loopback, private, link-local, CGNAT, multicast or reserved). */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return false;
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 2001:db8::/32 documentation.
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8")) return false;
    return true;
  }
  return false;
}

/** A URL this module may fetch: https, no credentials, a host that is not an IP literal or a local name. */
export function fetchableUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || !host.includes(".") || /\.(local|localhost|internal|lan|home|arpa)$/i.test(host)) return null;
  return url;
}

/** The socket's DNS lookup, refusing any answer that is not a public address. */
function publicLookup(hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    if (!list.length || !list.every((a) => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: "EPRIVATE" }), "");
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

type Fetched = { type: string; body: Buffer; url: URL };

/**
 * One GET, following up to REDIRECTS_MAX redirects (each re-checked). Past `max`
 * bytes it fails, or with `truncate` keeps the first `max` bytes (a page's
 * `<head>` is all that's needed).
 */
function get(url: URL, max: number, accept: string, hops = 0, truncate = false): Promise<Fetched | null> {
  return new Promise((resolve) => {
    const req = request(url, { method: "GET", lookup: publicLookup as never, timeout: TIMEOUT_MS, headers: { accept, "user-agent": "CubiQ link preview" } }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = hops < REDIRECTS_MAX ? fetchableUrl(new URL(res.headers.location, url).toString()) : null;
        resolve(next ? get(next, max, accept, hops + 1, truncate) : null);
        return;
      }
      if (status !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > max && !truncate) {
        res.destroy();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        chunks.push(chunk);
        if (size > max) {
          res.destroy();
          resolve(truncate ? { type, body: Buffer.concat(chunks).subarray(0, max), url } : null);
        }
      });
      res.on("end", () => resolve({ type, body: Buffer.concat(chunks), url }));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** The page's `og:image` (or `twitter:image`) URL, resolved against the page. */
export function ogImage(html: string, base: URL): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']?(og:image(?::secure_url)?|og:image:url|twitter:image(?::src)?)["'\s>]/i.exec(tag);
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (key && value) {
      try {
        return new URL(value.replace(/&amp;/g, "&"), base).toString();
      } catch {
        // try the next tag
      }
    }
  }
  return null;
}

/** Decode the HTML entities a page's `<head>` is likely to use (`&amp;`, `&#39;`, `&#x2014;`). */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Text from a `<head>` value: entities decoded, whitespace collapsed and trimmed; empty is null. */
function cleanText(value: string | null): string | null {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  return text || null;
}

/** A title or description cut to `max` characters, with an ellipsis when it was longer. */
function capped(value: string | null, max: number): string | null {
  return value && value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The `content` of the first `<meta>` whose property or name matches `key`. */
function metaContent(html: string, key: RegExp): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!name || !key.test(name[1] ?? name[2] ?? name[3] ?? "")) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (value !== undefined) return value;
  }
  return null;
}

/** The page's `<title>` text, or null when there is none. */
function titleText(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return match ? match[1]! : null;
}

/** The first icon `<link>`'s href, preferring a PNG one; null when the page has no icon link. */
function iconHref(html: string): string | null {
  let fallback: string | null = null;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const relValue = rel?.[1] ?? rel?.[2] ?? rel?.[3];
    if (!relValue || !/\bicon\b/i.test(relValue)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const hrefValue = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!hrefValue) continue;
    if (/\bpng\b/i.test(hrefValue) || /\btype\s*=\s*["']?image\/png/i.test(tag)) return hrefValue;
    fallback ??= hrefValue;
  }
  return fallback;
}

/** What a reply link chip shows, parsed from a page's `<head>`; `iconUrl` falls back to /favicon.ico. */
export function pageMeta(html: string, base: URL): { siteName: string | null; title: string | null; description: string | null; iconUrl: string } {
  const siteName = cleanText(metaContent(html, /^og:site_name$/i));
  const title = cleanText(metaContent(html, /^og:title$/i)) ?? cleanText(metaContent(html, /^twitter:title$/i)) ?? cleanText(titleText(html));
  const description = cleanText(metaContent(html, /^og:description$/i)) ?? cleanText(metaContent(html, /^twitter:description$/i)) ?? cleanText(metaContent(html, /^description$/i));
  const href = iconHref(html);
  let iconUrl = new URL("/favicon.ico", base).toString();
  if (href) {
    try {
      iconUrl = new URL(decodeEntities(href), base).toString();
    } catch {
      // an unusable href keeps the default
    }
  }
  return { siteName, title: capped(title, 200), description: capped(description, 400), iconUrl };
}

/** A favicon as a data URL, or null when it isn't a fetchable, small enough image. */
async function iconData(raw: string): Promise<string | null> {
  const url = fetchableUrl(raw);
  if (!url) return null;
  const got = await get(url, ICON_MAX, "image/png,image/x-icon,image/svg+xml,image/*;q=0.8");
  if (!got || !ICON_TYPES.has(got.type) || !got.body.length) return null;
  return `data:${got.type};base64,${got.body.toString("base64")}`;
}

/** An image as a data URL, or null when it isn't a fetchable, small enough raster image. */
async function imageData(raw: string): Promise<string | null> {
  const url = fetchableUrl(raw);
  if (!url) return null;
  const got = await get(url, IMAGE_MAX, "image/avif,image/webp,image/png,image/jpeg,image/gif");
  if (!got || !IMAGE_TYPES.has(got.type) || !got.body.length) return null;
  return `data:${got.type};base64,${got.body.toString("base64")}`;
}

/** A page's preview image as a data URL: its `og:image`, or the URL itself when it is an image. */
async function pageImage(raw: string): Promise<string | null> {
  const url = fetchableUrl(raw);
  if (!url) return null;
  const got = await get(url, PAGE_MAX, "text/html,image/*;q=0.8", 0, true);
  if (!got) return null;
  // A page URL that is itself an image: fetch it whole (the page read stops at PAGE_MAX).
  if (IMAGE_TYPES.has(got.type)) return imageData(got.url.toString());
  if (got.type !== "text/html") return null;
  const og = ogImage(got.body.toString("utf8"), got.url);
  return og ? imageData(og) : null;
}

/** A page's link metadata, or null when it isn't a fetchable HTML page; a missing icon or image only nulls that field. */
async function pageMetaOf(raw: string): Promise<LinkMeta | null> {
  const url = fetchableUrl(raw);
  if (!url) return null;
  const got = await get(url, PAGE_MAX, "text/html", 0, true);
  if (!got || got.type !== "text/html") return null;
  const html = got.body.toString("utf8");
  const meta = pageMeta(html, got.url);
  const og = ogImage(html, got.url);
  const [icon, image] = await Promise.all([iconData(meta.iconUrl).catch(() => null), og ? imageData(og).catch(() => null) : null]);
  return { siteName: meta.siteName, title: meta.title, description: meta.description, icon, image };
}

/** Cached pictures for card rows (`kind` "image" fetches the URL as an image, "page" its preview image) and reply link chips. */
export function createLinkPreviews(): {
  image(raw: string, kind: "image" | "page"): Promise<string | null>;
  meta(raw: string): Promise<LinkMeta | null>;
} {
  const cache = new Map<string, Promise<string | null>>();
  const metaCache = new Map<string, Promise<LinkMeta | null>>();
  return {
    image(raw, kind) {
      const key = `${kind}\0${raw}`;
      const hit = cache.get(key);
      if (hit) {
        // Refresh its place: the oldest entry is evicted first.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const pending = (kind === "image" ? imageData(raw) : pageImage(raw)).catch(() => null);
      cache.set(key, pending);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return pending;
    },
    meta(raw) {
      const hit = metaCache.get(raw);
      if (hit) {
        // Refresh its place: the oldest entry is evicted first.
        metaCache.delete(raw);
        metaCache.set(raw, hit);
        return hit;
      }
      const pending = pageMetaOf(raw).catch(() => null);
      metaCache.set(raw, pending);
      if (metaCache.size > CACHE_MAX) metaCache.delete(metaCache.keys().next().value!);
      return pending;
    },
  };
}

const LOCAL_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };

/** An image file inside `root` (a thread's folder) as a data URL; null when it escapes, isn't a raster image, or is too big. */
export function localImage(root: string, path: string): string | null {
  const rel = resolveInside(root, path);
  const type = rel ? LOCAL_TYPES[(/\.([^./\\]+)$/.exec(rel)?.[1] ?? "").toLowerCase()] : undefined;
  if (!rel || !type) return null;
  try {
    const full = join(root, rel);
    if (statSync(full).size > IMAGE_MAX) return null;
    return `data:${type};base64,${readFileSync(full).toString("base64")}`;
  } catch {
    return null;
  }
}
