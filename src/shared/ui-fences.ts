/**
 * Inline UI blocks (```ui:<name> fences, renderer: src/renderer/src/genui) as
 * one-line summaries, for text that goes back to a model (handoff, rehydrate):
 * the widget already did its job on screen, so its body isn't carried.
 */

/** The JSON keys that hold a block's items, per the catalog. */
const ITEM_KEYS = ["items", "rows", "steps", "series", "inputs", "options", "fields", "stats"];

const FENCE = /^[ \t]*(```|~~~)[ \t]*ui:([a-z][a-z0-9-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

/** A block body's title and item count, from either the JSON or the line form. */
function describe(name: string, body: string): { title: string | null; count: number } {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const title = typeof parsed.title === "string" ? parsed.title : null;
      const key = ITEM_KEYS.find((k) => Array.isArray(parsed[k]));
      return { title, count: key ? (parsed[key] as unknown[]).length : 0 };
    } catch {
      return { title: null, count: 0 };
    }
  }
  let title: string | null = null;
  let count = 0;
  for (const raw of trimmed.split(/\r\n?|\n/)) {
    const line = raw.trim();
    if (!line || /^>|^unit:|^=|^\|?\s*:?-{3,}/i.test(line)) continue;
    if (line.startsWith("# ")) title ??= line.slice(2).trim();
    else count++;
  }
  // A compare block's first row is its header.
  return { title, count: name === "compare" ? Math.max(0, count - 1) : count };
}

/** `text` with every complete ```ui:<name> fence replaced by `[ui:<name> "<title>", N items]`. */
export function summarizeUiFences(text: string): string {
  if (!text.includes("ui:")) return text;
  return text.replace(FENCE, (_m, _fence: string, name: string, body: string) => {
    const { title, count } = describe(name, body);
    const parts = [title ? `"${title.slice(0, 80)}"` : null, `${count} ${count === 1 ? "item" : "items"}`].filter(Boolean);
    return `[ui:${name} ${parts.join(", ")}]`;
  });
}
