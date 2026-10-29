import { parseExpertMarkdown } from "../../shared/experts";

/**
 * The English pass an expert package goes through before it is installed: text
 * files are translated once, junk files are filtered, package-private skill
 * names are kept out of prompts, and anything still carrying CJK text is
 * dropped rather than installed. The input files are never mutated.
 */

/** Translates each text to English, same order and count; keeps Markdown structure, code blocks, file paths, URLs, identifiers and skill names unchanged. */
export type Translate = (items: { path: string; text: string }[]) => Promise<string[]>;

/** Han, Hiragana/Katakana, Hangul and CJK/full-width punctuation. */
export const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** True when a text still carries any CJK text or punctuation. */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** What one English pass did: the rewritten files, the dropped paths, the skills left partial and how many files were translated. */
export interface EnglishResult {
  files: Map<string, Uint8Array>;
  dropped: string[];
  partialSkills: string[];
  translated: number;
}

/** The not-installed error for an `expert.md` that is still Chinese after translation. */
const CJK_EXPERT_ERROR = "This expert is written in Chinese and could not be translated to English, so it was not installed.";

/** Text extensions the pass decodes; every other key is binary and copied unchanged. */
const TEXT_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".sh",
  ".ps1",
  ".bat",
  ".html",
  ".htm",
  ".css",
  ".xml",
]);

/** Media and archive extensions: never sniffed as text. */
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip", ".gz", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".mov", ".wav"]);

/** Tooling paths that are never installed, wherever they appear in a package. */
const JUNK_SEGMENTS = new Set([".workbuddy", "reports", "checkpoints", "node_modules", "__pycache__", ".git", ".venv"]);

/** Basenames that are never installed; `.env.example` stays on purpose. */
const JUNK_NAMES = new Set([".env", ".env.local", ".DS_Store"]);

/** Characters one translate batch may carry: small enough for one short model reply. */
const DEFAULT_BATCH_CHARS = 12000;
/** Translate batches in flight at once. */
const BATCH_CONCURRENCY = 6;
/** Prose translated as whole files; every other text file is translated line by line. */
const WHOLE_EXTS = new Set([".md", ".markdown", ".txt"]);

/**
 * Run the English pass over a package's output files: junk paths are dropped
 * silently, text files are translated in batches, `Skill tool` references to
 * the package's private skills are reworded, anything still CJK is removed (an
 * untranslated `expert.md` fails the package), and members get a filled
 * description and their skill bindings. Returns a new map.
 */
export async function englishPass(files: Map<string, Uint8Array>, opts: { translate?: Translate; batchChars?: number; onProgress?: (done: number, total: number) => void }): Promise<EnglishResult> {
  const kept = new Map<string, Uint8Array>();
  for (const [key, bytes] of files) {
    if (!isJunkPath(key)) kept.set(key, bytes);
  }

  // Known text extensions, plus any other file that reads as UTF-8 text (.gitignore, .env.example).
  const texts = new Map<string, string>();
  for (const [key, bytes] of kept) {
    if (isTextPath(key) || looksLikeText(bytes, key)) texts.set(key, decode(bytes));
  }

  const batchChars = opts.batchChars ?? DEFAULT_BATCH_CHARS;
  const translate = opts.translate;
  let translated = 0;
  if (translate) {
    // Prose goes whole (it needs its context); code and data go line by line, so
    // only the distinct lines carrying CJK (comments, strings) are sent and the
    // code itself never passes through the model.
    const whole: { path: string; text: string }[] = [];
    const lines = new Set<string>();
    for (const [key, text] of texts) {
      if (!hasCjk(text)) continue;
      if (WHOLE_EXTS.has(extensionOf(key))) whole.push({ path: key, text });
      else for (const line of cjkLines(text)) lines.add(line);
    }
    const items = [...whole, ...[...lines].map((text) => ({ path: "#line", text }))];
    const total = items.length;
    let done = 0;
    opts.onProgress?.(0, total);
    const out = await translateItems(items, translate, batchChars, (n) => {
      done += n;
      opts.onProgress?.(Math.min(done, total), total);
    });
    for (const item of whole) {
      const english = out.get(item.text);
      if (english !== undefined) texts.set(item.path, english);
    }
    const lineMap = new Map([...lines].flatMap((line) => (out.has(line) ? [[line, out.get(line)!] as const] : [])));
    for (const [key, text] of texts) {
      if (!hasCjk(text) || WHOLE_EXTS.has(extensionOf(key))) continue;
      texts.set(key, replaceLines(text, lineMap));
    }
  }

  // Full-width punctuation the model tends to leave behind maps to ASCII.
  for (const [key, text] of texts) if (hasCjk(text)) texts.set(key, asciiPunctuation(text));

  // One more, line-by-line pass over whatever still carries CJK, prose included.
  if (translate) {
    const residual = new Set<string>();
    for (const text of texts.values()) if (hasCjk(text)) for (const line of cjkLines(text)) residual.add(line);
    if (residual.size) {
      const out = await translateItems([...residual].map((text) => ({ path: "#line", text })), translate, batchChars);
      for (const [key, text] of texts) if (hasCjk(text)) texts.set(key, asciiPunctuation(replaceLines(text, out)));
    }
  }
  for (const [key, text] of texts) if (text !== decode(kept.get(key)!)) translated++;

  // The package's own skill names: private to the expert, not global skills.
  const packageSkills = new Set<string>();
  for (const key of kept.keys()) {
    if (!key.startsWith("skills/")) continue;
    const name = key.slice("skills/".length).split("/")[0];
    if (name) packageSkills.add(name);
  }
  if (packageSkills.size) {
    const names = [...packageSkills];
    for (const [key, text] of texts) {
      if (extensionOf(key) !== ".md") continue;
      texts.set(key, rewriteSkillToolLines(text, names));
    }
  }

  const removed = new Set<string>();
  const dropped = new Set<string>();
  const partialSkills = new Set<string>();
  const stillCjk = [...texts].filter(([, text]) => hasCjk(text)).map(([key]) => key);
  if (stillCjk.includes("expert.md")) throw new Error(CJK_EXPERT_ERROR);
  for (const key of stillCjk) {
    dropped.add(key);
    if (key.startsWith("skills/")) {
      const rest = key.slice("skills/".length).split("/");
      const name = rest[0] ?? "";
      // A Chinese SKILL.md makes the whole skill unusable, references and scripts included.
      if (name && rest.length === 2 && rest[1] === "SKILL.md") {
        for (const other of kept.keys()) {
          if (other.startsWith(`skills/${name}/`)) removed.add(other);
        }
      } else {
        removed.add(key);
      }
      if (name && rest.length >= 2) partialSkills.add(name);
    } else {
      removed.add(key);
    }
  }
  for (const key of removed) texts.delete(key);

  const remainingSkills = new Set<string>();
  for (const key of kept.keys()) {
    if (removed.has(key) || !key.startsWith("skills/")) continue;
    const name = key.slice("skills/".length).split("/")[0];
    if (name) remainingSkills.add(name);
  }
  for (const [key, text] of texts) {
    if (!key.startsWith("members/") || extensionOf(key) !== ".md") continue;
    const id = key.slice("members/".length).replace(/\.md$/i, "");
    texts.set(key, bindMember(text, id, remainingSkills));
  }

  const out = new Map<string, Uint8Array>();
  for (const [key, bytes] of kept) {
    if (removed.has(key)) continue;
    const text = texts.get(key);
    out.set(key, text === undefined ? bytes : encode(text));
  }
  return { files: out, dropped: [...dropped], partialSkills: [...partialSkills], translated };
}

/** Characters of CJK-bearing text files a pass would send to translate (for a cost estimate). */
export function cjkChars(files: Map<string, Uint8Array>): number {
  let total = 0;
  for (const [key, bytes] of files) {
    if (isJunkPath(key) || !(isTextPath(key) || looksLikeText(bytes, key))) continue;
    const text = decode(bytes);
    if (hasCjk(text)) total += text.length;
  }
  return total;
}

/** Re-render a member file: description filled in, skill bindings derived or kept, body untouched. */
function bindMember(text: string, id: string, packageSkills: Set<string>): string {
  const { meta, body } = parseExpertMarkdown(text, id);
  const value = (key: string): string => {
    const v = meta[key];
    return typeof v === "string" ? v : "";
  };
  const name = oneLine(value("name")) || id;
  const profession = oneLine(value("profession"));
  const explicitSkills = meta.skills;
  const skills = explicitSkills === undefined ? skillsInBody(body, packageSkills) : asList(explicitSkills);
  const description = oneLine(value("description")) || firstParagraph(body) || profession;
  const lines = [`name: ${name}`, `profession: ${profession}`, `description: ${description}`];
  if (skills.length) lines.push(`skills: [${skills.join(", ")}]`);
  const maxTurns = oneLine(value("maxTurns"));
  if (/^\d{1,3}$/.test(maxTurns)) lines.push(`maxTurns: ${maxTurns}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

/** A meta list value as trimmed one-line values. */
function asList(value: string | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((v) => oneLine(v)).filter(Boolean);
}

/** The package skills that occur in `body` as whole tokens, in order of first occurrence. */
function skillsInBody(body: string, packageSkills: Set<string>): string[] {
  const found: { name: string; at: number }[] = [];
  for (const name of packageSkills) {
    const at = body.search(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`));
    if (at >= 0) found.push({ name, at });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

/** The first prose paragraph of a body: whitespace-collapsed, cut at the first sentence end or 200 chars. */
function firstParagraph(body: string): string {
  for (const paragraph of body.split(/\n[ \t]*\n/)) {
    const line = paragraph.split("\n").find((l) => l.trim().length > 0);
    if (line === undefined) continue;
    if (/^[ \t]/.test(line)) continue; // an indented code block
    const trimmed = line.trim();
    if (/^#{1,6}(?:[ \t]|$)/.test(trimmed)) continue; // a heading
    if (/^(?:[-*+]|\d+[.)])[ \t]/.test(trimmed)) continue; // a list item
    if (trimmed.startsWith("|")) continue; // a table row
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) continue; // a code fence
    const text = paragraph.replace(/\s+/g, " ").trim();
    const stop = text.indexOf(". ");
    return text.slice(0, stop >= 0 ? stop : Math.min(text.length, 200)).trim();
  }
  return "";
}

/** On lines that mention the Skill tool, spell a package skill the way CubiQ's skills list is named. */
function rewriteSkillToolLines(text: string, skillNames: string[]): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/Skill tool/i.test(line)) continue;
    lines[i] = skillNames.reduce((acc, name) => acc.replace(skillPattern(name), () => `the \`${name}\` skill from your skills list`), line);
  }
  return lines.join("\n");
}

/** A quoted or backticked occurrence of a skill name. */
function skillPattern(name: string): RegExp {
  const escaped = escapeRegExp(name);
  return new RegExp(`"${escaped}"|'${escaped}'|\`${escaped}\``, "g");
}

/** Tooling paths that are never installed. Junk is dropped silently, not reported. */
function isJunkPath(key: string): boolean {
  if (key.split("/").some((segment) => JUNK_SEGMENTS.has(segment))) return true;
  const base = key.slice(key.lastIndexOf("/") + 1);
  return JUNK_NAMES.has(base) || base.endsWith(".pyc");
}

/** True when a path's lowercase extension is one the pass decodes as text. */
function isTextPath(key: string): boolean {
  return TEXT_EXTS.has(extensionOf(key));
}

/** The lowercase extension of a path's basename, "" when it has none. */
function extensionOf(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** One item per batch run: same-length replies are kept; a failed or misaligned batch is retried once in halves. */
async function translateItems(
  items: { path: string; text: string }[],
  translate: Translate,
  batchChars: number,
  onDone?: (count: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const run = async (batch: { path: string; text: string }[], retry: boolean): Promise<void> => {
    const reply = await translate(batch);
    if (Array.isArray(reply) && reply.length === batch.length && reply.some((t, i) => t !== batch[i]!.text)) {
      batch.forEach((item, i) => {
        if (reply[i] !== item.text) out.set(item.text, reply[i]!);
      });
    } else if (retry && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await Promise.all([run(batch.slice(0, half), false), run(batch.slice(half), false)]);
      return;
    }
    onDone?.(batch.length);
  };
  const batches = toBatches(items, batchChars);
  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) await Promise.all(batches.slice(i, i + BATCH_CONCURRENCY).map((b) => run(b, true)));
  return out;
}

/** Items grouped so a batch closes before it would pass `batchChars` (a bigger item is a batch of its own). */
function toBatches<T extends { text: string }>(items: T[], batchChars: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length && chars + item.text.length > batchChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** The distinct trimmed lines of a text that carry CJK. */
function cjkLines(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.trim()).filter((l) => l && hasCjk(l)))];
}

/** Each line whose trimmed text has a translation gets it, indentation and trailing text kept. */
function replaceLines(text: string, map: Map<string, string>): string {
  return text
    .split("\n")
    .map((line) => {
      const core = line.trim();
      const english = core ? map.get(core) : undefined;
      if (english === undefined) return line;
      const at = line.indexOf(core);
      return line.slice(0, at) + english + line.slice(at + core.length);
    })
    .join("\n");
}

/** Full-width and CJK punctuation as its ASCII counterpart (the ideographic space as a plain one). */
function asciiPunctuation(text: string): string {
  const map: Record<string, string> = {
    "\u3000": " ", "\u3001": ", ", "\u3002": ". ", "\u300a": "\"", "\u300b": "\"", "\u300c": "\"", "\u300d": "\"", "\u300e": "\"", "\u300f": "\"",
    "\u3010": "[", "\u3011": "]", "\u2018": "'", "\u2019": "'", "\u201c": "\"", "\u201d": "\"",
  };
  return text
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000-\u3002\u300a-\u300f\u3010\u3011]/g, (c) => map[c] ?? c);
}

/** A file outside the known text extensions still counts as text when it's small, has no NUL byte and decodes as UTF-8. */
function looksLikeText(bytes: Uint8Array, key = ""): boolean {
  if (BINARY_EXTS.has(extensionOf(key)) || bytes.byteLength > 512 * 1024 || bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
