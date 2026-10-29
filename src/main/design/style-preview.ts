import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { STYLE_PREVIEW_SCHEME } from "../../shared/style-preview";
import type { DesignSystemInfo } from "./systems";

/** A parsed style-preview URL, or null when it is malformed or tries to leave the style's folder. */
export function parseStylePreviewUrl(
  url: string,
): { projectId: string | null; systemId: string; file: string; theme: "light" | "dark" | null } | null {
  try {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(?:#[\s\S]*)?$/i.exec(url);
    if (!match) return null;
    if (match[1]!.toLowerCase() !== STYLE_PREVIEW_SCHEME || match[2] !== "p") return null;

    const segments = (match[3] ?? "").replace(/^\/+/, "").split("/").map(decodeURIComponent);
    for (const segment of segments) {
      if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return null;
    }
    const projectId = segments[0] ?? "";
    const systemId = segments[1] ?? "";
    if (!projectId || !systemId) return null;

    const file = segments.slice(2).join("/");
    if (!validPreviewFile(file)) return null;

    const query = match[4];
    let theme: "light" | "dark" | null = null;
    if (query !== undefined) {
      const raw = new URLSearchParams(query).get("theme");
      if (raw === "light" || raw === "dark") theme = raw;
    }
    return { projectId: projectId === "_" ? null : projectId, systemId, file, theme };
  } catch {
    return null;
  }
}

/** The three files a style preview can reach: its page, its tokens, and its fonts. */
function validPreviewFile(file: string): boolean {
  if (file === "index.html" || file === "tokens.css") return true;
  return /^fonts\/[\w.-]+\.woff2$/.test(file);
}

/** Pin a style's tokens to one theme by rewriting its dark-mode media query, or leave it alone for null. */
export function previewTokensCss(css: string, theme: "light" | "dark" | null): string {
  if (theme === null) return css;
  return css.replace(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, theme === "dark" ? "@media all" : "@media not all");
}

/** Escape text for HTML markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Fill the shared specimen with one style's name, description, platform and theme. */
export function renderSpecimen(template: string, info: { name: string; description: string; platform: string; theme: "light" | "dark" }): string {
  const platform = info.platform === "deck" ? "deck" : "page";
  return template
    .replaceAll("{{name}}", () => escapeHtml(info.name))
    .replaceAll("{{description}}", () => escapeHtml(info.description))
    .replaceAll("{{platform}}", () => escapeHtml(platform))
    .replaceAll("{{theme}}", () => escapeHtml(info.theme));
}

/** The sandbox CSP for every style preview: its own files only, no scripts, no network. */
export function stylePreviewCsp(): string {
  return "default-src 'none'; style-src cubiq-style: 'unsafe-inline'; font-src cubiq-style:; img-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
}

/** The main-process services the preview server leans on; injected so it stays testable. */
export interface StylePreviewDeps {
  system(projectId: string | null, systemId: string): (DesignSystemInfo & { platform?: string }) | null;
  specimen: string;
}

/** Serve one style-preview request: the specimen page, a style's tokens, or one of its fonts; never throws. */
export function serveStylePreview(url: string, deps: StylePreviewDeps): Response {
  try {
    const parsed = parseStylePreviewUrl(url);
    if (!parsed) return notFound();
    const system = deps.system(parsed.projectId, parsed.systemId);
    if (!system || !system.tokensCss) return notFound();
    const tokensCss = system.tokensCss;

    if (parsed.file === "index.html") {
      const html = renderSpecimen(readFileSync(deps.specimen, "utf8"), {
        name: system.name,
        description: system.description,
        platform: system.platform ?? "any",
        theme: parsed.theme ?? "light",
      });
      return new Response(html, { status: 200, headers: previewHeaders("text/html; charset=utf-8") });
    }

    if (parsed.file === "tokens.css") {
      const css = previewTokensCss(readFileSync(tokensCss, "utf8"), parsed.theme);
      return new Response(css, { status: 200, headers: previewHeaders("text/css; charset=utf-8") });
    }

    const name = parsed.file.slice("fonts/".length);
    const listed = system.fontFiles?.find((file) => basename(file) === name) ?? null;
    const own = join(dirname(tokensCss), "fonts", name);
    const font = listed ?? (isFile(own) ? own : null);
    if (!font) return notFound();
    return new Response(readFileSync(font), { status: 200, headers: previewHeaders("font/woff2") });
  } catch {
    return notFound();
  }
}

/** True when `path` names an existing regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Response headers for a preview file: sandboxed, same-scheme only, never cached. */
function previewHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": stylePreviewCsp(),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Every miss in this module is an empty 404. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}
