// CM2 regressions: caches go with their thread or age out, a script's console
// can't fill memory (or bury its error), big files are read as a window, a
// script's glob stops at the cap before statting, and effects always get rows.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeMode, ThreadEvent } from "../src/shared/types";
import { BoundedMap, BoundedSet } from "../src/main/bounded";
import { codeModes, createCodeServer } from "../src/main/code-mode";
import type { LoopTool } from "../src/main/harness/loop";
import { createCodeTool } from "../src/main/harness/tools/code";
import { createCodeBroker, MAX_LISTED_CALLS } from "../src/main/harness/tools/code-broker";
import { globTool } from "../src/main/harness/tools/glob";
import { readTool } from "../src/main/harness/tools/read";
import type { ToolContext } from "../src/main/harness/tools/types";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cm2-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tool = (name: string, over: Partial<LoopTool> = {}): LoopTool => ({
  definition: { name, description: name, parameters: { type: "object", properties: {} } },
  displayName: name,
  access: "read",
  summarize: () => name,
  run: async () => ({ text: `${name} ok` }),
  ...over,
});
const call = () => ({ id: "c1", signal: new AbortController().signal, onOutput: () => {} });
const ctxIn = (cwd: string, script = false): ToolContext => ({ cwd, signal: new AbortController().signal, outputDir: join(cwd, ".out"), callId: "c", reads: new Map(), ...(script ? { script: true } : {}) }) as ToolContext;

describe("BoundedMap / BoundedSet", () => {
  it("keeps the newest keys, a read counting as use", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1).set("b", 2);
    m.get("a");
    m.set("c", 3);
    expect([...m.keys()]).toEqual(["a", "c"]);
    for (let i = 0; i < 100; i++) m.set(`k${i}`, i);
    expect(m.size).toBe(2);
  });
  it("set: has() touches, add() evicts the oldest", () => {
    const s = new BoundedSet<string>(2);
    s.add("a").add("b");
    expect(s.has("a")).toBe(true);
    s.add("c");
    expect(s.has("b")).toBe(false);
    expect(s.has("a")).toBe(true);
  });
});

describe("thread eviction", () => {
  it("codeModes.forget re-reads the setting", () => {
    let mode: CodeMode = "on";
    const m = codeModes(() => mode);
    expect(m("t")).toBe("on");
    mode = "off";
    expect(m("t")).toBe("on");
    m.forget("t");
    expect(m("t")).toBe("off");
  });

  it("createCodeServer.forget drops the thread's store and tool", async () => {
    const dir = tmp();
    const codes = createCodeServer({ cwdOf: () => dir, projectOf: () => undefined, appTools: () => [], parentOf: () => "p", emit: () => {}, outputDir: tmp(), guardScript: "builtin", parentWaitMs: 0 });
    const run = (code: string) => codes.tool("t").run({ code } as never, undefined);
    const before = codes.tool("t");
    await run(`store("k", 1); return "ok"`);
    expect((await run(`return load("k")`)).text).toContain("1");
    codes.forget("t");
    expect((await run(`return load("k") ?? "none"`)).text).toContain("none");
    expect(codes.tool("t")).not.toBe(before);
  });
});

describe("run_code console bound", () => {
  const codeTool = () => {
    const tools = [tool("read")];
    return createCodeTool({ tools: () => tools, outputDir: tmp(), broker: createCodeBroker({ tools: () => tools, emit: () => {}, outputDir: tmp() }) });
  };
  it("a print flood is bounded and says lines were dropped", async () => {
    const r = await codeTool().run({ code: `for (let i = 0; i < 200000; i++) console.log("x".repeat(20)); return 1` }, call());
    expect(r.isError).toBeFalsy();
    expect(r.text.length).toBeLessThan(300_000);
    expect(r.text).toContain("omitted");
  });
  it("on an error the output is bounded and the error still ends it", async () => {
    const r = await codeTool().run({ code: `for (let i = 0; i < 200000; i++) console.log("x".repeat(20)); throw new Error("boom")` }, call());
    expect(r.isError).toBe(true);
    expect(r.text.length).toBeLessThan(300_000);
    expect(r.text).toContain("boom");
    expect(r.text.trimEnd().endsWith("Calls made before the error are not undone.")).toBe(true);
  });
});

describe("read of a big file", () => {
  const lineOf = (i: number) => `line ${i} ${"y".repeat(36)}`;
  it("streams a window with the same format as a small file", async () => {
    const dir = tmp();
    const n = 400_000;
    writeFileSync(join(dir, "big.txt"), Array.from({ length: n }, (_, i) => lineOf(i + 1)).join("\n") + "\n");
    writeFileSync(join(dir, "small.txt"), Array.from({ length: 20 }, (_, i) => lineOf(i + 1)).join("\n") + "\n");
    const big = await readTool.run({ path: "big.txt", offset: 10, limit: 3 }, ctxIn(dir));
    const small = await readTool.run({ path: "small.txt", offset: 10, limit: 3 }, ctxIn(dir));
    expect(big.text).toContain(`[Lines 10-12 of ${n}.`);
    expect(big.text.split("\n\n")[0]).toBe(small.text.split("\n\n")[0]);
    expect(big.text).toContain("    10\tline 10 ");
    const script = await readTool.run({ path: "big.txt", offset: 10, limit: 3 }, ctxIn(dir, true));
    expect(script.data).toBe([lineOf(10), lineOf(11), lineOf(12)].join("\n"));
  });
  it("a script read without a window is refused on size", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "mid.txt"), "z".repeat(3 * 1024 * 1024));
    await expect(readTool.run({ path: "mid.txt" }, ctxIn(dir, true))).rejects.toThrow(/over 2 MB/);
  });
});

describe("glob in a script", () => {
  it("refuses past the cap and honours a limit", async () => {
    const dir = tmp();
    for (let i = 0; i < 5002; i++) writeFileSync(join(dir, `f${i}.txt`), "");
    await expect(globTool.run({ pattern: "*" }, ctxIn(dir, true))).rejects.toThrow(/More than 5000/);
    const r = await globTool.run({ pattern: "*", limit: 3 }, ctxIn(dir, true));
    expect(r.data).toHaveLength(3);
  });
});

describe("broker rows", () => {
  const rows = async (name: string, access: LoopTool["access"]) => {
    const events: ThreadEvent[] = [];
    const tools = [tool(name, { access })];
    const code = createCodeTool({ tools: () => tools, outputDir: tmp(), broker: createCodeBroker({ tools: () => tools, emit: (e) => events.push(e), outputDir: tmp() }) });
    await code.run({ code: `for (let i = 0; i < ${MAX_LISTED_CALLS + 5}; i++) await tools.${name}({});` }, call());
    const uses = events.filter((e) => e.kind === "tool-use") as Extract<ThreadEvent, { kind: "tool-use" }>[];
    return { mine: uses.filter((e) => e.name === name).length, notes: uses.filter((e) => e.name === "Note") };
  };
  it("every edit gets its row", async () => {
    const r = await rows("edit", "edit");
    expect(r.mine).toBe(MAX_LISTED_CALLS + 5);
    expect(r.notes).toHaveLength(0);
  });
  it("reads past the cap share one note", async () => {
    const r = await rows("read", "read");
    expect(r.mine).toBe(MAX_LISTED_CALLS);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.summary).toMatch(/^Read calls after/);
  });
});
