import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HarnessTool } from "../src/main/agents/types";
import { hasOwnCodeMode, harnessTool } from "../src/main/agents/acp/driver";
import { summarizeToolInput } from "../src/main/agents/summarize";
import { codeModes, createCodeServer, CODE_TOOL, type CodeServerDeps } from "../src/main/code-mode";
import { createCodeBroker, MAX_IN_FLIGHT } from "../src/main/harness/tools/code-broker";
import type { LoopTool } from "../src/main/harness/loop";
import { startToolServer, withCode } from "../src/main/mcp-http";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import type { ThreadEvent } from "../src/shared/types";
import { closeAfter, tempDir } from "./helpers";

const signal = (): AbortSignal => new AbortController().signal;

/** A LoopTool whose run is the broker's job to call. */
const fake = (name: string, run: LoopTool["run"] = async () => ({ text: "out" })): LoopTool => ({
  definition: { name, description: name, parameters: {} },
  displayName: name.toUpperCase(),
  access: "read",
  summarize: () => "sum",
  run,
});

describe("createCodeBroker", () => {
  it("runs a tool and traces it as a child of the script's row", async () => {
    const events: ThreadEvent[] = [];
    const broker = createCodeBroker({ tools: () => [fake("t1")], emit: (e) => events.push(e), outputDir: tempDir(), parentOf: () => "p1" });
    const r = await broker("t1", {}, "p1", signal());
    expect(r).toEqual({ text: "out", isError: false });
    expect(events).toEqual([
      { kind: "tool-use", toolUseId: "p1:1", name: "T1", summary: "sum", parentId: "p1" },
      { kind: "tool-result", toolUseId: "p1:1", isError: false, summary: "out", payload: "out", parentId: "p1" },
    ]);
  });

  it("emits top-level rows when parentOf returns undefined", async () => {
    const events: ThreadEvent[] = [];
    const broker = createCodeBroker({ tools: () => [fake("t1")], emit: (e) => events.push(e), outputDir: tempDir(), parentOf: () => undefined });
    await broker("t1", {}, "p1", signal());
    expect(events).toHaveLength(2);
    for (const e of events) expect(e).not.toHaveProperty("parentId");
    expect(events[0]).toMatchObject({ toolUseId: "p1:1" });
  });

  it("reports an unknown tool without emitting", async () => {
    const events: ThreadEvent[] = [];
    const broker = createCodeBroker({ tools: () => [fake("t1")], emit: (e) => events.push(e), outputDir: tempDir() });
    const r = await broker("nope", {}, "p1", signal());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no tool named");
    expect(events).toEqual([]);
  });

  it("shows a refused call and never runs it", async () => {
    const events: ThreadEvent[] = [];
    let ran = false;
    const t1 = fake("t1", async () => {
      ran = true;
      return { text: "out" };
    });
    const broker = createCodeBroker({
      tools: () => [t1],
      emit: (e) => events.push(e),
      authorize: async () => ({ ok: false, reason: "denied here" }),
      outputDir: tempDir(),
      parentOf: () => "p1",
    });
    const r = await broker("t1", {}, "p1", signal());
    expect(r).toEqual({ text: "denied here", isError: true });
    expect(events).toEqual([
      { kind: "tool-use", toolUseId: "p1:1", name: "T1", summary: "sum", parentId: "p1" },
      { kind: "tool-result", toolUseId: "p1:1", isError: true, summary: "denied here", parentId: "p1" },
    ]);
    expect(ran).toBe(false);
  });

  it("runs at most MAX_IN_FLIGHT of one script's calls at once", async () => {
    let running = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const slow = fake("slow", async () => {
      running += 1;
      peak = Math.max(peak, running);
      try {
        await gate;
      } finally {
        running -= 1;
      }
      return { text: "out" };
    });
    const broker = createCodeBroker({ tools: () => [slow], emit: () => {}, outputDir: tempDir() });
    const calls = Array.from({ length: 12 }, (_, i) => broker("slow", {}, `p${i}`, signal()));
    await new Promise((r) => setTimeout(r, 20));
    expect(running).toBe(MAX_IN_FLIGHT);
    release();
    const results = await Promise.all(calls);
    expect(peak).toBe(MAX_IN_FLIGHT);
    expect(results).toHaveLength(12);
    expect(results.every((r) => !r.isError)).toBe(true);
  });
});

describe("codeModes", () => {
  it("fixes a thread's mode on its first read", () => {
    let value: "off" | "on" | undefined = "on";
    const of = codeModes(() => value);
    expect(of("a")).toBe("on");
    value = "off";
    expect(of("a")).toBe("on");
    expect(of("b")).toBe("off");
    value = undefined;
    expect(of("c")).toBe("off");
  });
});

describe("createCodeServer", () => {
  const peek: HarnessTool = {
    name: "peek",
    description: "Peek",
    input: {},
    autoAllow: true,
    effect: "read",
    run: async () => ({ text: "peeked" }),
  };
  const poke: HarnessTool = { ...peek, name: "poke", autoAllow: false, effect: "mutate" };
  const ask: HarnessTool = { ...peek, name: "ask_user" };

  const setup = (patch: Partial<CodeServerDeps> = {}) => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "hello world");
    const events: [string, ThreadEvent][] = [];
    const deps: CodeServerDeps = {
      cwdOf: () => dir,
      projectOf: () => undefined,
      appTools: () => [peek, poke, ask],
      parentOf: () => "parent-1",
      emit: (id, e) => events.push([id, e]),
      outputDir: tempDir(),
      guardScript: "builtin",
      parentWaitMs: 0,
      ...patch,
    };
    return { events, codes: createCodeServer(deps) };
  };

  const run = async (codes: ReturnType<typeof createCodeServer>, threadId: string, code: string) =>
    codes.tool(threadId).run({ code } as never, undefined);

  it("is a read-only run_code tool, the same one per thread", () => {
    const { codes } = setup();
    const tool = codes.tool("t");
    expect(tool.name).toBe(CODE_TOOL);
    expect(tool.name).toBe("run_code");
    expect(tool.autoAllow).toBe(true);
    expect(tool.effect).toBe("read");
    expect(codes.tool("t")).toBe(tool);
    // The native tools' argument names are spelled out: models guess `filePath` otherwise.
    expect(tool.description).toContain('tools.read({ path: "src/a.ts"');
  });

  it("summarises a run_code call by its script on Claude and Codex rows", () => {
    expect(summarizeToolInput("mcp__cubiq__run_code", { code: "const a = 1;\nreturn a;" })).toBe("const a = 1; return a;");
  });

  it("exposes only read tools to a script", async () => {
    const { codes } = setup();
    const r = await run(codes, "t", 'return ALL_TOOLS.map((t) => t.name).sort().join(",")');
    expect(r.text.endsWith("=> glob,grep,peek,read")).toBe(true);
  });

  it("runs a read through the broker, traced under the script's parent", async () => {
    const { events, codes } = setup();
    const r = await run(codes, "t", 'const t = await tools.read({ path: "a.txt" }); return t.includes("hello world");');
    expect(r.isError).toBeFalsy();
    expect(r.text.endsWith("=> true")).toBe(true);
    const found = events.map(([, e]) => e).find((e) => e.kind === "tool-use");
    expect(found).toMatchObject({ kind: "tool-use", name: "Read", parentId: "parent-1" });
    const useId = found?.kind === "tool-use" ? found.toolUseId : undefined;
    const result = events.map(([, e]) => e).find((e) => e.kind === "tool-result");
    expect(result).toMatchObject({ kind: "tool-result", toolUseId: useId, isError: false });
  });

  it("keeps a mutating tool out of the script", async () => {
    const { codes } = setup();
    const r = await run(codes, "t", "return await tools.poke({})");
    expect(r.isError).toBe(true);
  });

  it("emits top-level rows for a script without a parent", async () => {
    const { events, codes } = setup({ parentOf: () => undefined });
    await run(codes, "t", "return await tools.peek({})");
    const found = events.map(([, e]) => e).find((e) => e.kind === "tool-use");
    if (!found || found.kind !== "tool-use") throw new Error("expected a tool-use event");
    expect(found).not.toHaveProperty("parentId");
    expect(found.toolUseId).toMatch(/^code-[0-9a-f]{8}:1$/);
  });

  it("refuses when the thread's folder is gone", async () => {
    const { codes } = setup({ cwdOf: () => null });
    const r = await run(codes, "t", "return 1");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("folder is gone");
  });

  it("keeps store/load state per thread", async () => {
    const { codes } = setup();
    const first = await run(codes, "t", "store('k', 41); return 1");
    expect(first.text.endsWith("=> 1")).toBe(true);
    const second = await run(codes, "t", "return load('k') + 1");
    expect(second.text.endsWith("=> 42")).toBe(true);
    const other = await run(codes, "u", "return load('k') === undefined");
    expect(other.text.endsWith("=> true")).toBe(true);
  });
});

describe("tool server ?c=", () => {
  const echo: HarnessTool = {
    name: "echo",
    description: "Echo text back",
    input: { text: z.string() },
    autoAllow: true,
    run: async (args) => ({ text: `echo: ${(args as { text: string }).text}` }),
  };

  const named = (name: string): HarnessTool => ({
    name,
    description: name,
    input: {},
    autoAllow: true,
    run: async () => ({ text: name }),
  });

  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return client;
  }

  it("adds the code tools when ?c= names a thread", async () => {
    const server = await startToolServer(
      () => [echo],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (tid) => [named("run_code_" + tid)],
    );
    closeAfter(() => void server.close());
    const base = await connect(server.url, server.token);
    expect((await base.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    await base.close();
    const coded = await connect(withCode(server.url, "t9"), server.token);
    expect((await coded.listTools()).tools.map((t) => t.name)).toEqual(["echo", "run_code_t9"]);
    await coded.close();
  });

  it("withCode adds ?c= without dropping the other query", () => {
    expect(withCode("http://127.0.0.1:1/mcp?p=x", undefined)).toBe("http://127.0.0.1:1/mcp?p=x");
    const u = new URL(withCode("http://127.0.0.1:1/mcp?p=x", "t"));
    expect(u.searchParams.get("p")).toBe("x");
    expect(u.searchParams.get("c")).toBe("t");
  });
});

describe("ACP helpers", () => {
  it("knows which agents bring their own code mode", () => {
    expect(hasOwnCodeMode({ agentInfo: { name: "OpenCode", version: "2.1.0" } })).toBe(true);
    expect(hasOwnCodeMode({ agentInfo: { name: "OpenCode", version: "1.19.0" } })).toBe(false);
    expect(hasOwnCodeMode({ agentInfo: { name: "Gemini", version: "3.0.0" } })).toBe(false);
    expect(hasOwnCodeMode({})).toBe(false);
  });

  it("names and summarises the harness's own tool calls", () => {
    expect(harnessTool({ title: "cubiq_run_code", kind: "other", rawInput: { code: "return 1" } })).toEqual({
      name: "run_code",
      summary: "return 1",
    });
  });
});

describe("SettingsStore codeMode", () => {
  const box: SecretBox = {
    available: true,
    encrypt: (s) => Buffer.from([...s].reverse().join("")).toString("base64"),
    decrypt: (b) => [...Buffer.from(b, "base64").toString()].reverse().join(""),
  };

  const fresh = () => join(tempDir(), "settings.json");

  it("accepts off/on and ignores an unknown value, including the removed only", () => {
    const s = new SettingsStore(fresh(), box);
    s.update({ codeMode: "on" });
    expect(s.get().codeMode).toBe("on");
    s.update({ codeMode: "off" });
    expect(s.get().codeMode).toBe("off");
    s.update({ codeMode: "only" as never });
    expect(s.get().codeMode).toBe("off");
    s.update({ codeMode: "bogus" as never });
    expect(s.get().codeMode).toBe("off");
  });

  it("reads a stored only as on", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ settings: { codeMode: "only" } }));
    expect(new SettingsStore(file, box).get().codeMode).toBe("on");
  });
});
