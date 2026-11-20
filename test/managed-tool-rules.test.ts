import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ManagedToolRules, type RuleThread } from "../src/main/apps/tool-rules";
import { decidePluginRule } from "../src/main/apps/parts";
import type { HarnessTool } from "../src/main/agents/types";
import type { PluginRule } from "../src/shared/plugin-parts";
import { appLoopTool } from "../src/main/harness/driver";
import { createCodeServer } from "../src/main/code-mode";
import { BUILT_IN_GUARD } from "../src/main/guard";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture(effect: HarnessTool["effect"] | "unknown" = "read", autoAllow = true) {
  let revision = "one", rules: PluginRule[] = [];
  const turn = new AbortController();
  let thread: RuleThread | null = { projectId: "project", permissionMode: "full", kind: "chat", agent: "claude", signal: turn.signal };
  const run = vi.fn<HarnessTool["run"]>(async (args) => ({ text: JSON.stringify(args), data: { total: 42 } }));
  const raw: HarnessTool = { name: "summary", description: "Fixture summary", input: { day: z.number().optional() }, autoAllow, ...(effect && effect !== "unknown" ? { effect } : {}), run };
  const approve = vi.fn(async (_threadId: string, _name: string, _summary: string, _signal: AbortSignal) => true);
  const manager = new ManagedToolRules({ policy: { rules: (target, readOnly) => decidePluginRule(rules, target, readOnly), rulesRevision: () => revision }, thread: () => thread, approve });
  cleanups.push(() => manager.dispose());
  const tool = manager.tool(raw, "thread");
  return { manager, tool, raw, run, approve, turn,
    rule: (action: "ask" | "allow") => { rules = [{ action, target: { kind: "tool", name: raw.name } }]; },
    revise: () => { revision = "two"; manager.invalidate(); },
    thread: (patch: Partial<RuleThread>) => { thread = { ...thread!, ...patch }; },
    remove: () => { thread = null; manager.forgetThread("thread"); },
  };
}
function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

describe("mandatory rules inside managed tool execution", () => {
  it("enforces current Ask on an already-created autoAllow descriptor, before an internal cached read", async () => {
    const e = fixture(); expect(e.tool.autoAllow).toBe(true);
    await e.tool.run({ day: 1 }); expect(e.run).toHaveBeenCalledOnce();
    e.rule("ask"); e.approve.mockResolvedValueOnce(false);
    expect(await e.tool.run({ day: 1 })).toMatchObject({ isError: true, text: expect.stringContaining("denied") });
    expect(e.run).toHaveBeenCalledOnce();
    await e.tool.run({ day: 1 }); await e.tool.run({ day: 1 });
    expect(e.approve).toHaveBeenCalledTimes(3); expect(e.run).toHaveBeenCalledTimes(3);
  });
  it("keeps descriptors/schemas/permission flags stable and doesn't re-wrap an existing plugin gate", () => {
    const e = fixture("mutate", false);
    expect(e.manager.tool(e.raw, "thread")).toBe(e.tool);
    expect(e.manager.tool(e.tool, "thread")).toBe(e.tool);
    expect(e.tool).toMatchObject({ name: e.raw.name, autoAllow: false, effect: "mutate" });
    expect(e.tool.input).toBe(e.raw.input);
    const plugin: HarnessTool = { ...e.raw, pluginRulesHandled: true };
    expect(e.manager.tool(plugin, "thread")).toBe(plugin);
    e.manager.forgetThread("thread"); expect(e.manager.tool(e.raw, "thread")).not.toBe(e.tool);
  });
  it.each(["mutate", "unknown"] as const)("Allow cannot escalate a %s tool or replace a tool-local denial", async (effect) => {
    const e = fixture(effect, false); e.rule("allow");
    e.run.mockResolvedValueOnce({ text: "Blocked by a tool-local guard", isError: true });
    expect(await e.tool.run({})).toEqual({ text: "Blocked by a tool-local guard", isError: true });
    expect(e.tool.autoAllow).toBe(false); expect(e.approve).not.toHaveBeenCalled();
  });
  it("an approved Ask cannot erase a subsequent guard denial", async () => {
    const e = fixture("mutate", false); e.rule("ask");
    e.run.mockResolvedValueOnce({ text: "Guard refused", isError: true });
    expect(await e.tool.run({})).toEqual({ text: "Guard refused", isError: true }); expect(e.approve).toHaveBeenCalledOnce();
  });
  it("freezes exact input before approval rather than letting caller mutations substitute new arguments", async () => {
    const e = fixture(), entered = latch(), finish = latch(); e.rule("ask");
    e.approve.mockImplementationOnce(async () => { entered.release(); await finish.promise; return true; });
    const args = { day: 1 }, call = e.tool.run(args); await entered.promise; args.day = 2; finish.release();
    expect(await call).toHaveProperty("text", '{"day":1}');
    expect(e.run.mock.calls[0]?.[0]).toEqual({ day: 1 });
  });
  it("rejects invalid input, foreign thread/project and absent live turns before asking or running", async () => {
    const e = fixture(); e.rule("ask");
    expect(await e.tool.run({ day: "bad" })).toMatchObject({ isError: true });
    expect(await e.tool.run({}, { threadId: "other" })).toMatchObject({ isError: true });
    expect(await e.tool.run({}, { projectId: "other" })).toMatchObject({ isError: true });
    e.remove(); expect(await e.tool.run({})).toMatchObject({ isError: true });
    expect(e.approve).not.toHaveBeenCalled(); expect(e.run).not.toHaveBeenCalled();
  });
  it("Plan refuses forced mutations/unknown effects, but a forced read still needs single-use approval", async () => {
    const e = fixture("mutate"); e.rule("ask"); e.thread({ permissionMode: "plan" });
    expect(await e.tool.run({})).toMatchObject({ isError: true, text: expect.stringContaining("Plan") });
    expect(e.approve).not.toHaveBeenCalled(); expect(e.run).not.toHaveBeenCalled();
    const read = fixture(); read.rule("ask"); read.thread({ permissionMode: "plan" }); read.approve.mockResolvedValueOnce(false);
    expect(await read.tool.run({})).toMatchObject({ isError: true }); expect(read.approve).toHaveBeenCalledOnce();
  });
  it.each(["rules", "turn", "permissions", "project", "delete"])("a %s change while awaiting approval cannot execute old input", async (kind) => {
    const e = fixture(), entered = latch(), finish = latch(); e.rule("ask");
    e.approve.mockImplementationOnce(async () => { entered.release(); await finish.promise; return true; });
    const call = e.tool.run({ day: 1 }); await entered.promise;
    if (kind === "rules") e.revise();
    if (kind === "turn") e.thread({ signal: new AbortController().signal });
    if (kind === "permissions") e.thread({ permissionMode: "plan" });
    if (kind === "project") e.thread({ projectId: "new-project" });
    if (kind === "delete") e.remove();
    finish.release(); expect(await call).toMatchObject({ isError: true }); expect(e.run).not.toHaveBeenCalled();
  });
  it("withdraws promptly even if an approval provider ignores cancellation", async () => {
    const e = fixture(), entered = latch(), finish = latch(); e.rule("ask");
    e.approve.mockImplementationOnce(async () => { entered.release(); await finish.promise; return true; });
    const call = e.tool.run({}); await entered.promise; e.revise();
    expect(await call).toMatchObject({ isError: true }); expect(e.run).not.toHaveBeenCalled(); finish.release();
  });
  it("propagates cancellation into a running body and discards its late result", async () => {
    const e = fixture(), entered = latch();
    e.run.mockImplementationOnce(async (_args, ctx) => {
      entered.release(); await new Promise<void>((resolve) => ctx!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "late" };
    });
    const call = e.tool.run({}); await entered.promise; e.revise(); expect(await call).toMatchObject({ isError: true });
  });
  it("retains legacy unscoped behaviour but never lets it satisfy a forced Ask", async () => {
    const e = fixture(), unscoped = e.manager.tool(e.raw);
    expect(await unscoped.run({})).toHaveProperty("text", "{}");
    e.rule("ask"); expect(await unscoped.run({})).toMatchObject({ isError: true }); expect(e.run).toHaveBeenCalledOnce();
  });
  it("the native harness appLoopTool cannot trust autoAllow instead of the mandatory gate", async () => {
    const e = fixture(); e.rule("ask"); e.approve.mockResolvedValueOnce(false);
    const loop = appLoopTool(e.tool, { threadId: "thread", projectId: "project" }, "unused-output");
    expect(loop.access).toBe("read");
    expect(await loop.run({}, { id: "call", signal: e.turn.signal, onOutput: () => {} })).toMatchObject({ isError: true });
    expect(e.approve).toHaveBeenCalledOnce(); expect(e.run).not.toHaveBeenCalled();
  });
  it("a real run_code sandbox cannot bypass forced Ask on an exposed read-only managed tool", async () => {
    const e = fixture(); e.rule("ask"); e.approve.mockResolvedValueOnce(false);
    const dir = mkdtempSync(join(tmpdir(), "managed-rules-code-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = createCodeServer({ cwdOf: () => dir, projectOf: () => "project", appTools: () => [e.tool], parentOf: () => "parent", emit: () => {}, turnSignal: () => e.turn.signal, outputDir: dir, guardScript: BUILT_IN_GUARD, parentWaitMs: 0 });
    const output = await server.tool("thread").run({ code: 'return await tools.summary({ day: 1 });' }, { threadId: "thread", signal: e.turn.signal });
    expect(output.text).toContain("denied"); expect(e.approve).toHaveBeenCalledOnce(); expect(e.run).not.toHaveBeenCalled();
  });
});
