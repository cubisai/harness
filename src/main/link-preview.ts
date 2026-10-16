import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { resolveInside } from "./artifacts";

/**
 * Pictures for `ui:cards` rows: a remote image, or a web page's `og:image`.
 * Only public https hosts are reached. The address check runs inside the
 * socket's own DNS lookup, so the checked address is the one connected to
 * (no rebinding window), and again on every redirect hop. Results are image
 * bytes only, capped, and cached by URL (misses too).
 */

/** Largest image accepted, in bytes. */
export const IMAGE_MAX = 2 * 1024 * 1024;
/** Most HTML read while looking for `og:image`. */
const PAGE_MAX = 512 * 1024;
const TIMEOUT_MS = 8_000;
const REDIRECTS_MAX = 3;
const CACHE_MAX = 200;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

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

/** Cached pictures for card rows; `kind` "image" fetches the URL as an image, "page" its preview image. */
export function createLinkPreviews(): { image(raw: string, kind: "image" | "page"): Promise<string | null> } {
  const cache = new Map<string, Promise<string | null>>();
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
