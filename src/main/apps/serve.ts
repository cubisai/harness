// cubiq-app://a/<key>/<path>: an app's folder, served to its sandboxed frame. The bridge script is injected into
// every page; every response carries a CSP that allows only this app's own files and no network at all.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveInside } from "../artifacts";
import { contentTypeOf } from "../design/serve";
import { injectBridge } from "../design/serve";
import { appThemeSpecimenHtml, checkHostCsp, checkHostHtml } from "./check";

export const APP_SCHEME = "cubiq-app";
/** Keys are what `registry.ts` hands out: `g~name`, `p~<projectId>~name`, `d~<threadId>~name`. */
const KEY_RE = /^[a-z]~[A-Za-z0-9_-]{1,80}(?:~[a-z0-9][a-z0-9-]{0,63})?$/;

export function appUrl(key: string, rel = "index.html"): string {
  return `${APP_SCHEME}://a/${encodeURIComponent(key)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** A parsed app URL, or null when malformed or trying to leave the app folder. */
export function parseAppUrl(url: string): { key: string; rel: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?[^#]*)?(?:#[\s\S]*)?$/i.exec(url);
  if (!m || m[1]!.toLowerCase() !== APP_SCHEME || m[2] !== "a") return null;
  let segments: string[];
  try {
    segments = (m[3] ?? "").replace(/^\/+/, "").split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  for (const s of segments) if (!s || s === "." || s === ".." || s.startsWith(".") || s.includes("/") || s.includes("\\") || s.includes("\0")) return null;
  const key = segments[0] ?? "";
  const rel = segments.slice(1).join("/");
  if (!KEY_RE.test(key) || !rel) return null;
  return { key, rel };
}

/** Only this app's files: another app's scripts are not loadable, and nothing reaches the network. */
export function appCsp(key: string): string {
  const self = `${APP_SCHEME}://a/${encodeURIComponent(key)}/`;
  return `default-src ${self}; script-src ${self} 'unsafe-inline'; style-src ${self} 'unsafe-inline'; img-src ${self} data: blob:; font-src ${self} data:; media-src ${self} data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'`;
}

export interface AppServeDeps {
  /** The app's folder for a key, or null when the key names no app (or a disabled one). */
  appRoot(key: string): string | null;
  bridge: string;
  /** The bridge for this app, when it differs by app (an own-style app gets no base sheet). */
  bridgeFor?(key: string): string;
}

export function serveApp(url: string, deps: AppServeDeps): Response {
  try {
    // The app check's host page (see check.ts): fixed content, framing only cubiq-app://a/ pages.
    if (/^cubiq-app:\/\/h\/check\.html(?:[?#]|$)/i.test(url)) {
      return new Response(checkHostHtml(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": checkHostCsp(), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    const parsed = parseAppUrl(url);
    if (/^cubiq-app:\/\/h\/theme\.html(?:[?#]|$)/i.test(url)) return new Response(injectBridge(appThemeSpecimenHtml(), deps.bridge), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    if (!parsed) return notFound();
    const root = deps.appRoot(parsed.key);
    if (!root) return notFound();
    const r = resolveInside(root, parsed.rel);
    if (!r) return notFound();
    const abs = join(realpathSync(root), r);
    if (!statSync(abs).isFile()) return notFound();
    const body = readFileSync(abs);
    const type = contentTypeOf(parsed.rel);
    const payload: string | Uint8Array<ArrayBuffer> = type.startsWith("text/html") ? injectBridge(body.toString("utf-8"), deps.bridgeFor?.(parsed.key) ?? deps.bridge) : copy(body);
    return new Response(payload, {
      status: 200,
      headers: { "Content-Type": type, "Content-Security-Policy": appCsp(parsed.key), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return notFound();
  }
}

function copy(b: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}
