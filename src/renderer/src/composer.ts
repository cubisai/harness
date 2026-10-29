/** Pure helpers for the message box: context chips and what a send carries. */

/** A chip's label: a picked element's selector, else the text's first line, clipped. */
export function chipLabel(text: string, max = 40): string {
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const label = first.match(/^Element `([^`]+)`/)?.[1] ?? first;
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** The message a send carries: what was typed, then each chip's full text. */
export function composeMessage(text: string, chips: string[]): string {
  return [text.trim(), ...chips.map((c) => c.trim())].filter(Boolean).join("\n\n");
}

/**
 * The skill name being typed after a "$" at a word start (start of the text or after a space), up to the caret:
 * where the "$" is and the query, lowercased; null when "$" doesn't open the skill menu there.
 */
export function skillQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf("$");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query: query.toLowerCase() };
}

/** A picked skill list with `name` added at the end, or taken out when it's already there. */
export function toggleSkill(list: readonly string[], name: string): string[] {
  return list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
}

/** The command being typed after a leading "/", or null when "/" doesn't open the command menu. */
export function commandQuery(text: string): string | null {
  return text.startsWith("/") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
}
