import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseUnifiedDiff } from "../shared/diff";
import type { DiffFile, GitState } from "../shared/types";

// The diff parser lives in shared (the renderer and adapters read it too);
// re-exported so existing imports of src/main/git keep working.
export { parseUnifiedDiff };

const run = promisify(execFile);

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

/** Point `refs/<name>` at `sha` (overwriting), so a checkpoint doesn't touch branches or tags. */
export async function createRef(cwd: string, name: string, sha: string): Promise<void> {
  await run("git", ["update-ref", `refs/${name}`, sha], { cwd });
}

/**
 * The repository's head commit, branch and changed paths. Null when `cwd`
 * isn't inside a work tree. `head` stays null before the first commit.
 */
export async function gitState(cwd: string): Promise<GitState | null> {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return null;
  }
  let head: string | null = null;
  try {
    head = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  } catch {
    // No commits yet.
  }
  let branch: string | null = null;
  try {
    const name = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    if (name && name !== "HEAD") branch = name;
  } catch {
    // Detached, unborn, or otherwise unreadable.
  }
  const entries = (await run("git", ["status", "--porcelain", "-z"], { cwd })).stdout.split("\0");
  const dirty: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    dirty.push(entry.slice(3));
    // A rename/copy entry is followed by the old path in its own NUL entry.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return { head, branch, dirty };
}

/**
 * The branch to label a thread row with: the current branch, or null when
 * it's the repository's default (origin's HEAD, else main/master), detached,
 * or `cwd` isn't in a work tree. Read-only.
 */
export async function branchLabel(cwd: string): Promise<string | null> {
  let branch: string;
  try {
    branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
  } catch {
    return null;
  }
  if (!branch || branch === "HEAD") return null;
  let defaults = ["main", "master"];
  try {
    const ref = (await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd })).stdout.trim();
    if (ref) defaults = [ref.replace(/^origin\//, "")];
  } catch {
    // No remote HEAD: fall back to the usual names.
  }
  return defaults.includes(branch) ? null : branch;
}
