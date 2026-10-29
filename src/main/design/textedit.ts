import { STYLE_KEYS } from "../../shared/selection";

/** The longest replacement text a canvas edit may write into a design page. */
export const MAX_EDIT_CHARS = 2000;

/** Decode the entities a page's text may contain, leaving anything else as-is. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (match) => {
    const body = match.slice(1, -1).toLowerCase();
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
    }
    const code = body.startsWith("#x") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}

/** Escape the characters that would otherwise be markup, and nothing else. */
export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Write an in-place text edit into a page, refusing whenever it is not unambiguous. */
export function applyTextEdit(html: string, id: string, before: string, after: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error("That text has no stable id; ask the agent to change it.");
  }
  if (after.length > MAX_EDIT_CHARS) {
    throw new Error("The new text is too long.");
  }

  const open = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\sdata-agent-id\\s*=\\s*(["'])${escapeRegExp(id)}\\2[^>]*>`,
    "g",
  );
  const matches = [...html.matchAll(open)];
  if (matches.length !== 1) {
    throw new Error("That text's id isn't unique in the page; ask the agent to change it.");
  }
  const match = matches[0]!;
  const tag = match[1]!;
  const end = match.index! + match[0].length;
  const rest = html.slice(end);

  const close = rest.search(new RegExp(`</${tag}\\s*>`, "i"));
  if (close === -1) {
    throw new Error("That element holds more than text; ask the agent to change it.");
  }
  const content = rest.slice(0, close);
  if (content.includes("<")) {
    throw new Error("That element holds more than text; ask the agent to change it.");
  }

  if (normalize(decodeEntities(content)) !== normalize(before)) {
    throw new Error("The page changed since you started editing; try again.");
  }

  return html.slice(0, end) + escapeText(after) + html.slice(end + content.length);
}

/** Collapse whitespace runs to one space and trim. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A style value a canvas edit may write: a plain CSS value with no way out of its declaration ("" removes it). */
const STYLE_VALUE_RE = /^[#(),.%\w\s-]*$/;

/** `backgroundColor` → `background-color`. */
function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Write inspector style changes into the `style` attribute of the one element with that `data-agent-id`, keeping its
 * other declarations. Only the inspector's keys (STYLE_KEYS) and only plain values: no `;`, quotes, braces, `url()`
 * or `expression()`. An empty value removes that declaration. Refuses whenever the element isn't unambiguous.
 */
export function applyStyleEdit(html: string, id: string, changes: { prop: string; value: string }[]): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error("That element has no stable id; ask the agent to change it.");
  }
  if (changes.length === 0 || changes.length > STYLE_KEYS.length) throw new Error("No style changes to write.");
  const set = new Map<string, string>();
  for (const { prop, value } of changes) {
    if (!STYLE_KEYS.includes(prop)) throw new Error(`The inspector can't write ${prop}.`);
    const v = value.trim();
    if (v.length > 120 || !STYLE_VALUE_RE.test(v) || /\b(?:url|expression)\s*\(/i.test(v)) {
      throw new Error(`That ${kebab(prop)} value can't be written; ask the agent to change it.`);
    }
    set.set(kebab(prop), v);
  }

  const open = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\sdata-agent-id\\s*=\\s*(["'])${escapeRegExp(id)}\\2[^>]*>`, "g");
  const matches = [...html.matchAll(open)];
  if (matches.length !== 1) {
    throw new Error("That element's id isn't unique in the page; ask the agent to change it.");
  }
  const match = matches[0]!;
  const tagText = match[0];
  const found = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(tagText);
  const kept = (found ? found[2]!.split(";") : [])
    .map((d) => d.trim())
    .filter((d) => d && !set.has(d.slice(0, Math.max(0, d.indexOf(":"))).trim().toLowerCase()));
  const added = [...set].filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}`);
  const body = [...kept, ...added].join("; ");

  let next: string;
  if (found) {
    const q = found[1]!;
    const attr = body ? ` style=${q}${body}${q}` : "";
    next = tagText.slice(0, found.index) + attr + tagText.slice(found.index + found[0].length);
  } else {
    if (!body) return html;
    const end = tagText.endsWith("/>") ? tagText.length - 2 : tagText.length - 1;
    next = `${tagText.slice(0, end).replace(/\s+$/, "")} style="${body}"${tagText.slice(end)}`;
  }
  return html.slice(0, match.index!) + next + html.slice(match.index! + tagText.length);
}
