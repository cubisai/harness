/** A parsed markdown block; `parseBlocks` below builds these. */
export type Block =
  | { type: "code"; text: string; lang?: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][] }
  | { type: "ui"; name: string; body: string }
  | { type: "para"; text: string };

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "para", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*(```|~~~)\s*([\w+#.:-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(fence[1]!)) body.push(lines[i++] ?? "");
      const ui = /^ui:([a-z][a-z0-9-]*)$/.exec(fence[2] ?? "");
      if (ui) blocks.push({ type: "ui", name: ui[1]!, body: body.join("\n") });
      else blocks.push({ type: "code", text: body.join("\n"), ...(fence[2] ? { lang: fence[2] } : {}) });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const prev = blocks.at(-1);
      if (prev?.type === "list" && prev.ordered === ordered) prev.items.push(item[2]!);
      else blocks.push({ type: "list", ordered, items: [item[2]!] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      flush();
      blocks.push({ type: "table", header: table.header, align: table.align, rows: table.rows });
      i = table.end;
      continue;
    }
    const prev = blocks.at(-1);
    if (!para.length && prev?.type === "list" && /^\s{2,}\S/.test(line)) {
      prev.items[prev.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/**
 * A GFM table starting at line `i`: a header row, a delimiter row of `-`
 * cells (optional `:` for alignment) directly under it, then body rows.
 * Leading/trailing pipes are optional; cells are trimmed. `end` is the index
 * of the last line consumed.
 */
function tableAt(lines: string[], i: number): { header: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][]; end: number } | null {
  const header = cells(lines[i]);
  const delim = cells(lines[i + 1]);
  if (!header || !delim || delim.length !== header.length || !delim.every(isDelimCell)) return null;
  const align = delim.map(alignOf);
  const rows: string[][] = [];
  let end = i + 1;
  for (let j = i + 2; j < lines.length; j++) {
    const row = cells(lines[j]);
    if (!row) break;
    rows.push(row);
    end = j;
  }
  return { header, align, rows, end };
}

/** One table row's cells: null unless the line carries a pipe separator. */
function cells(line: string | undefined): string[] | null {
  const t = (line ?? "").trim();
  if (!t.includes("|")) return null;
  return (t.startsWith("|") ? t.slice(1) : t)
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isDelimCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell);
}

function alignOf(cell: string): "left" | "center" | "right" | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : left ? "left" : right ? "right" : null;
}

const FENCE = /^\s*(```|~~~)/;

/**
 * Split streaming text at the last complete block boundary: `frozen` can be
 * parsed once and reused, `tail` is the block still being written. A boundary
 * sits after a blank line (outside a fence) or after a line that closes a
 * fence. `frozen + tail` is always `text`.
 */
export function splitStreamingTail(text: string): { frozen: string; tail: string } {
  let boundary = 0;
  let lineStart = 0;
  let fence: string | null = null;
  for (let i = 0; i <= text.length; i++) {
    const atEnd = i === text.length;
    if (!atEnd && text[i] !== "\n") continue;
    const line = text.slice(lineStart, i);
    const after = atEnd ? -1 : i + 1;
    const marker = FENCE.exec(line)?.[1] ?? null;
    if (fence === null) {
      if (marker) fence = marker;
      else if (!line.trim() && after >= 0) boundary = after;
    } else if (marker && line.trimStart().startsWith(fence)) {
      fence = null;
      if (after >= 0) boundary = after;
    }
    lineStart = after >= 0 ? after : i;
    if (atEnd) break;
  }
  return { frozen: text.slice(0, boundary), tail: text.slice(boundary) };
}

const cache = new WeakMap<object, Map<string, unknown>>();

/** Parse each distinct text once per parse function, keeping the 64 most recent. */
export function memoizeByHash<T>(text: string, parse: (text: string) => T): T {
  const key = parse as unknown as object;
  let byText = cache.get(key) as Map<string, T> | undefined;
  if (!byText) {
    byText = new Map();
    cache.set(key, byText);
  }
  if (byText.has(text)) return byText.get(text)!;
  const value = parse(text);
  if (byText.size >= 64) {
    const oldest = byText.keys().next().value;
    if (oldest !== undefined) byText.delete(oldest);
  }
  byText.set(text, value);
  return value;
}
