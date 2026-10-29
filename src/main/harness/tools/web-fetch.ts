// The model's web_fetch tool: one http(s) URL to readable text, bounded like
// every other tool's output (the whole page is saved for paging with read).
// Fetching goes through the permission layer as a "web" call: a URL can carry
// data out, so only full-access mode runs it without asking.

import { bound } from "./bound";
import { ToolError, str, type NativeTool } from "./types";

const TIMEOUT_MS = 30_000;
/** The most of a response body that's read; the rest is dropped. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Readable text from HTML: no scripts or styles, block tags as line breaks, links kept as "text (url)". */
export function htmlToText(html: string, base?: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "");
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      let url = href;
      try {
        url = new URL(decodeEntities(href), base).href;
      } catch {
        // Keep the raw href.
      }
      return label && !url.startsWith("javascript:") ? `${label} (${url})` : label;
    })
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|ul|ol|li|table|tr|h[1-6]|pre|blockquote|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  body = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

async function readCapped(res: Response): Promise<{ text: string; cut: boolean }> {
  if (!res.body) return { text: "", cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_BODY_BYTES) {
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES)), cut };
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml|x-yaml|yaml|toml))/i;

/** Fetch a web page or file as text. */
export const webFetchTool: NativeTool = {
  name: "web_fetch",
  displayName: "WebFetch",
  access: "web",
  description:
    "Fetch an http(s) URL and return its content as text: HTML is converted to readable text with links kept, JSON and plain text come back as is. " +
    "Use it to read documentation, changelogs or API references the user points to, or to check a fast-moving fact. " +
    "Long pages are cut; the result says where the full text was saved so you can read the rest. Binary files such as images and PDFs are refused.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The full http:// or https:// URL." },
    },
    required: ["url"],
  },
  summarize: (args) => str(args, "url") ?? "",
  run: async (args, ctx) => {
    let url: URL;
    try {
      url = new URL(str(args, "url", true).trim());
    } catch {
      throw new ToolError("Not a valid URL. Pass a full http:// or https:// URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError(`Only http and https URLs can be fetched, not ${url.protocol}`);

    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.any([ctx.signal, timeout]),
        redirect: "follow",
        headers: { "User-Agent": "CubiQ/1.0 (web_fetch)", Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" },
      });
    } catch (err) {
      if (timeout.aborted) throw new ToolError(`Timed out after ${TIMEOUT_MS / 1000} s fetching ${url.href}`);
      throw new ToolError(`Couldn't fetch ${url.href}: ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)}`);
    }

    const type = res.headers.get("content-type") ?? "";
    const final = res.url || url.href;
    if (type && !TEXTUAL.test(type)) {
      await res.body?.cancel().catch(() => {});
      throw new ToolError(`${final} is ${type.split(";")[0]}, not text; web_fetch only reads text pages.`);
    }
    const { text: raw, cut } = await readCapped(res);
    const isHtml = /html/i.test(type) || (!type && /^\s*<(!doctype|html)/i.test(raw));
    const page = isHtml ? htmlToText(raw, final) : { title: "", text: raw.trim() };
    const header = [`URL: ${final}`, `Status: ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`, ...(page.title ? [`Title: ${page.title}`] : [])].join("\n");
    const body = `${page.text || "(empty page)"}${cut ? `\n\n[Stopped reading after ${MAX_BODY_BYTES / 1024 / 1024} MB.]` : ""}`;
    const kb = Math.max(1, Math.round(Buffer.byteLength(body) / 1024));
    return {
      text: bound(`${header}\n\n${body}`, ctx),
      ...(res.ok ? {} : { isError: true }),
      display: { summary: `${final} · ${res.status} · ${kb} KB` },
    };
  },
};
