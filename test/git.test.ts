import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchLabel, parseUnifiedDiff, workingTreeDiff } from "../src/main/git";
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
