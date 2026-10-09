import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { globTool, globToRegExp } from "../src/main/harness/tools/glob";
import { grepTool } from "../src/main/harness/tools/grep";
import { ToolError, type ToolContext } from "../src/main/harness/tools/types";

let root: string;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: root,
    signal: new AbortController().signal,
    outputDir: join(root, ".out"),
    callId: "c1",
    reads: new Map(),
    guardScript: BUILT_IN_GUARD,
    ...over,
  };
}

/** No rg on PATH, so grep takes its in-process fallback. */
const fallback = (): ToolContext => ctx({ env: { PATH: "" } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-"));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "// header\nconst alpha = 42;\nconst BETA = 1;\n");
  writeFileSync(join(root, "src", "b.tsx"), "export const beta = () => 1;\r\n");
  writeFileSync(join(root, "src", "deep", "c.ts"), "const gamma = 7;\n");
  writeFileSync(join(root, "README.md"), "# Title\nalpha appears here too\n");
  writeFileSync(join(root, "node_modules", "x", "i.ts"), "const alpha = 999;\n");
  writeFileSync(join(root, ".git", "config"), "[core]\nalpha\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 97, 108, 112, 104, 97, 0]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  it("anchors, keeps * within a segment, and makes **/ cross directories", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("src/deep/c.ts")).toBe(true);
  });

  it("expands brace alternation and matches ? as one non-slash char", () => {
    expect(globToRegExp("src/*.{ts,tsx}").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.{ts,tsx}").test("src/b.tsx")).toBe(true);
    expect(globToRegExp("src/*.{ts,tsx}").test("src/x/y.ts")).toBe(false);
    expect(globToRegExp("?.md").test("a.md")).toBe(true);
    expect(globToRegExp("?.md").test("ab.md")).toBe(false);
  });
});

describe("globTool", () => {
  it("finds **/*.ts at any depth but never under node_modules or .git", async () => {
    const res = await globTool.run({ pattern: "**/*.ts" }, ctx());
    expect(res.text).toContain("src/a.ts");
    expect(res.text).toContain("src/deep/c.ts");
    expect(res.text).not.toContain("node_modules");
    expect(res.text).not.toContain(".git");
  });

  it("treats *.md as top-level only", async () => {
    const res = await globTool.run({ pattern: "*.md" }, ctx());
    expect(res.text.trim()).toBe("README.md");
  });

  it("reports the pattern when nothing matches", async () => {
    const res = await globTool.run({ pattern: "*.zzz" }, ctx());
    expect(res.text).toBe("No files match *.zzz");
  });
});

describe("grepTool", () => {
  it("lists matching files relative to cwd", async () => {
    const res = await grepTool.run({ pattern: "gamma" }, fallback());
    expect(res.text.trim()).toBe("src/deep/c.ts");
  });

  it("returns matching lines with line numbers, stripping CRLF", async () => {
    const res = await grepTool.run({ pattern: "beta", glob: "*.tsx", ignore_case: true, output_mode: "content" }, fallback());
    expect(res.text).toBe("src/b.tsx:1:export const beta = () => 1;");
  });

  it("counts matches per file without descending into skipped folders", async () => {
    const res = await grepTool.run({ pattern: "alpha", output_mode: "count" }, fallback());
    expect(res.text).toContain("src/a.ts:1");
    expect(res.text).toContain("README.md:1");
    expect(res.text).not.toContain("node_modules");
    expect(res.text).not.toContain(".git");
  });

  it("honors ignore_case", async () => {
    const sensitive = await grepTool.run({ pattern: "beta" }, fallback());
    expect(sensitive.text).toContain("src/b.tsx");
    expect(sensitive.text).not.toContain("src/a.ts");
    const insensitive = await grepTool.run({ pattern: "beta", ignore_case: true }, fallback());
    expect(insensitive.text).toContain("src/b.tsx");
    expect(insensitive.text).toContain("src/a.ts");
  });

  it("restricts the search to the glob filter", async () => {
    const res = await grepTool.run({ pattern: "beta", glob: "*.tsx", ignore_case: true }, fallback());
    expect(res.text.trim()).toBe("src/b.tsx");
  });

  it("skips binary files", async () => {
    const res = await grepTool.run({ pattern: "alpha" }, fallback());
    expect(res.text).not.toContain("bin.dat");
  });

  it("rejects an invalid regular expression as a ToolError", async () => {
    await expect(grepTool.run({ pattern: "(" }, fallback())).rejects.toThrow(ToolError);
  });
});
