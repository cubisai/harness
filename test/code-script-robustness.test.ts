// Scripts the way small models write them, run through the real run_code path (real read/glob/grep, a real folder).
// A script that works must give a usable answer; one that fails must say why, so the model's next try can fix it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodeServer } from "../src/main/code-mode";
import { tempDir } from "./helpers";

function setup() {
  const dir = tempDir();
  mkdirSync(join(dir, "src", "shared"), { recursive: true });
  writeFileSync(join(dir, "src", "shared", "a.ts"), 'export const alpha = 1;\nexport function beta() {}\n');
  writeFileSync(join(dir, "src", "shared", "b.ts"), 'import { alpha } from "./a";\nexport const gamma = alpha;\n');
  writeFileSync(join(dir, "README.md"), "# hi\n");
  const codes = createCodeServer({
    cwdOf: () => dir,
    projectOf: () => undefined,
    appTools: () => [],
    parentOf: () => "p1",
    emit: () => {},
    outputDir: tempDir(),
    guardScript: "builtin",
    parentWaitMs: 0,
  });
  return (code: string) => codes.tool("t").run({ code } as never, undefined) as Promise<{ text: string; isError?: boolean }>;
}

describe("run_code scripts as models write them", () => {
  it("reads many files with Promise.all over a glob", async () => {
    const run = setup();
    const r = await run('const files = await tools.glob({ pattern: "src/shared/*.ts" }); const texts = await Promise.all(files.map((f) => tools.read({ path: f }))); return texts.map((t) => t.split("\\n").length);');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("[3,3]");
  });

  it("lists a folder by reading it", async () => {
    const run = setup();
    const r = await run('return await tools.read({ path: "src" });');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("shared");
  });

  it("takes bare strings for glob and grep too", async () => {
    const run = setup();
    const r = await run('const g = await tools.glob("src/**/*.ts"); const m = await tools.grep("alpha"); return { g: g.length, m: m.length };');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('"g":2');
    expect(r.text).toContain('"m":2');
  });

  it("greps content rows with line numbers", async () => {
    const run = setup();
    const r = await run('const rows = await tools.grep({ pattern: "^export", path: "src", output_mode: "content" }); return rows.map((x) => `${x.path}:${x.line}`);');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("a.ts:1");
  });

  it("lets a script survive a failed read with try/catch", async () => {
    const run = setup();
    const r = await run('let msg = "none"; try { await tools.read({ path: "nope.txt" }); } catch (e) { msg = String(e.message ?? e); } return msg;');
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toContain("=> none");
  });

  it("returns objects as JSON and keeps console.log lines", async () => {
    const run = setup();
    const r = await run('console.log("step 1"); return { ok: true };');
    expect(r.text).toContain("step 1");
    expect(r.text).toContain('{"ok":true}');
  });

  it("reports a syntax error as an error with a message", async () => {
    const run = setup();
    const r = await run("const x = ;");
    expect(r.isError).toBe(true);
    expect(r.text.length).toBeGreaterThan(5);
  });

  it("reports a thrown error as an error with the message", async () => {
    const run = setup();
    const r = await run('throw new Error("boom");');
    expect(r.isError).toBe(true);
    expect(r.text).toContain("boom");
  });

  it("says what is missing when a script uses require or import", async () => {
    const run = setup();
    const r = await run('const fs = require("fs"); return fs.readdirSync(".");');
    expect(r.isError).toBe(true);
    expect(r.text.toLowerCase()).toMatch(/require|module|not defined/);
  });

  it("names the available tools when a script calls one that does not exist", async () => {
    const run = setup();
    const r = await run('return await tools.shell({ command: "ls" });');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read|glob|grep/);
  });

  it("returns an answer for a script that wraps itself in an async IIFE and returns it", async () => {
    const run = setup();
    const r = await run('return await (async () => { const g = await tools.glob("*.md"); return g; })();');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("README.md");
  });

  it("bounds a huge result instead of flooding the model", async () => {
    const run = setup();
    const r = await run('return "x".repeat(2_000_000);');
    expect(r.text.length).toBeLessThan(200_000);
  });

  it("stops a script that never ends", async () => {
    const run = setup();
    const r = await run("while (true) {}");
    expect(r.isError).toBe(true);
  }, 60_000);

  it("keeps working after a failed script (state of one run does not break the next)", async () => {
    const run = setup();
    await run('store("k", 1); throw new Error("x");');
    const r = await run('return load("k") ?? "empty";');
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("empty");
  });
});
