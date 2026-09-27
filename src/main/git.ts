import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
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

/**
 * The project's files for the Files tab: inside a git work tree the tracked
 * ones plus the untracked-but-not-ignored (so .gitignore'd paths like
 * node_modules never appear); outside git, every real file. Project-relative
 * "/" paths, sorted and deduplicated, at most `limit` (truncated when cut).
 */
export async function listProjectFiles(cwd: string, limit = 5000): Promise<{ files: string[]; truncated: boolean }> {
  let out: string[];
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    out = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd })).stdout
      .split("\0")
      .filter(Boolean);
  } catch {
    // One past the limit is enough to know it was cut; a huge folder isn't walked to the end.
    out = await walkFiles(cwd, "", [], limit + 1);
  }
  const paths = [...new Set(out)].sort();
  const truncated = paths.length > limit;
  return { files: truncated ? paths.slice(0, limit) : paths, truncated };
}

/** Files under `dir` into `found` (project-relative, "/" separators, skipping .git and node_modules), stopping at `max`. */
async function walkFiles(dir: string, prefix: string, found: string[], max: number): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (found.length >= max) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await walkFiles(join(dir, entry.name), rel, found, max);
    } else {
      found.push(rel);
    }
  }
  return found;
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

/** A branch name for a thread's worktree: `harness/<title words>-<id>`, safe for git refs. */
export function worktreeBranch(title: string, threadId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `harness/${slug || "thread"}-${threadId.replace(/[^a-z0-9]/gi, "").slice(0, 6)}`;
}

/**
 * Give a thread its own worktree: a new branch from the repository's HEAD,
 * checked out at `dir`. Refuses (throws) outside a git repository or before
 * the first commit, since there is nothing to branch from.
 */
export async function createWorktree(repo: string, dir: string, branch: string): Promise<void> {
  const state = await gitState(repo);
  if (!state) throw new Error("This project isn't a git repository, so a thread can't get its own worktree.");
  if (!state.head) throw new Error("This repository has no commits yet, so there is nothing to branch a worktree from.");
  await run("git", ["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: repo });
}

/**
 * Remove a thread's worktree when it has nothing uncommitted; its branch stays.
 * Returns false (and leaves everything in place) when it has changes or git refuses.
 */
export async function removeWorktree(repo: string, dir: string): Promise<boolean> {
  try {
    await run("git", ["worktree", "remove", dir], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}
