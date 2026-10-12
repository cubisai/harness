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
