import {
  type Tweak,
  type TweakValues,
  defaultValue,
  parseTweaks,
  tweakTarget,
  tweakValue,
} from "../../shared/tweaks";

const MANIFEST_RE = /<script\b[^>]*\bid\s*=\s*["']cubiq-tweaks["'][^>]*>([\s\S]*?)<\/script>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;
const HEAD_CLOSE_RE = /<\/head>/i;
const VARS_STYLE_RE = /<style\b[^>]*\bid\s*=\s*["']cubiq-tweak-vars["'][^>]*>[\s\S]*?<\/style>/i;
const SCRIPT_CLOSE = "</script>";

/** Finds a page's tweak manifest script: the inner JSON and the whole match's range. */
export function findManifest(html: string): { json: string; start: number; end: number } | null {
  const m = MANIFEST_RE.exec(html);
  if (!m) return null;
  return { json: m[1] ?? "", start: m.index, end: m.index + m[0].length };
}

/** The tweaks a page declares, or [] when it has no manifest. */
export function readTweaks(html: string): Tweak[] {
  const m = findManifest(html);
  return m ? parseTweaks(m.json) : [];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const withValue = (t: Tweak, v: string): Tweak => {
  switch (t.type) {
    case "choice":
      return { ...t, default: v };
    case "toggle":
      return { ...t, default: v === "on" };
    case "color":
      return { ...t, default: v };
    case "range":
      return { ...t, default: Number(v) };
    default:
      return t;
  }
};

const setHtmlAttr = (html: string, id: string, value: string): string => {
  const open = HTML_OPEN_RE.exec(html);
  if (!open) return html;
  const tag = open[0];
  const attrRe = new RegExp(`\\sdata-${escapeRe(id)}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  const at = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  const next = attrRe.test(tag) ? tag.replace(attrRe, ` data-${id}="${value}"`) : tag.slice(0, at) + ` data-${id}="${value}"` + tag.slice(at);
  return html.slice(0, open.index) + next + html.slice(open.index + tag.length);
};

/** Writes chosen tweak values into the page: the manifest defaults, `<html>` attributes and the root vars. */
export function keepTweaks(html: string, values: TweakValues): string {
  const tweaks = readTweaks(html);
  if (tweaks.length === 0) throw new Error("This page declares no tweaks.");
  const updated = tweaks.map((t) => {
    const v = tweakValue(t, values[t.id]);
    return v === null ? t : withValue(t, v);
  });

  // (a) Rewrite the manifest's JSON, keeping its script tags exactly as they were.
  const manifest = findManifest(html);
  if (!manifest) throw new Error("This page declares no tweaks.");
  const match = html.slice(manifest.start, manifest.end);
  const innerStart = manifest.start + match.indexOf(">") + 1;
  const innerEnd = manifest.end - SCRIPT_CLOSE.length;
  let out = html.slice(0, innerStart) + JSON.stringify({ tweaks: updated }).replace(/</g, "\\u003c") + html.slice(innerEnd);

  // (b) Pin every choice/toggle onto the first <html> tag as a data- attribute.
  for (const t of updated) {
    if (t.type === "choice" || t.type === "toggle") out = setHtmlAttr(out, t.id, defaultValue(t));
  }

  // (c) Write color/range variables into a single <style id="cubiq-tweak-vars"> block.
  const varTweaks = updated.filter((t): t is Extract<Tweak, { type: "color" } | { type: "range" }> => t.type === "color" || t.type === "range");
  const css = "html:root{" + varTweaks.map((t) => `${t.var}:${tweakTarget(t, defaultValue(t)).value}`).join(";") + "}";
  const block = `<style id="cubiq-tweak-vars">${css}</style>`;
  if (varTweaks.length === 0) {
    out = out.replace(VARS_STYLE_RE, "");
  } else {
    const existing = VARS_STYLE_RE.exec(out);
    if (existing) {
      out = out.slice(0, existing.index) + block + out.slice(existing.index + existing[0].length);
    } else {
      const head = HEAD_CLOSE_RE.exec(out);
      const at = head ? head.index : findManifest(out)?.end;
      if (at !== undefined) out = out.slice(0, at) + block + out.slice(at);
    }
  }
  return out;
}
