import type { Translate } from "./english";

/** One model call without tools: a system prompt and a user message in, the reply text out. */
export type Complete = (system: string, user: string) => Promise<string>;

/** The importer's one-time translation instructions: JSON in, the same-length JSON array out. */
export const TRANSLATE_SYSTEM = `You translate files of an AI expert package into English.
The user message is a JSON array of {"path", "text"} objects. Reply with ONLY a JSON array of strings: the English translation of each "text", in the same order, with the same count.
Rules:
- Translate every Chinese, Japanese or Korean word, including headings, table cells, code comments, string literals shown to people, and frontmatter values. Leave no CJK characters at all.
- Keep everything else exactly: Markdown structure, frontmatter keys, code, file paths, URLs, command lines, identifiers, variable names and skill names (lowercase-hyphenated words such as deep-research-agent).
- Translate meaning, not word by word; keep it concise. Write proper names in pinyin or their usual English name.
- Never add notes, explanations or code fences around the array.`;

/** The JSON array in a reply, tolerating a code fence or stray text around it. */
function arrayIn(reply: string): unknown {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * A `Translate` over one model call per batch. A reply that isn't a
 * same-length array of strings keeps the originals, so the English gate drops
 * what stayed untranslated instead of installing it.
 */
export function makeTranslate(complete: Complete): Translate {
  return async (items) => {
    const originals = items.map((item) => item.text);
    let reply: string;
    try {
      reply = await complete(TRANSLATE_SYSTEM, JSON.stringify(items.map((item) => ({ path: item.path, text: item.text }))));
    } catch {
      return originals;
    }
    const parsed = arrayIn(reply);
    if (!Array.isArray(parsed) || parsed.length !== items.length || !parsed.every((v) => typeof v === "string")) return originals;
    return parsed as string[];
  };
}
