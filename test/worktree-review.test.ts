import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver } from "../src/main/agents/types";
import { createWorktree } from "../src/main/git";
import { commitThread, draftMessage, mergeThread, removeThreadWorktree, reviewState, type ReviewDeps } from "../src/main/worktree-review";
import type { Project, Settings, Thread } from "../src/shared/types";
import { tempDir } from "./helpers";

function setup(opts: { recordBase?: boolean } = {}) {
  const repo = tempDir();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "T");
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
});
