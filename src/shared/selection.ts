// What the design canvas knows about the elements a user selected in the page: the wire shape, its
// untrusted-input reader, and the text helpers that turn a selection into a message scope.

/** The most elements one selection may carry; the page's bridge caps itself at this too. */
export const MAX_SELECTED = 8;

/** One element the user selected in the design canvas. */
export interface SelectedElement {
  /** The element's `data-agent-id`, when it has one. */
  id?: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Up to four ancestors, outermost first, for a breadcrumb. */
  path: { label: string; selector: string }[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const isStr = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validates one untrusted bridge element field by field; a fresh object, or null when anything is off. */
export function readSelected(raw: unknown): SelectedElement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.selector, 1, 2000)) return null;
  if (!isStr(r.tag, 1, 64)) return null;
  if (!isStr(r.text, 0, 300)) return null;
  if (!isStr(r.html, 0, 1200)) return null;
  if (r.id !== undefined && (typeof r.id !== "string" || !ID_RE.test(r.id))) return null;
  if (!r.rect || typeof r.rect !== "object" || Array.isArray(r.rect)) return null;
  const box = r.rect as Record<string, unknown>;
  if (!isNum(box.x) || !isNum(box.y) || !isNum(box.width) || !isNum(box.height)) return null;
  if (!Array.isArray(r.path) || r.path.length > 6) return null;
  const path: SelectedElement["path"] = [];
  for (const step of r.path) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return null;
    const s = step as Record<string, unknown>;
    if (!isStr(s.label, 1, 80) || !isStr(s.selector, 1, 2000)) return null;
    path.push({ label: s.label, selector: s.selector });
  }
  const el: SelectedElement = {
    selector: r.selector,
    tag: r.tag,
    text: r.text,
    html: r.html,
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    path,
  };
  if (r.id !== undefined) el.id = r.id;
  return el;
}

/**
 * A short label for a selected element: its text when that is short, else its id (a section's text is a run-on of
 * everything inside it), else its text cut short, else just its tag.
 */
export function elementLabel(el: Pick<SelectedElement, "tag" | "text" | "id">): string {
  const text = el.text.replace(/\s+/g, " ").trim();
  if (text && (text.length <= 32 || !el.id)) return `${el.tag} "${text.slice(0, 32)}${text.length > 32 ? "…" : ""}"`;
  if (el.id) return `${el.tag} ${el.id}`;
  return el.tag;
}

/** The `Selected in …` block appended to a message, or "" when nothing is selected. */
export function scopeBlock(page: string, els: SelectedElement[]): string {
  const n = els.length;
  if (!n) return "";
  const lines = [`Selected in ${page} (${n} element${n === 1 ? "" : "s"}): change only ${n === 1 ? "this element" : "these elements"}. If the request needs changes elsewhere, say so instead of making them.`];
  els.forEach((el, i) => {
    lines.push(`${i + 1}. <${el.tag}>${el.id ? ` data-agent-id="${el.id}"` : ""} · selector \`${el.selector}\`${el.text ? ` · text "${el.text.slice(0, 120)}${el.text.length > 120 ? "…" : ""}"` : ""}`);
  });
  if (n === 1) {
    const html = els[0]!.html;
    lines.push("```html", html.slice(0, 600) + (html.length > 600 ? "…" : ""), "```");
  }
  return lines.join("\n");
}

/** The message body with the selection scope appended: unchanged without a page or elements. */
export function withScope(body: string, page: string | null, els: SelectedElement[]): string {
  if (!page || !els.length) return body;
  const block = scopeBlock(page, els);
  return body ? `${body}\n\n${block}` : block;
}

/** The canvas's one-line note that a selection changed. */
export function announceSelection(els: SelectedElement[]): string {
  if (!els.length) return "Selection cleared";
  if (els.length === 1) return `Selected ${elementLabel(els[0]!)}`;
  return `${els.length} elements selected`;
}

/** A stable key for a selection, so the canvas can skip redundant updates. */
export function selectionKey(els: SelectedElement[]): string {
  return els.map((el) => el.id ?? el.selector).join("|");
}
