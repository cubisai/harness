import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver } from "../src/main/agents/types";
import { createWorktree } from "../src/main/git";
import { commitThread, draftMessage, folderState, mergeThread, pushThread, removeThreadWorktree, reviewState, type ReviewDeps } from "../src/main/worktree-review";
import { DEFAULT_COMMIT_INSTRUCTIONS, type Project, type Settings, type Thread } from "../src/shared/types";
import { tempDir } from "./helpers";

function setup(opts: { recordBase?: boolean } = {}) {
  const repo = tempDir();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "T");
  // Windows runners default to autocrlf, which would turn the files' "\n" into "\r\n" on checkout.
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  const baseSha = git(repo, "rev-parse", "HEAD");
  return { repo, git, baseSha, recordBase: opts.recordBase !== false };
}

async function withWorktree(opts: { recordBase?: boolean; agent?: string; settings?: Partial<Settings>; reply?: string } = {}) {
  const s = setup(opts);
  const dir = join(tempDir(), "wt");
  await createWorktree(s.repo, dir, "harness/demo-abc123");
  s.git(dir, "config", "user.email", "t@t");
  s.git(dir, "config", "user.name", "T");
  const thread = {
    id: "t1",
    projectId: "p1",
    agent: opts.agent ?? "claude",
    title: "Add b",
    model: "m",
    branch: "harness/demo-abc123",
    worktreePath: dir,
    ...(s.recordBase ? { baseBranch: "main", baseSha: s.baseSha } : {}),
  } as unknown as Thread;
  const prompts: string[] = [];
  const driver = {
    id: "claude",
    label: "Claude",
    models: () => [{ id: "haiku", label: "Haiku" }],
    oneShot: async (req: { prompt: string }) => {
      prompts.push(req.prompt);
      return opts.reply ?? "```\nAdd b.txt with a greeting.\n```";
    },
  } as unknown as AgentDriver;
  const settings = { git: { commitModel: { agent: "claude", model: "haiku" }, coAuthor: false }, ...opts.settings } as unknown as Settings;
  const deps: ReviewDeps = { thread: () => thread, project: () => ({ id: "p1", path: s.repo, name: "demo" }) as Project, drivers: () => [driver], settings: () => settings };
  return { ...s, dir, thread, deps, prompts };
}

describe("worktree review", () => {
  it("shows uncommitted work and the files since the base", async () => {
    const w = await withWorktree();
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    const r = await reviewState(w.deps, "t1");
    expect(r).toMatchObject({ branch: "harness/demo-abc123", base: "main", baseSha: w.baseSha, ahead: 0, uncommitted: 1, projectBranch: "main", projectDirty: false });
    expect(r.files.map((f) => f.path)).toEqual(["b.txt"]);
  });

  it("writes a message from the uncommitted diff on the picked model, cleaned and without a trailer by default", async () => {
    const w = await withWorktree();
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    const { message, model } = await draftMessage(w.deps, "t1", new AbortController().signal);
    expect(message).toBe("Add b.txt with a greeting");
    expect(model).toBe("Claude · Haiku");
    expect(w.prompts[0]).toContain("Thread: Add b");
    expect(w.prompts[0]).toContain("b.txt");
  });

  it("adds the thread agent's Co-authored-by line only when the setting is on", async () => {
    const w = await withWorktree({ agent: "codex", settings: { git: { commitModel: { agent: "claude", model: "haiku" }, coAuthor: true } } as Partial<Settings> });
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    const { message } = await draftMessage(w.deps, "t1", new AbortController().signal);
    expect(message).toBe("Add b.txt with a greeting\n\nCo-authored-by: Codex <noreply@openai.com>");
  });

  it("commits, then squash-merges into the base with one commit", async () => {
    const w = await withWorktree();
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await commitThread(w.deps, "t1", "Add b");
    expect((await reviewState(w.deps, "t1")).ahead).toBe(1);
    const result = await mergeThread(w.deps, "t1", { mode: "squash", message: "Add b (squashed)" });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(w.repo, "b.txt"), "utf8")).toBe("hi\n");
    expect(w.git(w.repo, "log", "-1", "--format=%s")).toBe("Add b (squashed)");
    expect(w.git(w.repo, "log", "-1", "--format=%(trailers:key=Branch,valueonly)")).toBe("harness/demo-abc123");
  });

  it("merges into a branch no folder has out in a throwaway worktree, leaving the project folder alone", async () => {
    const w = await withWorktree();
    w.git(w.repo, "branch", "release");
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await commitThread(w.deps, "t1", "Add b");
    expect((await reviewState(w.deps, "t1")).targets).toEqual(["main", "release"]);
    const result = await mergeThread(w.deps, "t1", { mode: "squash", message: "feat: add b", target: "release" });
    expect(result.ok).toBe(true);
    expect(w.git(w.repo, "log", "-1", "--format=%s", "release")).toBe("feat: add b");
    expect(w.git(w.repo, "branch", "--show-current")).toBe("main");
    expect(w.git(w.repo, "status", "--porcelain")).toBe("");
    expect(w.git(w.repo, "worktree", "list").split("\n")).toHaveLength(2);
  });

  it("refuses an unknown target or the thread's own branch", async () => {
    const w = await withWorktree();
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await commitThread(w.deps, "t1", "Add b");
    expect(await mergeThread(w.deps, "t1", { mode: "squash", message: "x", target: "nope" })).toMatchObject({ ok: false, reason: "There's no local branch named nope." });
    expect(await mergeThread(w.deps, "t1", { mode: "squash", message: "x", target: "harness/demo-abc123" })).toMatchObject({ ok: false });
  });

  it("pushes the branch to the remote and tracks it", async () => {
    const w = await withWorktree();
    const remote = tempDir();
    w.git(remote, "init", "-q", "--bare");
    w.git(w.repo, "remote", "add", "origin", remote);
    expect(await reviewState(w.deps, "t1")).toMatchObject({ remote: "origin", unpushed: null });
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await commitThread(w.deps, "t1", "Add b");
    expect(await pushThread(w.deps, "t1")).toEqual({ remote: "origin", branch: "harness/demo-abc123" });
    expect(w.git(remote, "log", "-1", "--format=%s", "harness/demo-abc123")).toBe("Add b");
    expect((await reviewState(w.deps, "t1")).unpushed).toBe(0);
  });

  it("says so when there's no remote to push to", async () => {
    const w = await withWorktree();
    expect((await reviewState(w.deps, "t1")).remote).toBeNull();
    await expect(pushThread(w.deps, "t1")).rejects.toThrow("no git remote");
  });

  it("gives the model the default style rules, or the user's own", async () => {
    const w = await withWorktree();
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await draftMessage(w.deps, "t1", new AbortController().signal);
    expect(w.prompts[0]).toContain(DEFAULT_COMMIT_INSTRUCTIONS);
    const own = await withWorktree({ settings: { git: { commitModel: { agent: "claude", model: "haiku" }, coAuthor: false, instructions: "- One short line, no body." } } as Partial<Settings> });
    writeFileSync(join(own.dir, "b.txt"), "hi\n");
    await draftMessage(own.deps, "t1", new AbortController().signal);
    expect(own.prompts[0]).toContain("- One short line, no body.");
    expect(own.prompts[0]).not.toContain(DEFAULT_COMMIT_INSTRUCTIONS);
    expect(own.prompts[0]).toContain("Output only the message");
  });

  it("refuses to merge while the worktree has uncommitted changes", async () => {
    const w = await withWorktree();
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    const result = await mergeThread(w.deps, "t1", { mode: "squash", message: "x" });
    expect(result).toEqual({ ok: false, reason: "The worktree has uncommitted changes. Commit them first.", conflicts: [] });
  });

  it("finds the base of an older thread from the project's branch", async () => {
    const w = await withWorktree({ recordBase: false });
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await commitThread(w.deps, "t1", "Add b");
    const r = await reviewState(w.deps, "t1");
    expect(r).toMatchObject({ base: "main", baseSha: w.baseSha, ahead: 1 });
  });

  it("explains a model that returns nothing usable", async () => {
    const w = await withWorktree({ reply: "   " });
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await expect(draftMessage(w.deps, "t1", new AbortController().signal)).rejects.toThrow("didn't return a message");
  });

  it("removes a clean worktree and keeps a dirty one", async () => {
    const w = await withWorktree();
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    expect(await removeThreadWorktree(w.deps, "t1")).toBe(false);
    await commitThread(w.deps, "t1", "Add b");
    expect(await removeThreadWorktree(w.deps, "t1")).toBe(true);
  });

  it("remembers a squash merge, so the same commits aren't merged twice and new ones can be", async () => {
    const w = await withWorktree();
    const t = w.thread as Thread & { mergedSha?: string; mergedInto?: string };
    w.deps.recordMerge = (_id, sha, into) => {
      t.mergedSha = sha;
      t.mergedInto = into;
    };
    writeFileSync(join(w.dir, "b.txt"), "hi\n");
    await commitThread(w.deps, "t1", "Add b");
    expect((await reviewState(w.deps, "t1")).merged).toBeNull();
    expect((await mergeThread(w.deps, "t1", { mode: "squash", message: "Add b" })).ok).toBe(true);
    expect(t.mergedSha).toBe(w.git(w.dir, "rev-parse", "HEAD"));
    // A squash leaves the branch "ahead", but it is merged and up to date.
    const after = await reviewState(w.deps, "t1");
    expect(after.ahead).toBe(1);
    expect(after.merged).toEqual({ into: "main", upToDate: true });
    const again = await mergeThread(w.deps, "t1", { mode: "squash", message: "Add b" });
    expect(again).toMatchObject({ ok: false, reason: "Already merged into main: there are no new commits since." });
    writeFileSync(join(w.dir, "c.txt"), "more\n");
    await commitThread(w.deps, "t1", "Add c");
    expect((await reviewState(w.deps, "t1")).merged).toEqual({ into: "main", upToDate: false });
    expect((await mergeThread(w.deps, "t1", { mode: "squash", message: "Add c" })).ok).toBe(true);
    expect(readFileSync(join(w.repo, "c.txt"), "utf8")).toBe("more\n");
  });

  it("commits and describes changes in the project folder for a thread without a worktree", async () => {
    const w = await withWorktree();
    const plain = { ...w.thread, branch: null, worktreePath: null } as unknown as Thread;
    const deps: ReviewDeps = { ...w.deps, thread: () => plain };
    expect(await folderState(deps, "t1")).toMatchObject({ branch: "main", worktree: false, uncommitted: 0, remote: null });
    writeFileSync(join(w.repo, "p.txt"), "proj\n");
    expect((await folderState(deps, "t1"))?.uncommitted).toBe(1);
    const { message } = await draftMessage(deps, "t1", new AbortController().signal);
    expect(message).toBe("Add b.txt with a greeting");
    await commitThread(deps, "t1", "Add p");
    expect(w.git(w.repo, "log", "-1", "--format=%s")).toBe("Add p");
    expect((await folderState(deps, "t1"))?.uncommitted).toBe(0);
    await expect(draftMessage(deps, "t1", new AbortController().signal)).rejects.toThrow("There are no changes to describe.");
    await expect(pushThread(deps, "t1")).rejects.toThrow("no git remote");
  });

  it("reports the worktree as the folder of a worktree thread, and nothing for a chat's own folder", async () => {
    const w = await withWorktree();
    expect(await folderState(w.deps, "t1")).toMatchObject({ branch: "harness/demo-abc123", worktree: true });
    const chat = { ...w.thread, branch: null, worktreePath: tempDir() } as unknown as Thread;
    expect(await folderState({ ...w.deps, thread: () => chat }, "t1")).toBeNull();
  });
});
