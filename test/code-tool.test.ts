import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopTool } from "../src/main/harness/loop";
import { createCodeTool, type CodeToolOptions } from "../src/main/harness/tools/code";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "code-tool-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A LoopTool whose run is never used by the sandbox (the broker stands in for it). */
const fake = (name: string, description = name): LoopTool => ({
  definition: { name, description, parameters: { type: "object", properties: { x: { type: "string" } } } },
  displayName: name.toUpperCase(),
  access: "read",
  summarize: () => name,
  run: async () => ({ text: `${name} ok` }),
});

const ok: CodeToolOptions["broker"] = async () => ({ text: "ok", isError: false });

async function exec(code: string, tools: LoopTool[], broker: CodeToolOptions["broker"], opts: { timeoutMs?: number; signal?: AbortSignal; state?: Map<string, string> } = {}) {
  const tool = createCodeTool({ tools: () => tools, broker, outputDir: tmp(), timeoutMs: opts.timeoutMs, state: opts.state });
  return tool.run({ code }, { id: "c1", signal: opts.signal ?? new AbortController().signal, onOutput: () => {} });
}

describe("run_code", () => {
  it("chains two tool calls in order and passes the result between them", async () => {
    const calls: { name: string; args: Record<string, unknown>; parentId: string }[] = [];
    const broker: CodeToolOptions["broker"] = async (name, args, parentId) => {
      calls.push({ name, args, parentId });
      if (name === "alpha") return { text: "hello", isError: false };
      if (name === "beta") return { text: `${String(args.y)} world`, isError: false };
      return { text: "?", isError: true };
    };
    const r = await exec("const a = await tools.alpha({ x: 1 });\nreturn (await tools.beta({ y: a })).length;", [fake("alpha"), fake("beta")], broker);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("=> 11");
    expect(calls).toEqual([
      { name: "alpha", args: { x: 1 }, parentId: "c1" },
      { name: "beta", args: { y: "hello" }, parentId: "c1" },
    ]);
  });

  it("reports console lines then the value, JSON-stringifying non-strings", async () => {
    const r = await exec("console.log('one', 2); console.log({ a: 1 }); return { b: [1, 2] };", [fake("alpha")], ok);
    expect(r.text).toBe('one 2\n{"a":1}\n=> {"b":[1,2]}');
  });

  it("returns a string value as itself", async () => {
    const r = await exec("return 'plain';", [fake("alpha")], ok);
    expect(r.text).toBe("=> plain");
  });

  it("throws inside the script when a tool call errors", async () => {
    const broker: CodeToolOptions["broker"] = async () => ({ text: "no such file", isError: true });
    const r = await exec("try { await tools.alpha({ x: 1 }); return 'no'; } catch (e) { return 'caught: ' + e.message; }", [fake("alpha")], broker);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("=> caught: no such file");
  });

  it("reports a thrown error with any console output before it", async () => {
    const r = await exec("console.log('before'); throw new Error('boom');", [fake("alpha")], ok);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("before");
    expect(r.text).toContain("boom");
    expect(r.text).toContain("Calls made before the error are not undone.");
  });

  it("stops an infinite loop at the time limit", async () => {
    const r = await exec("while (true) {}", [fake("alpha")], ok, { timeoutMs: 200 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/time limit/i);
  });

  it("stops a script when its signal aborts", async () => {
    const ac = new AbortController();
    const broker: CodeToolOptions["broker"] = async () => {
      ac.abort();
      return { text: "late", isError: false };
    };
    const r = await exec("await tools.alpha({ x: 1 }); return 'done';", [fake("alpha")], broker, { signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Interrupted by the user/i);
  });

  it("exposes no filesystem, network or process globals", async () => {
    const r = await exec("return [typeof require, typeof process, typeof fetch].join(',');", [fake("alpha")], ok);
    expect(r.text).toBe("=> undefined,undefined,undefined");
  });

  it("lists and describes tools, hiding run_code and the agent-ish ones", async () => {
    const tools = [fake("alpha"), fake("gamma"), fake("run_code"), fake("task"), fake("propose_plan"), fake("ask_user")];
    const code = [
      "const hits = searchTools('alpha').map((t) => t.name);",
      "const decl = describeTool('alpha');",
      "const exposed = [typeof tools.run_code, typeof tools.task, typeof tools.propose_plan, typeof tools.ask_user, typeof tools.gamma];",
      "return JSON.stringify({ hits, declared: decl.includes('declare function alpha') && decl.includes('x?: string'), exposed });",
    ].join("\n");
    const r = await exec(code, tools, ok);
    const parsed = JSON.parse(r.text.replace(/^=> /, "")) as { hits: string[]; declared: boolean; exposed: string[] };
    expect(parsed.hits).toEqual(["alpha"]);
    expect(parsed.declared).toBe(true);
    expect(parsed.exposed).toEqual(["undefined", "undefined", "undefined", "undefined", "function"]);
  });

  it("stores and loads JSON within one script", async () => {
    const r = await exec("store('k', { n: 1 }); return [load('k').n, load('missing')];", [fake("alpha")], ok);
    expect(r.text).toBe("=> [1,null]");
  });

  it("keeps state across scripts through the shared map", async () => {
    const state = new Map<string, string>();
    const first = await exec("store('seen', [1, 2]); return 'saved';", [fake("alpha")], ok, { state });
    expect(first.isError).toBeFalsy();
    expect(state.get("seen")).toBe("[1,2]");
    const second = await exec("return load('seen').length;", [fake("alpha")], ok, { state });
    expect(second.text).toBe("=> 2");
  });

  it("drops a failed script's writes", async () => {
    const state = new Map<string, string>([["kept", '"before"']]);
    const r = await exec("store('kept', 'after'); store('fresh', true); throw new Error('boom');", [fake("alpha")], ok, { state });
    expect(r.isError).toBe(true);
    expect(state.get("kept")).toBe('"before"');
    expect(state.has("fresh")).toBe(false);
  });

  it("throws inside the script for an over-size value", async () => {
    const r = await exec("try { store('big', 'x'.repeat(300 * 1024)); return 'stored'; } catch (e) { return e.message; }", [fake("alpha")], ok);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("may not exceed");
  });

  it("throws inside the script when the staged total is too large", async () => {
    const r = await exec("try { for (let i = 0; i < 5; i++) store('k' + i, 'x'.repeat(250 * 1024)); return 'stored'; } catch (e) { return e.message; }", [fake("alpha")], ok);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("session state may not exceed");
  });

  it("lists every exposed tool in ALL_TOOLS", async () => {
    const tools = [fake("alpha"), fake("gamma"), fake("run_code"), fake("task"), fake("propose_plan"), fake("ask_user")];
    const r = await exec("return ALL_TOOLS.map((t) => t.name);", tools, ok);
    expect(r.text).toBe('=> ["alpha","gamma"]');
  });

  it("ranks a tool whose description matches the query", async () => {
    const tools = [fake("alpha", "Reads a file from disk."), fake("beta", "Runs a shell command."), fake("gamma", "Fetches a URL.")];
    const r = await exec("return searchTools('shell command').map((t) => t.name);", tools, ok);
    expect(r.text).toBe('=> ["beta"]');
  });

  it("supports console.warn/error/info/debug, pure path helpers, line-numbered errors, and empty-return hints", async () => {
    const logged = await exec(
      [
        "console.info('i'); console.warn('w'); console.error('e'); console.debug('d');",
        "return [path.join('src', './a', '..', 'b.ts'), path.dirname('src/b.ts'), path.basename('src/b.ts', '.ts'), path.extname('src/b.ts'), path.normalize('/a//b/../c/')];",
      ].join("\n"),
      [fake("alpha")],
      ok,
    );
    expect(logged.isError).toBeFalsy();
    expect(logged.text).toBe('i\nw\ne\nd\n=> ["src/b.ts","src","b",".ts","/a/c"]');

    const err = await exec("const x = 1;\nconst y = 2;\nthrow new Error('bad');", [fake("alpha")], ok);
    expect(err.isError).toBe(true);
    expect(err.text).toContain("Line 3: bad");

    const silent = await exec("const x = 42;", [fake("alpha")], ok);
    expect(silent.isError).toBeFalsy();
    expect(silent.text).toContain("=> undefined");
    expect(silent.text).toContain("returned undefined and printed nothing");
  });

  it("merges a trailing options object when a single-arg tool is called as tools.grep(pattern, opts)", async () => {
    const grepTool: LoopTool = {
      definition: { name: "grep", description: "grep", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
      displayName: "Grep",
      access: "read",
      summarize: () => "grep",
      run: async () => ({ text: "ok" }),
    };
    let seen: Record<string, unknown> = {};
    const broker: CodeToolOptions["broker"] = async (_name, args) => {
      seen = args;
      return { text: "ok", isError: false, data: [{ path: "a.ts", line: 1, text: "hit" }] };
    };
    const r = await exec('return await tools.grep("foo", { path: "test", output_mode: "content", context: 2 });', [grepTool], broker);
    expect(r.isError).toBeFalsy();
    expect(seen).toEqual({ pattern: "foo", path: "test", output_mode: "content", context: 2 });
  });
});
