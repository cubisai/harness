import { execFile } from "node:child_process";
import { existsSync, type Dirent } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseUnifiedDiff } from "../shared/diff";
import type { DiffFile, GitState } from "../shared/types";
import { addedLines } from "./evidence";

// The diff parser lives in shared (the renderer and adapters read it too);
// re-exported so existing imports of src/main/git keep working.
export { parseUnifiedDiff };

const run = promisify(execFile);

const MAX_UNTRACKED_BYTES = 200_000;

/** A file's content at HEAD (path relative to `cwd`), or null: no repository, no commits, or not tracked. */
export async function headContent(cwd: string, relPath: string): Promise<string | null> {
  try {
    return (await run("git", ["show", `HEAD:./${relPath}`], { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

/** Whether git tracks `relPath` (relative to `cwd`). False outside a repository. */
export async function isTracked(cwd: string, relPath: string): Promise<boolean> {
  try {
    await run("git", ["ls-files", "--error-unmatch", "--", relPath], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** The lines a working-tree file adds against HEAD: all of them when it's untracked. Empty when unreadable. */
export async function addedSinceHead(cwd: string, relPath: string): Promise<string[]> {
  if (await isTracked(cwd, relPath)) {
    try {
      return addedLines((await run("git", ["diff", "-U0", "HEAD", "--", relPath], { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout);
    } catch {
      // No commits yet: everything staged counts as added.
    }
  }
  try {
    return (await readFile(join(cwd, relPath), "utf8")).split("\n");
  } catch {
    return [];
  }
}

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
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory vanished or is unreadable: skip it rather than failing the whole listing.
    return found;
  }
  for (const entry of entries) {
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
  return { head, branch, dirty: await dirtyPaths(cwd) };
}

/** Whether `cwd` or a parent holds a `.git` entry: a cheap filesystem check before spawning git. */
export function hasGitDir(cwd: string): boolean {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** The working tree's changed and untracked paths, from one `git status`. Throws outside a work tree. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  const entries = (await run("git", ["status", "--porcelain", "-z"], { cwd })).stdout.split("\0");
  const dirty: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    dirty.push(entry.slice(3));
    // A rename/copy entry is followed by the old path in its own NUL entry.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return dirty;
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

/** The branch checked out at `cwd`, or null when HEAD is detached or `cwd` isn't a repository. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The commit HEAD points at, or null before the first commit or outside a repository. */
export async function headSha(cwd: string): Promise<string | null> {
  try {
    return (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The fork point of two commits, or null when they share no history. */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  try {
    return (await run("git", ["merge-base", a, b], { cwd })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** How many commits `branch` has that `base` doesn't (`ahead`) and how many `base` has that it doesn't (`behind`). */
export async function aheadBehind(cwd: string, base: string, branch: string): Promise<{ ahead: number; behind: number }> {
  const out = (await run("git", ["rev-list", "--left-right", "--count", `${base}...${branch}`], { cwd })).stdout.trim();
  const [behind = "0", ahead = "0"] = out.split(/\s+/);
  return { ahead: Number(ahead), behind: Number(behind) };
}

/** What a thread's worktree holds since `baseSha`: the summary lines, one patch per file, and untracked paths. */
export interface BranchDiff {
  nameStatus: string;
  stat: string;
  files: { path: string; patch: string }[];
  untracked: string[];
}

/**
 * Everything in `cwd`'s working tree since `baseSha` (committed, staged and
 * unstaged tracked changes) plus untracked files, whose content isn't read.
 */
export async function branchDiff(cwd: string, baseSha: string): Promise<BranchDiff> {
  const status = (await run("git", ["diff", "--name-status", baseSha], { cwd })).stdout;
  const stat = (await run("git", ["diff", "--stat", baseSha], { cwd })).stdout;
  const patch = (await run("git", ["diff", "--no-color", "--no-ext-diff", baseSha], { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;

  const files: { path: string; patch: string }[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push({ path: current.path, patch: current.lines.join("\n") });
      const header = line.slice("diff --git ".length);
      const at = header.indexOf(" b/");
      current = { path: at >= 0 ? header.slice(at + 3) : header, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) files.push({ path: current.path, patch: current.lines.join("\n") });

  const untracked = (await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd })).stdout
    .split("\0")
    .filter(Boolean);
  const nameStatus = status
    .split("\n")
    .filter(Boolean)
    .concat(untracked.map((path) => `A\t${path}`))
    .join("\n");
  for (const path of untracked) files.push({ path, patch: `new file: ${path}` });
  return { nameStatus, stat, files, untracked };
}

/** Stage every change in `cwd` and commit it; throws when there is nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await run("git", ["add", "-A"], { cwd });
  let nothingStaged = false;
  try {
    await run("git", ["diff", "--cached", "--quiet"], { cwd });
    nothingStaged = true;
  } catch {
    // Exit 1 means there are staged changes.
  }
  if (nothingStaged) throw new Error("Nothing to commit.");
  const sha = await withMessageFile(message, async (file) => {
    await run("git", ["commit", "-q", "-F", file], { cwd });
    return headSha(cwd);
  });
  if (!sha) throw new Error("Commit failed: no HEAD after commit.");
  return sha;
}

/** A merge that either landed on `sha` or was refused/rolled back with a reason and any conflicting paths. */
export type MergeResult = { ok: true; sha: string } | { ok: false; reason: string; conflicts: string[] };

/**
 * Bring `o.branch` into `o.base` in `repo`, squashed or as a merge commit.
 * Refuses on a dirty project, the wrong current branch, or nothing to merge;
 * a conflict is rolled back so the project is left exactly as it was.
 */
export async function mergeInto(
  repo: string,
  o: { branch: string; base: string; mode: "squash" | "merge"; message: string },
): Promise<MergeResult> {
  const fail = (reason: string, conflicts: string[] = []): MergeResult => ({ ok: false, reason, conflicts });
  try {
    const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo })).stdout.trim();
    if (dirty) return fail("The project has uncommitted changes. Commit or stash them first.");

    const cur = await currentBranch(repo);
    if (cur !== o.base) return fail(`The project is on ${cur ?? "a detached HEAD"}, not ${o.base}. Switch to ${o.base} first.`);

    if ((await aheadBehind(repo, o.base, o.branch)).ahead === 0) {
      return fail("Nothing to merge: the branch has no commits the base doesn't have.");
    }

    if (o.mode === "squash") {
      try {
        await run("git", ["merge", "--squash", o.branch], { cwd: repo });
      } catch {
        const conflicts = await mergeConflicts(repo);
        await abortMerge(repo);
        return fail("Merge conflicts: nothing was changed.", conflicts);
      }
      const sha = await withMessageFile(o.message, async (file) => {
        await run("git", ["commit", "-q", "-F", file], { cwd: repo });
        return headSha(repo);
      });
      if (!sha) throw new Error("Merge failed: no HEAD after commit.");
      return { ok: true, sha };
    }

    try {
      await withMessageFile(o.message, (file) => run("git", ["merge", "--no-ff", "-q", "-F", file, o.branch], { cwd: repo }));
    } catch {
      const conflicts = await mergeConflicts(repo);
      await abortMerge(repo);
      return fail("Merge conflicts: nothing was changed.", conflicts);
    }
    const sha = await headSha(repo);
    if (!sha) throw new Error("Merge failed: no HEAD after merge.");
    return { ok: true, sha };
  } catch (err) {
    await abortMerge(repo);
    return fail(firstLine(err));
  }
}

/** The folder that has `branch` checked out (the project or one of its worktrees), or null. */
export async function branchCheckout(repo: string, branch: string): Promise<string | null> {
  const out = (await run("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

/**
 * Merge `branch` into `target` where `target` is checked out. When no folder
 * has it out, merge in a throwaway worktree of it, so the project folder never
 * switches branch.
 */
export async function mergeIntoBranch(
  repo: string,
  o: { branch: string; target: string; mode: "squash" | "merge"; message: string },
): Promise<MergeResult> {
  const merge = { branch: o.branch, base: o.target, mode: o.mode, message: o.message };
  const holder = await branchCheckout(repo, o.target);
  if (holder) return mergeInto(holder, merge);
  const dir = await mkdtemp(join(tmpdir(), "cubiq-merge-"));
  try {
    await run("git", ["worktree", "add", "--quiet", dir, o.target], { cwd: repo });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, reason: gitError(err), conflicts: [] };
  }
  try {
    return await mergeInto(dir, merge);
  } finally {
    await run("git", ["worktree", "remove", "--force", dir], { cwd: repo }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Local branch names, sorted. */
export async function localBranches(repo: string): Promise<string[]> {
  try {
    const out = (await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: repo })).stdout;
    return out.split("\n").map((b) => b.trim()).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** The remote `branch` pushes to: its configured one, else origin, else the first; null without remotes. */
export async function pushRemote(cwd: string, branch: string): Promise<string | null> {
  try {
    const set = (await run("git", ["config", "--get", `branch.${branch}.remote`], { cwd })).stdout.trim();
    if (set) return set;
  } catch {
    // Not pushed yet: fall back to the repository's remotes.
  }
  try {
    const remotes = (await run("git", ["remote"], { cwd })).stdout.split("\n").map((r) => r.trim()).filter(Boolean);
    return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  } catch {
    return null;
  }
}

/** Commits on `branch` its upstream doesn't have; null when it has no upstream yet. */
export async function unpushedCount(cwd: string, branch: string): Promise<number | null> {
  try {
    return Number((await run("git", ["rev-list", "--count", `${branch}@{upstream}..${branch}`], { cwd })).stdout.trim());
  } catch {
    return null;
  }
}

/** Push `branch` to `remote` and track it. Never waits on a credential prompt: it fails instead. */
export async function pushBranch(cwd: string, remote: string, branch: string): Promise<void> {
  try {
    await run("git", ["push", "--quiet", "-u", remote, `${branch}:${branch}`], {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
  } catch (err) {
    throw new Error(gitError(err));
  }
}

/** Git's own reason from a failed call: its last fatal/error line, else the first line of the message. */
function gitError(err: unknown): string {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? "");
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const reason = [...lines].reverse().find((l) => /^(fatal|error):/i.test(l)) ?? lines.at(-1);
  if ((err as { killed?: boolean })?.killed) return "git timed out.";
  return reason ? reason.replace(/^(fatal|error):\s*/i, "") : firstLine(err);
}

/** Run `fn` with a temp file holding `message`, so commit messages never go through a shell. */
async function withMessageFile<T>(message: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cubiq-message-"));
  try {
    const file = join(dir, "message.txt");
    await writeFile(file, message, "utf8");
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The paths git left unmerged after a failed merge. */
async function mergeConflicts(repo: string): Promise<string[]> {
  try {
    return (await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repo })).stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Leave no merge half-applied: abort one if present, then reset the index. */
async function abortMerge(repo: string): Promise<void> {
  try {
    await run("git", ["merge", "--abort"], { cwd: repo });
  } catch {
    // No merge in progress (e.g. a squash conflict).
  }
  try {
    await run("git", ["reset", "-q", "--merge"], { cwd: repo });
  } catch {
    // Nothing to reset.
  }
}

/** The first line of an error's message, for showing to the user. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]!.trim() || "The merge failed.";
}

/** Whether tracked files in `cwd` have changes (untracked files don't count: a merge leaves them alone). */
export async function hasTrackedChanges(cwd: string): Promise<boolean> {
  try {
    return (await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd })).stdout.trim() !== "";
  } catch {
    return false;
  }
}
