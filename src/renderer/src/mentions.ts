/** Pure helpers for the @ mention picker in the message box. */

/** The `@`-token the caret sits in: where it starts in the text, and what was typed after the `@`. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** The text between the `@` and the caret. */
  query: string;
}

/**
 * The mention being typed at `caret`, or null. An `@` only opens the picker
 * when it starts the text or follows whitespace (so an email doesn't), and the
 * caret sits before any whitespace after it.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Every parent folder of every file, unique, sorted, with a trailing "/". */
export function folderPaths(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(`${parts.slice(0, i).join("/")}/`);
  }
  return [...folders].sort();
}

/** A path's last segment, ignoring a folder's trailing "/". */
function basenameOf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** True when every character of `query` appears in `target` in order. */
function isSubsequence(query: string, target: string): boolean {
  let i = 0;
  for (const ch of target) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return i === query.length;
}

/**
 * The paths to show for a query: basename-prefix matches first, then any path
 * substring, then a fuzzy subsequence. Case-insensitive; files and folders
 * mixed; shorter paths first on ties.
 */
export function rankMentions(paths: string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; tier: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const base = basenameOf(path).toLowerCase();
    let tier: number;
    if (base.startsWith(q)) tier = 0;
    else if (lower.includes(q)) tier = 1;
    else if (isSubsequence(q, lower)) tier = 2;
    else continue;
    scored.push({ path, tier });
  }
  scored.sort((a, b) => a.tier - b.tier || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}

/** The distinct `@path` tokens in the text whose path the project actually has. */
export function mentionsIn(text: string, known: Set<string>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(^|\s)@([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const path = m[2]!;
    if (known.has(path) && !seen.has(path)) {
      seen.add(path);
      found.push(path);
    }
  }
  return found;
}
