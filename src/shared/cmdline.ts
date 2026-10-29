/**
 * Split a command line the way a shell would for simple cases: spaces
 * separate words, and single or double quotes keep spaces inside a word.
 * Used for the "Command" field of an MCP server.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(word);
  return out;
}

/** The reverse, quoting words that need it, to show a stored command in the field. */
export function joinCommandLine(words: string[]): string {
  return words.map((w) => (w === "" || /[\s"']/.test(w) ? (w.includes('"') ? `'${w}'` : `"${w}"`) : w)).join(" ");
}
