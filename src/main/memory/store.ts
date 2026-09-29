import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MemoryType } from "../../shared/types";

/** The kinds of fact Claude Code's auto-memory writes. */
export type { MemoryType };

export interface MemoryFact {
  /** The file's basename, e.g. "commit-style.md". */
  file: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/** The index file's budget: whole lines only, plus one line for the truncation notice. */
export const INDEX_CAP = { lines: 200, chars: 4800 };

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

function asType(value: string | undefined): MemoryType {
  const v = (value ?? "").trim();
  return (TYPES as string[]).includes(v) ? (v as MemoryType) : "project";
}

/** Strip one pair of quotes from a frontmatter value (JSON-quoted or plain). */
function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

/** The value of `key:` anywhere in the frontmatter, its own indentation ignored. */
function field(front: string[], key: string): string | undefined {
  for (const line of front) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m && m[1] === key) return unquote(m[2]!.trim());
  }
  return undefined;
}

/**
 * Parse one memory file. Accepts the current frontmatter (`metadata.type`),
 * the older top-level `type:`, quoted or bare values, CRLF, and a leading BOM.
 * Anything unreadable degrades to a project fact rather than throwing.
 */
export function parseFact(file: string, text: string): MemoryFact {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);
  let front: string[] = [];
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) {
      front = lines.slice(1, close);
      bodyStart = close + 1;
    }
  }
  const bodyLines = lines.slice(bodyStart);
  if (bodyLines[0] === "") bodyLines.shift();
  const name = field(front, "name") || basename(file, ".md");
  return {
    file,
    name,
    description: field(front, "description") ?? "",
    type: asType(field(front, "type")),
    body: bodyLines.join("\n"),
  };
}

/** Serialize a fact in Claude Code's auto-memory format: LF endings, a JSON-quoted description. */
export function serializeFact(f: Omit<MemoryFact, "file">): string {
  return `---\nname: ${f.name}\ndescription: ${JSON.stringify(f.description)}\nmetadata:\n  type: ${f.type}\n---\n\n${f.body}`;
}

/** A filesystem-safe slug for a fact name, avoiding `taken` (compared lowercased). */
export function slugFor(name: string, taken: Set<string>): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) slug = "memory";
  if (RESERVED.test(slug)) slug = `m-${slug}`;
  let candidate = slug;
  for (let n = 2; taken.has(`${candidate}.md`.toLowerCase()); n++) candidate = `${slug}-${n}`;
  return `${candidate}.md`;
}

/** A valid fact filename: a plain basename, ".md", never the index itself. */
function validFile(file: string): boolean {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    file.endsWith(".md") &&
    file !== "MEMORY.md" &&
    !file.includes("/") &&
    !file.includes("\\") &&
    !file.includes("..") &&
    basename(file) === file
  );
}

/** Sleep without a busy loop or a timer handle that could outlive the write. */
function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write-then-rename, retrying once on the transient Windows rename locks. */
function atomicWrite(target: string, text: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY") throw err;
    waitSync(50);
    renameSync(tmp, target);
  }
}

/** The markdown link target in an index line, if it points at a `.md` file. */
function linkedFile(line: string): string | null {
  const m = /\]\(([^)]+)\)/.exec(line);
  if (!m) return null;
  const target = m[1]!.trim();
  return target.endsWith(".md") ? target : null;
}

/**
 * Per-project memory as plain markdown in `<root>/<projectId>/`: one file per
 * fact plus a MEMORY.md index. The format is Claude Code's auto-memory, so
 * Claude reads and writes it natively; this class only mirrors it.
 */
export class MemoryStore {
  constructor(private root: string) {}

  /** The project's folder, created if needed. */
  dir(projectId: string): string {
    const d = join(this.root, projectId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Every fact except the index, sorted by filename. */
  list(projectId: string): Omit<MemoryFact, "body">[] {
    const d = this.dir(projectId);
    return readdirSync(d)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort()
      .map((f) => {
        const { body: _body, ...rest } = parseFact(f, readFileSync(join(d, f), "utf8"));
        return rest;
      });
  }

  read(projectId: string, file: string): MemoryFact | null {
    if (!validFile(file)) return null;
    const path = join(this.dir(projectId), file);
    if (!existsSync(path)) return null;
    return parseFact(file, readFileSync(path, "utf8"));
  }

  /** Write a fact (picking a slug when no file is given) and refresh the index. Returns its file. */
  write(projectId: string, fact: { name: string; description: string; type: MemoryType; body: string; file?: string }): string {
    if (fact.file !== undefined && !validFile(fact.file)) throw new Error(`invalid memory file ${fact.file}`);
    const file = fact.file ?? slugFor(fact.name, new Set(this.list(projectId).map((f) => f.file.toLowerCase())));
    atomicWrite(join(this.dir(projectId), file), serializeFact({ name: fact.name, description: fact.description, type: fact.type, body: fact.body }));
    this.rebuildIndex(projectId, file);
    return file;
  }

  /** Delete a fact and drop its index line. */
  remove(projectId: string, file: string): boolean {
    if (!validFile(file)) return false;
    const path = join(this.dir(projectId), file);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    this.rebuildIndex(projectId);
    return true;
  }

  /**
   * Rebuild MEMORY.md from the facts on disk. Every existing line survives
   * verbatim (headings, blanks, Claude's own titles/hooks); dead links are
   * dropped, only the `touched` fact's own line is rewritten to its current
   * name/description, and any unlinked fact is appended.
   */
  rebuildIndex(projectId: string, touched?: string): void {
    const d = this.dir(projectId);
    const indexPath = join(d, "MEMORY.md");
    const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/) : [];
    while (existing.length && existing[existing.length - 1] === "") existing.pop();
    const linked = new Set<string>();
    const kept: string[] = [];
    for (const line of existing) {
      const target = linkedFile(line);
      if (target === null) {
        kept.push(line);
        continue;
      }
      const file = basename(target);
      const fact = validFile(file) ? this.read(projectId, file) : null;
      if (!fact) continue; // the link points at a fact that's gone
      linked.add(file.toLowerCase());
      // Only the fact just written gets a fresh hook; the rest keep Claude's own wording.
      kept.push(touched && file.toLowerCase() === touched.toLowerCase() ? `- [${fact.name}](${file}) — ${fact.description}` : line);
    }
    const unlinked = this.list(projectId).filter((f) => !linked.has(f.file.toLowerCase()));
    for (const f of unlinked) kept.push(`- [${f.name}](${f.file}) — ${f.description}`);
    atomicWrite(indexPath, kept.length ? `${kept.join("\n")}\n` : "");
  }

  /** The index, capped for context: whole lines, with a notice when truncated. */
  index(projectId: string): { text: string; lines: number; tokens: number } {
    const path = join(this.dir(projectId), "MEMORY.md");
    if (!existsSync(path)) return { text: "", lines: 0, tokens: 0 };
    const all = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    while (all.length && all[all.length - 1] === "") all.pop();
    const kept: string[] = [];
    let chars = 0;
    for (const line of all) {
      if (kept.length + 1 > INDEX_CAP.lines - 1) break;
      const extra = (kept.length ? 1 : 0) + line.length;
      if (chars + extra > INDEX_CAP.chars) break;
      kept.push(line);
      chars += extra;
    }
    let text = kept.join("\n");
    const notice = (n: number) => `- … ${n} more (memory_read to list)`;
    if (all.length - kept.length > 0) {
      while (kept.length && `${kept.join("\n")}\n${notice(all.length - kept.length)}`.length > INDEX_CAP.chars) kept.pop();
      text = `${kept.join("\n")}\n${notice(all.length - kept.length)}`;
    }
    const lines = text === "" ? 0 : text.split("\n").length;
    return { text, lines, tokens: Math.ceil(text.length / 4) };
  }
}
