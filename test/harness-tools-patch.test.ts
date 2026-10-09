// Tests for the apply_patch tool: Codex's patch grammar, all-or-nothing writes,
// whitespace-tolerant hunk matching, CRLF preservation, and parse structure.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { applyPatchTool, parsePatch } from "../src/main/harness/tools/apply-patch";
import { ToolError, type ToolContext } from "../src/main/harness/tools/types";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  dirs.push(dir);
  return dir;
}

function ctxFor(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal, outputDir: join(cwd, ".out"), callId: "c1", reads: new Map(), guardScript: BUILT_IN_GUARD };
}

function write(cwd: string, name: string, content: string): void {
  writeFileSync(join(cwd, name), content);
}

function read(cwd: string, name: string): string {
  return readFileSync(join(cwd, name), "utf-8");
}

function runPatch(cwd: string, patch: string) {
  return applyPatchTool.run({ patch }, ctxFor(cwd));
}

describe("applyPatchTool", () => {
  it("adds a new file", async () => {
    const dir = tmp();
    const res = await runPatch(dir, "*** Begin Patch\n*** Add File: hello.txt\n+one\n+two\n*** End Patch\n");
    expect(read(dir, "hello.txt")).toBe("one\ntwo\n");
    expect(res.text).toBe("A hello.txt\nDone.");
    expect(res.display?.summary).toBe("hello.txt");
  });

  it("deletes a file", async () => {
    const dir = tmp();
    write(dir, "gone.txt", "bye\n");
    const res = await runPatch(dir, "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n");
    expect(existsSync(join(dir, "gone.txt"))).toBe(false);
    expect(res.text).toBe("D gone.txt\nDone.");
  });

  it("updates a file with one hunk", async () => {
    const dir = tmp();
    write(dir, "f.txt", "a\nb\nc\n");
    const res = await runPatch(dir, "*** Begin Patch\n*** Update File: f.txt\n@@\n a\n-b\n+B\n c\n*** End Patch\n");
    expect(read(dir, "f.txt")).toBe("a\nB\nc\n");
    expect(res.text).toBe("M f.txt\nDone.");
  });

  it("applies two hunks in one file", async () => {
    const dir = tmp();
    write(dir, "f.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\n");
    const patch = "*** Begin Patch\n*** Update File: f.txt\n@@\n l1\n-l2\n+x\n l3\n@@\n l5\n-l6\n+y\n l7\n*** End Patch\n";
    await runPatch(dir, patch);
    expect(read(dir, "f.txt")).toBe("l1\nx\nl3\nl4\nl5\ny\nl7\n");
  });

  it("uses an anchor to pick the right one of two identical blocks", async () => {
    const dir = tmp();
    write(dir, "f.txt", "function foo\na\nb\nfunction bar\na\nb\n");
    const patch = "*** Begin Patch\n*** Update File: f.txt\n@@ function bar\n a\n-b\n+B\n*** End Patch\n";
    await runPatch(dir, patch);
    expect(read(dir, "f.txt")).toBe("function foo\na\nb\nfunction bar\na\nB\n");
  });

  it("matches a hunk when the file has trailing whitespace", async () => {
    const dir = tmp();
    write(dir, "f.txt", "a\nb   \nc\n");
    const patch = "*** Begin Patch\n*** Update File: f.txt\n@@\n a\n-b\n+B\n c\n*** End Patch\n";
    await runPatch(dir, patch);
    expect(read(dir, "f.txt")).toBe("a\nB\nc\n");
  });

  it("moves a file (and can change it)", async () => {
    const dir = tmp();
    write(dir, "old.txt", "x\n");
    const res = await runPatch(dir, "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-x\n+y\n*** End Patch\n");
    expect(existsSync(join(dir, "old.txt"))).toBe(false);
    expect(read(dir, "new.txt")).toBe("y\n");
    expect(res.text).toBe("R old.txt -> new.txt\nDone.");
  });

  it("leaves the first file unchanged when a later file fails", async () => {
    const dir = tmp();
    const patch = "*** Begin Patch\n*** Add File: a.txt\n+nope\n*** Update File: missing.txt\n@@\n-x\n+y\n*** End Patch\n";
    await expect(runPatch(dir, patch)).rejects.toThrow(ToolError);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("preserves CRLF line endings", async () => {
    const dir = tmp();
    write(dir, "f.txt", "a\r\nb\r\n");
    const patch = "*** Begin Patch\n*** Update File: f.txt\n@@\n a\n-b\n+B\n*** End Patch\n";
    await runPatch(dir, patch);
    expect(read(dir, "f.txt")).toBe("a\r\nB\r\n");
  });

  it("rejects adding a file that already exists", async () => {
    const dir = tmp();
    write(dir, "f.txt", "old\n");
    await expect(runPatch(dir, "*** Begin Patch\n*** Add File: f.txt\n+new\n*** End Patch\n")).rejects.toThrow(/already exists/);
    expect(read(dir, "f.txt")).toBe("old\n");
  });

  it("rejects a patch missing the Begin marker", async () => {
    const dir = tmp();
    await expect(runPatch(dir, "*** Add File: x.txt\n+hi\n*** End Patch\n")).rejects.toThrow(ToolError);
    expect(existsSync(join(dir, "x.txt"))).toBe(false);
  });
});

describe("parsePatch", () => {
  it("reads sections, moves, hunks, anchors, and tolerates blank lines", () => {
    const text = "\n\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** Update File: b.txt\n*** Move to: c.txt\n@@ function foo\n ctx\n-old\n+new\n*** End Patch\n\n";
    const files = parsePatch(text);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ kind: "add", path: "a.txt", content: "hi\n" });
    expect(files[1]).toEqual({
      kind: "update",
      path: "b.txt",
      moveTo: "c.txt",
      hunks: [{ anchor: "function foo", lines: [{ op: " ", text: "ctx" }, { op: "-", text: "old" }, { op: "+", text: "new" }] }],
    });
  });
});
