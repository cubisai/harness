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

/** The skill name being typed after a leading "$", or null when "$" doesn't open the skill menu. */
export function skillQuery(text: string): string | null {
  return text.startsWith("$") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
}

/** The command being typed after a leading "/", or null when "/" doesn't open the command menu. */
export function commandQuery(text: string): string | null {
  return text.startsWith("/") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
}
