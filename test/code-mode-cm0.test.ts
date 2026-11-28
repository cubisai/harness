// CM0 regressions: a script run owns its tool calls (Stop and the time limit
// reach the broker), serial tools never overlap, un-awaited calls finish or are
// stopped before success, and concurrent scripts don't lose each other's state.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopTool } from "../src/main/harness/loop";
import { createCodeTool, type CodeToolOptions } from "../src/main/harness/tools/code";
import { createCodeBroker, runsAlone } from "../src/main/harness/tools/code-broker";
import { deferred } from "./helpers";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "code-cm0-"));
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

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

function codeTool(tools: LoopTool[], broker: CodeToolOptions["broker"], opts: { timeoutMs?: number; state?: Map<string, string> } = {}) {
  return createCodeTool({ tools: () => tools, broker, outputDir: tmp(), timeoutMs: opts.timeoutMs, state: opts.state });
}
const run = (t: LoopTool, code: string, signal = new AbortController().signal, id = "c1") => t.run({ code }, { id, signal, onOutput: () => {} });

describe("run_code cancellation (CM0)", () => {
  it("a timeout aborts the signal the host call received", async () => {
    let seen: AbortSignal | null = null;
    const broker: CodeToolOptions["broker"] = async (_n, _a, _p, signal) => {
      seen = signal;
      await sleep(5_000, signal).catch(() => {});
      return { text: "late", isError: false };
    };
    const r = await run(codeTool([tool("slow")], broker, { timeoutMs: 300 }), "return await tools.slow({});");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("time limit");
    expect(seen!.aborted).toBe(true);
  });

  it("Stop aborts the host call's signal too", async () => {
    let seen: AbortSignal | null = null;
    const broker: CodeToolOptions["broker"] = async (_n, _a, _p, signal) => {
      seen = signal;
      await sleep(5_000, signal).catch(() => {});
      return { text: "late", isError: false };
    };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const r = await run(codeTool([tool("slow")], broker), "return await tools.slow({});", stop.signal);
    expect(r.text).toContain("Interrupted by the user.");
    expect(seen!.aborted).toBe(true);
  });

  it("waits for a call the script didn't await before reporting success", async () => {
    let finished = false;
    const broker: CodeToolOptions["broker"] = async () => {
      await sleep(150);
      finished = true;
      return { text: "done", isError: false };
    };
    const r = await run(codeTool([tool("work")], broker), "tools.work({}); return 'returned';");
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("=> returned");
    expect(finished).toBe(true);
  });

  it("stops an un-awaited call that outlives the time limit and reports it", async () => {
    let seen: AbortSignal | null = null;
    const broker: CodeToolOptions["broker"] = async (_n, _a, _p, signal) => {
      seen = signal;
      await sleep(5_000, signal).catch(() => {});
      return { text: "late", isError: false };
    };
    const state = new Map<string, string>();
    const r = await run(codeTool([tool("slow")], broker, { timeoutMs: 300, state }), "store('k', 1); tools.slow({}); return 'returned';");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("never awaited");
    expect(seen!.aborted).toBe(true);
    // A run that didn't finish cleanly commits nothing.
    expect(state.has("k")).toBe(false);
  });
});

describe("run_code state commits (CM0)", () => {
  it("rejects the entire later commit if concurrent scripts together exceed the quota", async () => {
    const state = new Map([["owner", '"before"']]);
    // Each script fits by itself. Wait until both have staged writes from the same snapshot.
    const laterStaged = deferred<void>();
    const allowLaterCommit = deferred<void>();
    const sandbox = codeTool([tool("gate")], async (_name, _args, scriptId) => {
      if (scriptId === "a") await laterStaged.promise;
      else {
        laterStaged.resolve();
        await allowLaterCommit.promise;
      }
      return { text: "ok", isError: false };
    }, { state });
    const script = (prefix: string) => `store('owner', '${prefix}'); for (let i=0; i<3; i++) store('${prefix}'+i, 'x'.repeat(200000)); await tools.gate(); return '${prefix}';`;
    const first = run(sandbox, script("a"), undefined, "a");
    const second = run(sandbox, script("b"), undefined, "b");
    const accepted = await first;
    allowLaterCommit.resolve();
    const rejected = await second;
    expect(accepted.text).toBe("=> a");
    expect(rejected).toMatchObject({ isError: true, text: expect.stringContaining("Session state may not exceed") });
    expect(state.get("owner")).toBe('"a"');
    expect([...state.keys()].sort()).toEqual(["a0", "a1", "a2", "owner"]);
  });

  it("two concurrent scripts keep both of their writes", async () => {
    const state = new Map<string, string>();
    const broker: CodeToolOptions["broker"] = async (name) => {
      await sleep(name === "slowA" ? 120 : 30);
      return { text: "ok", isError: false };
    };
    const t = codeTool([tool("slowA"), tool("slowB")], broker, { state });
    const [a, b] = await Promise.all([run(t, "await tools.slowA({}); store('a', 1); return 'a';", undefined, "c1"), run(t, "await tools.slowB({}); store('b', 2); return 'b';", undefined, "c2")]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(Object.fromEntries(state)).toEqual({ a: "1", b: "2" });
  });

  it("a script still overwrites a key it writes, and reads what was committed", async () => {
    const state = new Map<string, string>([["k", "1"]]);
    const t = codeTool([tool("x")], async () => ({ text: "ok", isError: false }), { state });
    const r = await run(t, "const v = load('k'); store('k', v + 1); return v;");
    expect(r.text).toBe("=> 1");
    expect(state.get("k")).toBe("2");
  });
});

describe("code broker scheduling (CM0)", () => {
  const events = () => [] as unknown[];

  it("never overlaps calls to tools that run alone, and keeps their order", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const edit = tool("edit", {
      access: "edit",
      run: async (args) => {
        active++;
        peak = Math.max(peak, active);
        await sleep(40);
        order.push(String(args.n));
        active--;
        return { text: "edited" };
      },
    });
    const broker = createCodeBroker({ tools: () => [edit], emit: () => {}, outputDir: tmp() });
    const signal = new AbortController().signal;
    await Promise.all([1, 2, 3].map((n) => broker("edit", { n }, "p", signal)));
    expect(peak).toBe(1);
    expect(order).toEqual(["1", "2", "3"]);
    void events;
  });

  it("still runs reads (and web fetches) together", async () => {
    let active = 0;
    let peak = 0;
    const mk = (name: string, access: LoopTool["access"]) =>
      tool(name, {
        access,
        run: async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(40);
          active--;
          return { text: "ok" };
        },
      });
    const broker = createCodeBroker({ tools: () => [mk("read", "read"), mk("fetch", "web")], emit: () => {}, outputDir: tmp() });
    const signal = new AbortController().signal;
    await Promise.all([broker("read", {}, "p", signal), broker("read", {}, "p", signal), broker("fetch", {}, "p", signal)]);
    expect(peak).toBe(3);
  });

  it("a stopped run's queued calls never start", async () => {
    let started = 0;
    const slow = tool("slow", {
      run: async (_a, ctx) => {
        started++;
        await sleep(2_000, ctx.signal).catch(() => {});
        return { text: "ok" };
      },
    });
    const broker = createCodeBroker({ tools: () => [slow], emit: () => {}, outputDir: tmp(), maxInFlight: 1 });
    const stop = new AbortController();
    const calls = [broker("slow", {}, "p", stop.signal), broker("slow", {}, "p", stop.signal), broker("slow", {}, "p", stop.signal)];
    await sleep(30);
    stop.abort();
    const results = await Promise.all(calls);
    expect(started).toBe(1);
    expect(results.slice(1).every((r) => r.isError && r.text.startsWith("Not run"))).toBe(true);
  });

  it("classifies which tools run alone", () => {
    expect(runsAlone(tool("r", { access: "read" }))).toBe(false);
    expect(runsAlone(tool("w", { access: "web" }))).toBe(false);
    expect(runsAlone(tool("e", { access: "edit" }))).toBe(true);
    expect(runsAlone(tool("s", { access: "shell" }))).toBe(true);
    expect(runsAlone(tool("m", { access: "read", parallel: false }))).toBe(true);
  });
});
