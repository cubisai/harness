import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { readTool } from "../src/main/harness/tools/read";
import { writeTool } from "../src/main/harness/tools/write";
import type { ToolContext } from "../src/main/harness/tools/types";

let dir: string;

function context(): ToolContext {
  return {
    cwd: dir,
    signal: new AbortController().signal,
    outputDir: join(dir, ".out"),
    callId: "c1",
    reads: new Map(),
    guardScript: BUILT_IN_GUARD,
  };
}

describe("harness read and write tools", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an absolute path outside the thread's folder (a team member's own SKILL.md)", async () => {
    const skills = mkdtempSync(join(tmpdir(), "skills-"));
    try {
      writeFileSync(join(skills, "SKILL.md"), "# Deep dive");
      const out = await readTool.run({ path: join(skills, "SKILL.md") }, context());
      expect(out.isError).toBeFalsy();
      expect(out.text).toContain("# Deep dive");
    } finally {
      rmSync(skills, { recursive: true, force: true });
    }
  });

  it("numbers lines and pages with offset/limit and a continuation note", async () => {
    writeFileSync(join(dir, "lines.txt"), ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"));
    const ctx = context();

    const first = await readTool.run({ path: "lines.txt", limit: 2 }, ctx);
    expect(first.text).toBe("     1\tline 1\n     2\tline 2\n\n[Lines 1-2 of 5. Use offset=3 to read more.]");

    const middle = await readTool.run({ path: "lines.txt", offset: 3, limit: 2 }, ctx);
    expect(middle.text).toBe("     3\tline 3\n     4\tline 4\n\n[Lines 3-4 of 5. Use offset=5 to read more.]");

    const last = await readTool.run({ path: "lines.txt", offset: 5 }, ctx);
    expect(last.text).toBe("     5\tline 5");
  });

  it("lists a directory with directories suffixed and no read record", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    mkdirSync(join(dir, "sub"));
    const ctx = context();

    const res = await readTool.run({ path: "." }, ctx);
    expect(res.text).toBe("a.txt\nb.txt\nsub/");
    expect(res.display?.summary).toBe(".");
    expect(ctx.reads.size).toBe(0);
  });

  it("refuses a binary file", async () => {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
    await expect(readTool.run({ path: "bin.dat" }, context())).rejects.toThrow(/is a binary file/);
  });

  it("reports a missing file", async () => {
    await expect(readTool.run({ path: "nope.txt" }, context())).rejects.toThrow(/No such file/);
  });

  it("bounds a huge file and saves the full output", async () => {
    const huge = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n");
    writeFileSync(join(dir, "huge.txt"), huge);
    const ctx = context();

    const res = await readTool.run({ path: "huge.txt" }, ctx);
    expect(res.text).toMatch(/full output is in/);
    const saved = join(dir, ".out", "c1.txt");
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved, "utf8").split("\n").length).toBeGreaterThan(2000);
  });

  it("returns a png as an image", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(dir, "pic.png"), png);

    const res = await readTool.run({ path: "pic.png" }, context());
    expect(res.text).toBe("Image pic.png");
    expect(res.imagePng).toBe(png.toString("base64"));
    expect(res.display?.summary).toBe("pic.png");
  });

  it("creates parent directories and returns the diff payload", async () => {
    const res = await writeTool.run({ path: "a/b/c.txt", content: "hello\nworld\n" }, context());
    expect(res.text).toBe("Created a/b/c.txt (2 lines)");
    expect(existsSync(join(dir, "a/b/c.txt"))).toBe(true);
    expect(readFileSync(join(dir, "a/b/c.txt"), "utf8")).toBe("hello\nworld\n");

    const result = res.display?.result as { diff: { path: string; unified: string }[] };
    expect(result.diff[0]!.path).toBe("a/b/c.txt");
    expect(result.diff[0]!.unified).toContain("new file mode 100644");
    expect(result.diff[0]!.unified).toContain("+++ b/a/b/c.txt");
    expect(result.diff[0]!.unified).toContain("+hello");
    expect(result.diff[0]!.unified).toContain("+world");
  });

  it("refuses to overwrite an existing file that wasn't read", async () => {
    writeFileSync(join(dir, "x.txt"), "old");
    await expect(writeTool.run({ path: "x.txt", content: "new" }, context())).rejects.toThrow(/Read .* before/);
  });

  it("writes after the file was read", async () => {
    writeFileSync(join(dir, "x.txt"), "old");
    const ctx = context();
    await readTool.run({ path: "x.txt" }, ctx);

    const res = await writeTool.run({ path: "x.txt", content: "new\n" }, ctx);
    expect(res.text).toBe("Wrote x.txt (1 lines)");
    expect(readFileSync(join(dir, "x.txt"), "utf8")).toBe("new\n");
  });

  it("refuses to write after the file changed on disk since the read", async () => {
    writeFileSync(join(dir, "x.txt"), "old");
    const ctx = context();
    await readTool.run({ path: "x.txt" }, ctx);
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(dir, "x.txt"), later, later);

    await expect(writeTool.run({ path: "x.txt", content: "new" }, ctx)).rejects.toThrow(/changed since/);
  });

  it("keeps CRLF line endings when rewriting a CRLF file", async () => {
    writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\n");
    const ctx = context();
    await readTool.run({ path: "crlf.txt" }, ctx);

    const res = await writeTool.run({ path: "crlf.txt", content: "x\ny\n" }, ctx);
    expect(res).toBeDefined();
    expect(readFileSync(join(dir, "crlf.txt"), "utf8")).toBe("x\r\ny\r\n");
  });
});
