import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffFile, DiffHunk } from "../shared/types";

const run = promisify(execFile);

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

const MAX_UNTRACKED_BYTES = 200_000;

/**
 * Everything that changed in the working tree against HEAD: tracked edits
 * (staged or not) plus untracked files, shown as all-added. Empty when the
 * directory isn't a git repository.
 */
export async function workingTreeDiff(cwd: string): Promise<DiffFile[]> {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return [];
  }
  let tracked = "";
  try {
    tracked = (await run("git", ["diff", "HEAD", "--no-color", "--no-ext-diff"], { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch {
    // No commits yet: diff the index instead.
    tracked = (await run("git", ["diff", "--no-color", "--no-ext-diff"], { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
  }
  const files = parseUnifiedDiff(tracked);

  const untracked = (await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd })).stdout
    .split("\0")
    .filter(Boolean);
  for (const path of untracked) {
    let lines: string[] = [];
    try {
      const buf = await readFile(join(cwd, path));
      if (buf.length <= MAX_UNTRACKED_BYTES && !buf.includes(0)) lines = buf.toString("utf-8").split("\n");
    } catch {
      // unreadable: list it without content
    }
    if (lines.at(-1) === "") lines.pop();
    files.push({
      path,
      status: "untracked",
      additions: lines.length,
      deletions: 0,
      hunks: lines.length ? [{ header: `@@ new file @@`, lines: lines.map((text) => ({ kind: "add" as const, text })) }] : [],
    });
  }
  return files;
}
