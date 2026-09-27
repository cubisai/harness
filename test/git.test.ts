import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchLabel, createWorktree, listProjectFiles, parseUnifiedDiff, removeWorktree, workingTreeDiff, worktreeBranch } from "../src/main/git";
import { tempDir } from "./helpers";

describe("parseUnifiedDiff", () => {
  it("parses files, hunks, and counts", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/a.txt b/a.txt",
        "index 1..2 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
        "diff --git a/b.txt b/b.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/b.txt",
        "@@ -0,0 +1 @@",
        "+hello",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["b.txt", "added", 1, 0],
    ]);
    expect(files[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(["context", "del", "add"]);
  });
});

describe("workingTreeDiff", () => {
  it("includes tracked edits and untracked files", async () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    const files = await workingTreeDiff(dir);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["new.txt", "untracked"],
    ]);
  });

  it("is empty outside a git repository", async () => {
    expect(await workingTreeDiff(tempDir())).toEqual([]);
  });
});

describe("listProjectFiles", () => {
  const repo = () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), "x\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "junk\n");
    return dir;
  };

  it("lists tracked and untracked-not-ignored files, never .gitignore'd ones", async () => {
    const { files, truncated } = await listProjectFiles(repo());
    expect(files).toEqual([".gitignore", "a.txt", "src/b.ts"]);
    expect(truncated).toBe(false);
  });

  it("walks the tree outside a git repository, skipping .git and node_modules", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "one\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "c.txt"), "x\n");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "y.js"), "junk\n");
    expect(await listProjectFiles(dir)).toEqual({ files: ["a.txt", "sub/c.txt"], truncated: false });
  });

  it("cuts at the limit and reports truncation", async () => {
    const { files, truncated } = await listProjectFiles(repo(), 1);
    expect(files).toEqual([".gitignore"]);
    expect(truncated).toBe(true);
  });

  it("stops walking a non-git folder at the limit", async () => {
    const dir = tempDir();
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(dir, name), "x\n");
    const { files, truncated } = await listProjectFiles(dir, 1);
    expect(files).toHaveLength(1);
    expect(truncated).toBe(true);
  });
});

describe("branchLabel", () => {
  const repo = () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    return { dir, git };
  };

  it("is null on the default branch and names any other", async () => {
    const { dir, git } = repo();
    expect(await branchLabel(dir)).toBeNull();
    git("checkout", "-qb", "feat/x");
    expect(await branchLabel(dir)).toBe("feat/x");
  });

  it("is null when detached or outside a repository", async () => {
    const { dir, git } = repo();
    git("checkout", "-q", "--detach");
    expect(await branchLabel(dir)).toBeNull();
    expect(await branchLabel(tempDir())).toBeNull();
  });
});

describe("worktree helpers", () => {
  const repo = () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    return { dir, git };
  };

  it("names a worktree branch from the title and thread id", () => {
    expect(worktreeBranch("Fix Login!", "abc-123-def")).toBe("harness/fix-login-abc123");
    expect(worktreeBranch("", "zz")).toBe("harness/thread-zz");
  });

  it("creates the branch and checks it out in the worktree folder", async () => {
    const { dir, git } = repo();
    const worktree = join(tempDir(), "wt");
    await createWorktree(dir, worktree, "harness/test-1");
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree }).toString().trim()).toBe("harness/test-1");
    expect(git("branch", "--list", "harness/test-1").toString()).toContain("harness/test-1");
  });

  it("refuses outside a git repository", async () => {
    await expect(createWorktree(tempDir(), join(tempDir(), "wt"), "harness/x")).rejects.toThrow(/git repository/);
  });

  it("refuses a repository with no commits", async () => {
    const dir = tempDir();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await expect(createWorktree(dir, join(tempDir(), "wt"), "harness/x")).rejects.toThrow(/no commits/);
  });

  it("removes a clean worktree but leaves a dirty one", async () => {
    const { dir } = repo();
    const clean = join(tempDir(), "clean");
    await createWorktree(dir, clean, "harness/clean");
    expect(await removeWorktree(dir, clean)).toBe(true);
    expect(existsSync(clean)).toBe(false);

    const dirty = join(tempDir(), "dirty");
    await createWorktree(dir, dirty, "harness/dirty");
    writeFileSync(join(dirty, "a.txt"), "changed\n");
    expect(await removeWorktree(dir, dirty)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
  });
});
