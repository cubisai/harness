import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, workingTreeDiff } from "../src/main/git";
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
