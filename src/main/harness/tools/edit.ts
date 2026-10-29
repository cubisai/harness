// The Edit tool: replace an exact or fuzzy-matched snippet in a file, after the
// read-before-write check, keeping the file's line endings and BOM.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { unifiedDiff } from "../../../shared/diff";
import { assertFresh, noteRead, resolvePath } from "./paths";
import { bool, str, ToolError, type NativeTool, type ToolContext, type ToolResult } from "./types";

/** How a snippet was located in the file, loosest-last. */
export type EditStrategy = "exact" | "line-trimmed" | "whitespace" | "indentation" | "block-anchor";

/** Which strategy matched and where, as [start, end) offsets into the content. */
export interface EditMatch {
  strategy: EditStrategy;
  ranges: [start: number, end: number][];
}

/** The smallest leading-whitespace count across the non-blank lines, or 0. */
function commonIndent(lines: string[]): number {
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    min = Math.min(min, /^[ \t]*/.exec(line)![0].length);
  }
  return Number.isFinite(min) ? min : 0;
}

/** Remove the smallest common leading indentation from each line, blank lines aside. */
function dedent(lines: string[]): string[] {
  const cut = commonIndent(lines);
  return cut === 0 ? lines : lines.map((line) => (line.trim() ? line.slice(cut) : line));
}

/** Every line of the text plus the offset where each begins (after "\n" normalization). */
function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return { lines, starts };
}

/** The exact span in the content covered by `count` lines starting at `from`. */
function windowSpan(split: { lines: string[]; starts: number[] }, from: number, count: number): [number, number] {
  const last = from + count - 1;
  return [split.starts[from]!, split.starts[last]! + split.lines[last]!.length];
}

/** Every non-overlapping occurrence of the exact text. */
function exactRanges(content: string, old: string): [number, number][] {
  const ranges: [number, number][] = [];
  let at = content.indexOf(old);
  while (at !== -1) {
    ranges.push([at, at + old.length]);
    at = content.indexOf(old, at + old.length);
  }
  return ranges;
}

/** Same-length line windows whose normalized lines equal old's, with their exact spans. */
function windowRanges(content: string, old: string, normalize: (lines: string[]) => string[]): [number, number][] {
  const split = splitLines(content);
  const want = normalize(splitLines(old).lines);
  const ranges: [number, number][] = [];
  for (let i = 0; i + want.length <= split.lines.length; i++) {
    const got = normalize(split.lines.slice(i, i + want.length));
    if (got.length === want.length && got.every((line, k) => line === want[k])) {
      ranges.push(windowSpan(split, i, want.length));
    }
  }
  return ranges;
}

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** The single best window whose anchors match and whose middle is at least 0.65 similar. */
function blockAnchorRanges(content: string, old: string): [number, number][] {
  const split = splitLines(content);
  const oldLines = splitLines(old).lines;
  if (oldLines.length < 3) return [];
  const first = oldLines[0]!.trim();
  const last = oldLines[oldLines.length - 1]!.trim();
  const middle = oldLines.slice(1, -1).join("\n");
  let best: { from: number; score: number } | null = null;
  for (let i = 0; i + oldLines.length <= split.lines.length; i++) {
    const slice = split.lines.slice(i, i + oldLines.length);
    if (slice[0]!.trim() !== first || slice[slice.length - 1]!.trim() !== last) continue;
    const windowMiddle = slice.slice(1, -1).join("\n");
    const longest = Math.max(middle.length, windowMiddle.length);
    const score = longest === 0 ? 1 : 1 - levenshtein(middle, windowMiddle) / longest;
    if (score >= 0.65 && (best === null || score > best.score)) best = { from: i, score };
  }
  return best ? [windowSpan(split, best.from, oldLines.length)] : [];
}

/** Find old in content by the first strategy that matches: exact, then four fuzzy passes. */
export function findMatches(content: string, old: string): EditMatch {
  if (!old) return { strategy: "exact", ranges: [] };
  const attempts: EditMatch[] = [
    { strategy: "exact", ranges: exactRanges(content, old) },
    { strategy: "line-trimmed", ranges: windowRanges(content, old, (lines) => lines.map((line) => line.trim())) },
    { strategy: "whitespace", ranges: windowRanges(content, old, (lines) => lines.map((line) => line.replace(/\s+/g, " ").trim())) },
    { strategy: "indentation", ranges: windowRanges(content, old, dedent) },
    { strategy: "block-anchor", ranges: blockAnchorRanges(content, old) },
  ];
  return attempts.find((attempt) => attempt.ranges.length > 0) ?? { strategy: "exact", ranges: [] };
}

/** Replace a snippet in a file, trying exact then fuzzy matching, and report a diff. */
export const editTool: NativeTool = {
  name: "edit",
  displayName: "Edit",
  access: "edit",
  description:
    "Replace an exact piece of text in an existing file with new text. old_string must be copied from the file and should include enough surrounding lines to be unique; set replace_all to change every occurrence. The file must have been read this session. If old_string isn't found exactly, the tool retries with looser whitespace and line matching, so minor indentation differences may still apply.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file to edit, relative to the working folder." },
      old_string: { type: "string", description: "The exact text to replace, copied from the file." },
      new_string: { type: "string", description: "The text to put in its place. May be empty to delete." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
    },
    required: ["path", "old_string", "new_string"],
  },
  summarize(args: Record<string, unknown>): string {
    return str(args, "path") ?? "";
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const p = resolvePath(ctx.cwd, str(args, "path", true));
    if (!existsSync(p.abs)) throw new ToolError(`No such file: ${p.shown}. Use write to create it.`);
    assertFresh(ctx, p);

    const raw = readFileSync(p.abs, "utf8");
    const hasBom = raw.startsWith("\uFEFF");
    const body = hasBom ? raw.slice(1) : raw;
    const crlf = body.includes("\r\n");
    const before = crlf ? body.replace(/\r\n/g, "\n") : body;
    const oldStr = str(args, "old_string", true).replace(/\r\n/g, "\n");
    const newStr = str(args, "new_string", true).replace(/\r\n/g, "\n");

    if (!oldStr) throw new ToolError("old_string is empty.");
    if (oldStr === newStr) throw new ToolError("old_string and new_string are the same.");

    const { strategy, ranges } = findMatches(before, oldStr);
    if (!ranges.length) {
      throw new ToolError(`old_string wasn't found in ${p.shown}. Read the file again and copy the exact text, including whitespace.`);
    }
    if (ranges.length > 1 && !bool(args, "replace_all")) {
      throw new ToolError(`old_string matches ${ranges.length} places in ${p.shown}. Include more surrounding lines to make it unique, or set replace_all.`);
    }

    let after = before;
    for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
      after = after.slice(0, start) + newStr + after.slice(end);
    }
    let out = crlf ? after.replace(/\n/g, "\r\n") : after;
    if (hasBom) out = `\uFEFF${out}`;
    writeFileSync(p.abs, out);
    noteRead(ctx, p.abs);

    const count = ranges.length;
    const text = `Edited ${p.shown}: ${count} replacement(s)` + (strategy !== "exact" ? ` (matched with ${strategy} matching)` : "");
    return {
      text,
      display: {
        summary: p.shown,
        result: { diff: [{ path: p.shown, unified: unifiedDiff(p.shown, before, after) }] },
      },
    };
  },
};
