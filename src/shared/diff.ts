import type { DiffFile, DiffHunk } from "./types";
import type { ToolDiff } from "./tools";

/** Parse `git diff` unified output into files and hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { path: m?.[2] ?? line.slice(11), status: "modified", additions: 0, deletions: 0, hunks: [] };
      hunk = null;
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith("new file mode")) {
      file.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = line.slice("rename to ".length);
    } else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && line.startsWith("+") && !line.startsWith("+++")) {
      hunk.lines.push({ kind: "add", text: line.slice(1) });
      file.additions++;
    } else if (hunk && line.startsWith("-") && !line.startsWith("---")) {
      hunk.lines.push({ kind: "del", text: line.slice(1) });
      file.deletions++;
    } else if (hunk && line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: line.slice(1) });
    }
  }
  return files;
}

/** One-line stat for a set of diffs: `+<adds> −<dels>` summed across every file. */
export function diffSummary(diffs: ToolDiff[]): string {
  let adds = 0;
  let dels = 0;
  for (const d of diffs) {
    for (const file of parseUnifiedDiff(d.unified)) {
      adds += file.additions;
      dels += file.deletions;
    }
  }
  return `+${adds} −${dels}`;
}

const MAX_LINES = 4000;
const CONTEXT = 3;

/**
 * A git-style unified diff of two texts for one path: line-based LCS hunks
 * with three lines of context, shaped so parseUnifiedDiff round-trips it.
 * Huge texts skip the LCS and come out as one replace-everything hunk.
 */
export function unifiedDiff(path: string, oldText: string, newText: string): string {
  const head =
    `diff --git a/${path} b/${path}\n` +
    (oldText === "" ? "new file mode 100644\n" : "") +
    `--- ${oldText === "" ? "/dev/null" : `a/${path}`}\n` +
    `+++ ${newText === "" && oldText !== "" ? "/dev/null" : `b/${path}`}\n`;
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  if (oldLines.at(-1) === "") oldLines.pop();
  if (newLines.at(-1) === "") newLines.pop();
  const ops =
    oldLines.length > MAX_LINES || newLines.length > MAX_LINES
      ? [
          ...oldLines.map((text) => ({ kind: "del" as const, text })),
          ...newLines.map((text) => ({ kind: "add" as const, text })),
        ]
      : diffOps(oldLines, newLines);
  return head + hunksFor(ops);
}

/** Longest-common-subsequence edit script between two line lists. */
function diffOps(a: string[], b: string[]): { kind: "context" | "del" | "add"; text: string }[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]; built backwards so the walk forward is direct.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { kind: "context" | "del" | "add"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "del", text: a[i]! });
  for (; j < m; j++) ops.push({ kind: "add", text: b[j]! });
  return ops;
}

/** Group edit-script ops into hunks with three context lines each. */
function hunksFor(ops: { kind: "context" | "del" | "add"; text: string }[]): string {
  if (!ops.length) return "";
  const isChange = (op: { kind: string }) => op.kind !== "context";
  const kept = ops.map((op, i) => (isChange(op) ? i : -1)).filter((i) => i >= 0);
  const ranges: [number, number][] = [];
  let start = Math.max(0, kept[0]! - CONTEXT);
  let end = Math.min(ops.length, kept[0]! + CONTEXT + 1);
  for (const i of kept.slice(1)) {
    if (i - CONTEXT <= end) end = Math.min(ops.length, i + CONTEXT + 1);
    else {
      ranges.push([start, end]);
      start = Math.max(0, i - CONTEXT);
      end = Math.min(ops.length, i + CONTEXT + 1);
    }
  }
  ranges.push([start, end]);

  let out = "";
  // Line numbers count every op line, context or not, in each file's order.
  let oldNo = 1;
  let newNo = 1;
  const numbers: [number, number][] = [];
  for (const op of ops) {
    numbers.push([oldNo, newNo]);
    if (op.kind === "add") newNo++;
    else oldNo++;
  }
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to);
    const [aStart, bStart] = numbers[from]!;
    const delCount = slice.filter((o) => o.kind !== "add").length;
    const addCount = slice.filter((o) => o.kind !== "del").length;
    out += `@@ -${aStart},${delCount} +${bStart},${addCount} @@\n`;
    for (const op of slice) out += `${op.kind === "context" ? " " : op.kind === "del" ? "-" : "+"}${op.text}\n`;
  }
  return out;
}
