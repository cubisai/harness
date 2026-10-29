import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodeServer, type CodeServerDeps } from "../src/main/code-mode";
import { MAX_LISTED_CALLS } from "../src/main/harness/tools/code-broker";
import type { ThreadEvent } from "../src/shared/types";
import { tempDir } from "./helpers";

/** A small project: two sources that import each other, one doc, nothing else. */
function setup(patch: Partial<CodeServerDeps> = {}) {
  const dir = tempDir();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), 'export const A = 1;\nexport const UNUSED = 2;\n');
  writeFileSync(join(dir, "src", "b.ts"), 'import { A } from "./a";\nexport const B = A + 1;\n');
  writeFileSync(join(dir, "README.md"), "# demo\n");
  const events: ThreadEvent[] = [];
  const codes = createCodeServer({
    cwdOf: () => dir,
    projectOf: () => undefined,
    appTools: () => [],
    parentOf: () => "parent-1",
    emit: (_id, e) => events.push(e),
    outputDir: tempDir(),
    guardScript: "builtin",
    parentWaitMs: 0,
    ...patch,
  });
  const run = (code: string) => codes.tool("t1").run({ code } as never, undefined);
  return { dir, events, run };
}

describe("run_code script values", () => {
  it("gets glob, grep and read as plain values, not prose", async () => {
    const { run } = setup();
    const res = await run(`
      const files = await tools.glob({ pattern: "src/*.ts" });
      const counts = await tools.grep({ pattern: "export const", path: "src", output_mode: "count" });
      const rows = await tools.grep({ pattern: "import", path: "src", output_mode: "content" });
      const text = await tools.read({ path: "src/a.ts" });
      return { files: files.sort(), counts, rows, first: text.split("\\n")[0], isArray: Array.isArray(files) };
    `);
    expect(res.isError).toBeFalsy();
    const value = JSON.parse(res.text.slice(res.text.indexOf("=> ") + 3));
    expect(value).toEqual({
      files: ["src/a.ts", "src/b.ts"],
      counts: { "src/a.ts": 2, "src/b.ts": 1 },
      rows: [{ path: "src/b.ts", line: 1, text: 'import { A } from "./a";' }],
      first: "export const A = 1;",
      isArray: true,
    });
  });

  it("takes a bare string as the main argument, and output_mode files as files_with_matches", async () => {
    const { run } = setup();
    const res = await run(`
      const files = await tools.glob("src/*.ts");
      const first = (await tools.read("src/a.ts")).split("\\n")[0];
      const listing = await tools.read("src");
      const hits = await tools.grep({ pattern: "import", path: "src", output_mode: "files" });
      return { files: files.sort(), first, listing: listing.sort(), hits };
    `);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.text.slice(res.text.indexOf("=> ") + 3))).toEqual({ files: ["src/a.ts", "src/b.ts"], first: "export const A = 1;", listing: ["a.ts", "b.ts"], hits: ["src/b.ts"] });
  });

  it("answers no match with an empty value instead of a sentence a script could read as a path", async () => {
    const { run } = setup();
    const res = await run(`
      const none = await tools.glob({ pattern: "**/*.py" });
      const missing = await tools.grep({ pattern: "NOT_THERE_ANYWHERE" });
      const counts = await tools.grep({ pattern: "NOT_THERE_ANYWHERE", output_mode: "count" });
      return [none.length, missing.length, Object.keys(counts).length];
    `);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("=> [0,0,0]");
  });

  it("lists a script's first calls as rows and stands one note in for the rest", async () => {
    const { run, events } = setup();
    const res = await run(`
      let n = 0;
      for (let i = 0; i < ${MAX_LISTED_CALLS + 15}; i++) n += (await tools.glob({ pattern: "src/*.ts" })).length;
      return n;
    `);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain(`=> ${(MAX_LISTED_CALLS + 15) * 2}`);
    const uses = events.filter((e) => e.kind === "tool-use");
    expect(uses).toHaveLength(MAX_LISTED_CALLS + 1);
    expect(uses.at(-1)).toMatchObject({ name: "Note" });
  });

  it("survives a script that ends while calls are still in flight", async () => {
    const { run } = setup();
    // One call fails at once while others are pending: the script throws with live host promises.
    for (let i = 0; i < 3; i++) {
      const res = await run(`
        const slow = [1, 2, 3, 4].map(() => tools.grep({ pattern: "export", output_mode: "content" }));
        await tools.read({ path: "nope.txt" });
        await Promise.all(slow);
      `);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("No such file");
      expect(res.text).not.toContain("Assertion failed");
    }
    // And one that returns without awaiting what it started.
    const res = await run(`tools.grep({ pattern: "export" }); tools.glob({ pattern: "**/*" }); return "done";`);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("=> done");
  });

  it("describes the typed returns to the script", async () => {
    const { run } = setup();
    const res = await run(`return describeTool("glob") + "\\n" + describeTool("read");`);
    expect(res.text).toContain("Promise<string[]>");
    expect(res.text).toContain("Promise<string /* a file's raw text */ | string[] /* a directory's entries */>");
  });
});
