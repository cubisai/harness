import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aheadBehind, branchDiff, commitAll, currentBranch, headSha, mergeBase, mergeInto } from "../src/main/git";
import { tempDir } from "./helpers";

const gitIn = (cwd: string) => (...args: string[]) => execFileSync("git", args, { cwd });

const repo = () => {
  const dir = tempDir();
  const git = gitIn(dir);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git };
};

/** `main` plus a `feat` worktree, the shape a thread's branch has before review. */
const withFeature = () => {
  const { dir, git } = repo();
  const feat = join(tempDir(), "feat");
  git("worktree", "add", "-b", "feat", feat, "HEAD");
  return { dir, git, feat, featGit: gitIn(feat) };
};

describe("branch bookkeeping", () => {
  it("reads the branch and HEAD", async () => {
    const { dir, feat } = withFeature();
    expect(await currentBranch(dir)).toBe("main");
    expect(await currentBranch(feat)).toBe("feat");
    expect(await headSha(dir)).toBe(await headSha(feat));
    expect(await headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is null outside a repository and on a detached HEAD", async () => {
    const { dir, git } = withFeature();
    expect(await currentBranch(tempDir())).toBeNull();
    expect(await headSha(tempDir())).toBeNull();
    git("checkout", "-q", "--detach");
    expect(await currentBranch(dir)).toBeNull();
    expect(await headSha(dir)).not.toBeNull();
  });

  it("counts commits ahead and behind and finds the fork point", async () => {
    const { dir, git, feat, featGit } = withFeature();
    const fork = await headSha(dir);
    expect(await mergeBase(dir, "main", "feat")).toBe(fork);
    expect(await aheadBehind(dir, "main", "feat")).toEqual({ ahead: 0, behind: 0 });

    writeFileSync(join(feat, "b.txt"), "b\n");
    featGit("add", ".");
    featGit("commit", "-qm", "feat work");
    expect(await aheadBehind(dir, "main", "feat")).toEqual({ ahead: 1, behind: 0 });

    writeFileSync(join(dir, "c.txt"), "c\n");
    git("add", ".");
    git("commit", "-qm", "main work");
    expect(await aheadBehind(dir, "main", "feat")).toEqual({ ahead: 1, behind: 1 });
    expect(await mergeBase(dir, "main", "feat")).toBe(fork);
  });
});

describe("branchDiff", () => {
  it("includes committed, uncommitted and untracked changes, with per-file patches", async () => {
    const { feat, featGit } = withFeature();
    const base = (await headSha(feat))!;

    writeFileSync(join(feat, "committed.txt"), "hello\n");
    featGit("add", ".");
    featGit("commit", "-qm", "committed");
    writeFileSync(join(feat, "a.txt"), "one\ntwo\n");
    writeFileSync(join(feat, "untracked.txt"), "fresh\n");

    const diff = await branchDiff(feat, base);
    expect(diff.nameStatus).toContain("A\tcommitted.txt");
    expect(diff.nameStatus).toContain("M\ta.txt");
    expect(diff.nameStatus).toContain("A\tuntracked.txt");
    expect(diff.untracked).toEqual(["untracked.txt"]);
    expect(diff.stat).toContain("committed.txt");
    expect(diff.files.map((f) => f.path).sort()).toEqual(["a.txt", "committed.txt", "untracked.txt"]);

    const committed = diff.files.find((f) => f.path === "committed.txt")!;
    expect(committed.patch.startsWith("diff --git a/committed.txt b/committed.txt")).toBe(true);
    expect(committed.patch).toContain("+hello");
    expect(diff.files.find((f) => f.path === "a.txt")!.patch).toContain("+two");
    expect(diff.files.find((f) => f.path === "untracked.txt")!.patch).toBe("new file: untracked.txt");
  });
});

describe("commitAll", () => {
  it("commits every change and returns the new HEAD", async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    const before = await headSha(dir);

    const sha = await commitAll(dir, "one change");
    expect(sha).not.toBe(before);
    expect(await headSha(dir)).toBe(sha);
    expect(git("show", "-s", "--format=%s", "HEAD").toString().trim()).toBe("one change");
    expect(git("status", "--porcelain").toString().trim()).toBe("");
  });

  it("throws when there is nothing to commit", async () => {
    const { dir } = repo();
    await expect(commitAll(dir, "empty")).rejects.toThrow("Nothing to commit.");
  });
});

describe("mergeInto", () => {
  it("squashes a branch into one commit on the base", async () => {
    const { dir, git, feat, featGit } = withFeature();
    writeFileSync(join(feat, "feature.txt"), "from feat\n");
    featGit("add", ".");
    featGit("commit", "-qm", "feat work");
    const before = await headSha(dir);

    const res = await mergeInto(dir, { branch: "feat", base: "main", mode: "squash", message: "Merge feat" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sha).not.toBe(before);
    expect(res.sha).toBe(await headSha(dir));
    expect(git("show", "-s", "--format=%s", "HEAD").toString().trim()).toBe("Merge feat");
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").toString().trim().split(" ")).toHaveLength(2);
    expect(readFileSync(join(dir, "feature.txt"), "utf8")).toBe("from feat\n");
    expect(await currentBranch(dir)).toBe("main");
  });

  it("creates a merge commit with two parents", async () => {
    const { dir, git, feat, featGit } = withFeature();
    writeFileSync(join(feat, "feature.txt"), "from feat\n");
    featGit("add", ".");
    featGit("commit", "-qm", "feat work");

    const res = await mergeInto(dir, { branch: "feat", base: "main", mode: "merge", message: "Merge feat" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sha).toBe(await headSha(dir));
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").toString().trim().split(" ")).toHaveLength(3);
    expect(git("show", "-s", "--format=%s", "HEAD").toString().trim()).toBe("Merge feat");
    expect(readFileSync(join(dir, "feature.txt"), "utf8")).toBe("from feat\n");
  });

  for (const mode of ["squash", "merge"] as const) {
    it(`rolls back a ${mode} merge that conflicts`, async () => {
      const { dir, git, feat, featGit } = withFeature();
      writeFileSync(join(feat, "a.txt"), "feat\n");
      featGit("commit", "-qam", "feat edit");
      writeFileSync(join(dir, "a.txt"), "main\n");
      git("commit", "-qam", "main edit");
      const head = await headSha(dir);

      const res = await mergeInto(dir, { branch: "feat", base: "main", mode, message: "Merge feat" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.conflicts).toEqual(["a.txt"]);
      expect(res.reason).toBe("Merge conflicts: nothing was changed.");
      expect(await headSha(dir)).toBe(head);
      expect(git("status", "--porcelain").toString().trim()).toBe("");
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("main\n");
    });
  }

  it("refuses a project with uncommitted changes", async () => {
    const { dir } = withFeature();
    writeFileSync(join(dir, "a.txt"), "uncommitted\n");
    expect(await mergeInto(dir, { branch: "feat", base: "main", mode: "squash", message: "x" })).toEqual({
      ok: false,
      reason: "The project has uncommitted changes. Commit or stash them first.",
      conflicts: [],
    });
  });

  it("refuses when the project is not on the base branch", async () => {
    const { dir, git } = withFeature();
    git("checkout", "-qb", "other");
    expect(await mergeInto(dir, { branch: "feat", base: "main", mode: "merge", message: "x" })).toEqual({
      ok: false,
      reason: "The project is on other, not main. Switch to main first.",
      conflicts: [],
    });
  });

  it("refuses when the branch has nothing new", async () => {
    const { dir } = withFeature();
    expect(await mergeInto(dir, { branch: "feat", base: "main", mode: "squash", message: "x" })).toEqual({
      ok: false,
      reason: "Nothing to merge: the branch has no commits the base doesn't have.",
      conflicts: [],
    });
  });
});
