// Review, commit and merge for a thread's own worktree (the app runs git here,
// never the agent): what the branch holds since it left its base, an
// AI-written commit message on the background model, and the merge back.

import { LEARN_DEFAULTS } from "../shared/learn";
import type { DiffFile, GitSettings, Project, Settings, Thread, WorktreeReview } from "../shared/types";
import type { AgentDriver } from "./agents/types";
import { aheadBehind, branchDiff, commitAll, currentBranch, dirtyPaths, hasTrackedChanges, mergeBase, mergeInto, parseUnifiedDiff, removeWorktree, workingTreeDiff, type MergeResult } from "./git";
import { buildCommitPrompt, coAuthorFor, formatCommitMessage, parseCommitMessage } from "./git-message";
import { backgroundShot, pickBackground, type BackgroundModel } from "./learn/background";

export const GIT_DEFAULTS: GitSettings = { commitModel: null, coAuthor: false };

export interface ReviewDeps {
  thread: (id: string) => Thread;
  project: (id: string) => Project;
  drivers: () => AgentDriver[];
  settings: () => Settings;
}

/** The thread's worktree and the project it merges into; throws for a thread without one. */
function worktreeOf(d: ReviewDeps, threadId: string): { thread: Thread; project: Project; dir: string; branch: string } {
  const thread = d.thread(threadId);
  if (!thread.worktreePath || !thread.branch) throw new Error("This thread doesn't have its own worktree.");
  return { thread, project: d.project(thread.projectId), dir: thread.worktreePath, branch: thread.branch };
}

/**
 * The base the branch is compared with: the recorded one, else (older threads)
 * the project's current branch and the fork point from it.
 */
async function baseOf(thread: Thread, project: Project, dir: string): Promise<{ branch: string | null; sha: string | null }> {
  if (thread.baseSha) return { branch: thread.baseBranch ?? null, sha: thread.baseSha };
  const branch = await currentBranch(project.path);
  return { branch, sha: branch ? await mergeBase(dir, "HEAD", branch) : null };
}

/** Everything the Review & merge bar shows. */
export async function reviewState(d: ReviewDeps, threadId: string): Promise<WorktreeReview> {
  const { thread, project, dir, branch } = worktreeOf(d, threadId);
  const base = await baseOf(thread, project, dir);
  const [uncommitted, projectBranch, projectDirty] = await Promise.all([dirtyPaths(dir), currentBranch(project.path), hasTrackedChanges(project.path)]);
  const counts = base.branch ? await aheadBehind(project.path, base.branch, branch).catch(() => ({ ahead: 0, behind: 0 })) : { ahead: 0, behind: 0 };
  let files: DiffFile[] = [];
  if (base.sha) {
    const diff = await branchDiff(dir, base.sha);
    files = parseUnifiedDiff(diff.files.filter((f) => !diff.untracked.includes(f.path)).map((f) => f.patch).join("\n"));
    const untracked = (await workingTreeDiff(dir)).filter((f) => f.status === "untracked");
    files.push(...untracked);
  }
  return { branch, base: base.branch, baseSha: base.sha, ahead: counts.ahead, behind: counts.behind, uncommitted: uncommitted.length, projectBranch, projectDirty, files };
}

/** The model commit messages are written on: the one picked in Settings, else the background model rule. */
function messageModel(d: ReviewDeps, thread: Thread): BackgroundModel | null {
  const settings = d.settings();
  const picked = (settings.git ?? GIT_DEFAULTS).commitModel;
  const drivers = d.drivers();
  if (picked) {
    const driver = drivers.find((x) => x.id === picked.agent);
    if (driver) {
      const option = driver.models().find((m) => m.id === picked.model);
      return { driver, model: picked.model, effort: null, label: `${driver.label} · ${option?.label ?? picked.model}` };
    }
  }
  return pickBackground({ learn: settings.learn ?? LEARN_DEFAULTS, projectId: thread.projectId, drivers, thread: { agent: thread.agent, model: thread.model } });
}

/**
 * A commit message for what's waiting: the uncommitted changes when there are
 * any (for Commit), else everything since the base (for a squash merge).
 */
export async function draftMessage(d: ReviewDeps, threadId: string, signal: AbortSignal): Promise<{ message: string; model: string }> {
  const { thread, project, dir } = worktreeOf(d, threadId);
  const bg = messageModel(d, thread);
  if (!bg) throw new Error("No model is available to write the message. Pick one in Settings → Threads → Commit messages.");
  const pending = (await dirtyPaths(dir)).length > 0;
  const base = await baseOf(thread, project, dir);
  const since = pending ? "HEAD" : base.sha;
  if (!since) throw new Error("Couldn't find where this branch started, so there's nothing to describe.");
  const diff = await branchDiff(dir, since);
  if (!diff.nameStatus.trim()) throw new Error("There are no changes to describe.");
  const prompt = buildCommitPrompt({ threadTitle: thread.title, nameStatus: diff.nameStatus, stat: diff.stat, files: diff.files });
  const { text } = await backgroundShot(bg, prompt, signal);
  const parsed = parseCommitMessage(text);
  if (!parsed) throw new Error(`${bg.label} didn't return a message. Try again or write one.`);
  const coAuthor = (d.settings().git ?? GIT_DEFAULTS).coAuthor ? coAuthorFor(thread.agent) : null;
  return { message: formatCommitMessage(parsed, coAuthor), model: bg.label };
}

/** Commit everything in the thread's worktree. */
export async function commitThread(d: ReviewDeps, threadId: string, message: string): Promise<string> {
  if (!message.trim()) throw new Error("Write a commit message first.");
  return commitAll(worktreeOf(d, threadId).dir, message.trim());
}

/** Merge the thread's branch into its base in the project folder. Uncommitted worktree changes aren't included. */
export async function mergeThread(d: ReviewDeps, threadId: string, o: { mode: "squash" | "merge"; message: string }): Promise<MergeResult> {
  const { thread, project, dir, branch } = worktreeOf(d, threadId);
  const base = await baseOf(thread, project, dir);
  if (!base.branch) return { ok: false, reason: "Couldn't tell which branch this worktree came from.", conflicts: [] };
  if ((await dirtyPaths(dir)).length) return { ok: false, reason: "The worktree has uncommitted changes. Commit them first.", conflicts: [] };
  if (!o.message.trim()) return { ok: false, reason: "Write a commit message first.", conflicts: [] };
  return mergeInto(project.path, { branch, base: base.branch, mode: o.mode, message: o.message.trim() });
}

/** Remove the thread's worktree folder when it's clean (its branch stays); returns whether it went. */
export async function removeThreadWorktree(d: ReviewDeps, threadId: string): Promise<boolean> {
  const { project, dir } = worktreeOf(d, threadId);
  return removeWorktree(project.path, dir);
}
