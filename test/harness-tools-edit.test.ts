import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { editTool, findMatches } from "../src/main/harness/tools/edit";
import { noteRead } from "../src/main/harness/tools/paths";
import type { ToolContext } from "../src/main/harness/tools/types";

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-"));
  ctx = {
    cwd: dir,
    signal: new AbortController().signal,
    outputDir: join(dir, ".out"),
    callId: "c1",
    reads: new Map(),
    guardScript: BUILT_IN_GUARD,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

/** Write a file and record it as read so the edit's freshness check passes. */
function seed(name: string, content: string): string {
  const abs = join(dir, name);
  writeFileSync(abs, content);
  noteRead(ctx, abs);
  return abs;
}

describe("edit tool", () => {
  it("replaces an exact match and returns a diff payload", async () => {
    seed("a.ts", "const x = 1;\nconst y = 2;\n");
    const res = await editTool.run({ path: "a.ts", old_string: "const x = 1;", new_string: "const x = 42;" }, ctx);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const x = 42;\nconst y = 2;\n");
    expect(res.text).toBe("Edited a.ts: 1 replacement(s)");
    expect(res.display?.summary).toBe("a.ts");
    const result = res.display?.result as { diff: { path: string; unified: string }[] };
    expect(result.diff[0]!.path).toBe("a.ts");
    expect(result.diff[0]!.unified).toContain("-const x = 1;");
    expect(result.diff[0]!.unified).toContain("+const x = 42;");
  });

  it("refuses a non-unique match unless replace_all is set", async () => {
    seed("b.ts", "const x = 1;\nconst x = 1;\n");
    await expect(editTool.run({ path: "b.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, ctx)).rejects.toThrow(/matches 2 places/);
  });

  it("replaces every match when replace_all is set", async () => {
    seed("c.ts", "a\na\na\n");
    const res = await editTool.run({ path: "c.ts", old_string: "a", new_string: "b", replace_all: true }, ctx);
    expect(readFileSync(join(dir, "c.ts"), "utf8")).toBe("b\nb\nb\n");
    expect(res.text).toBe("Edited c.ts: 3 replacement(s)");
  });

  it("keeps CRLF line endings", async () => {
    seed("d.txt", "one\r\ntwo\r\nthree\r\n");
    await editTool.run({ path: "d.txt", old_string: "two", new_string: "TWO" }, ctx);
    expect(readFileSync(join(dir, "d.txt"), "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("preserves a leading BOM", async () => {
    seed("e.txt", "\uFEFFhello world\n");
    await editTool.run({ path: "e.txt", old_string: "world", new_string: "there" }, ctx);
    const out = readFileSync(join(dir, "e.txt"), "utf8");
    expect(out).toBe("\uFEFFhello there\n");
  });

  it("matches with the line-trimmed strategy when only leading spaces differ", async () => {
    seed("f.ts", "function f() {\n  return 1;\n}\n");
    const res = await editTool.run({ path: "f.ts", old_string: "    return 1;", new_string: "  return 2;" }, ctx);
    expect(readFileSync(join(dir, "f.ts"), "utf8")).toBe("function f() {\n  return 2;\n}\n");
    expect(res.text).toContain("(matched with line-trimmed matching)");
  });

  it("matches with the whitespace strategy when spacing inside a line differs", async () => {
    seed("g.ts", "const x = 1;\nconst y = 2;\n");
    const res = await editTool.run({ path: "g.ts", old_string: "const  x  =  1;", new_string: "const x = 9;" }, ctx);
    expect(readFileSync(join(dir, "g.ts"), "utf8")).toBe("const x = 9;\nconst y = 2;\n");
    expect(res.text).toContain("(matched with whitespace matching)");
  });

  it("matches an indentation-different block", async () => {
    seed("h.ts", "if (x) {\n    a();\n    b();\n}\n");
    const res = await editTool.run({ path: "h.ts", old_string: "a();\nb();", new_string: "    c();\n    d();" }, ctx);
    expect(readFileSync(join(dir, "h.ts"), "utf8")).toBe("if (x) {\n    c();\n    d();\n}\n");
    expect(res.text).toContain("matching)");
  });

  it("matches with the block-anchor strategy when a middle line differs slightly", async () => {
    seed("i.ts", "function foo() {\n  return 1;\n}\n");
    const res = await editTool.run({ path: "i.ts", old_string: "function foo() {\n  return 2;\n}", new_string: "function foo() {\n  return 3;\n}" }, ctx);
    expect(readFileSync(join(dir, "i.ts"), "utf8")).toBe("function foo() {\n  return 3;\n}\n");
    expect(res.text).toContain("(matched with block-anchor matching)");
  });

  it("reports the strategy findMatches used", () => {
    expect(findMatches("a\nb\n", "a\nb\n").strategy).toBe("exact");
    expect(findMatches("  a();\n", "    a();").strategy).toBe("line-trimmed");
    expect(findMatches("const x = 1;\n", "const  x  =  1;").strategy).toBe("whitespace");
    expect(findMatches("function foo() {\n  return 1;\n}\n", "function foo() {\n  return 2;\n}").strategy).toBe("block-anchor");
  });

  it("errors when old_string is not found", async () => {
    seed("j.ts", "hello\n");
    await expect(editTool.run({ path: "j.ts", old_string: "goodbye", new_string: "x" }, ctx)).rejects.toThrow(/wasn't found in j\.ts/);
  });

  it("errors when the file was not read this session", async () => {
    writeFileSync(join(dir, "k.ts"), "hello\n");
    await expect(editTool.run({ path: "k.ts", old_string: "hello", new_string: "bye" }, ctx)).rejects.toThrow(/Read .* before/);
  });

  it("errors when the file does not exist", async () => {
    await expect(editTool.run({ path: "nope.ts", old_string: "a", new_string: "b" }, ctx)).rejects.toThrow(/No such file: nope\.ts/);
  });
});
