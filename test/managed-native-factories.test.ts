import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ManagedToolRules } from "../src/main/apps/tool-rules";
import { managedLoopTool } from "../src/main/harness/driver";
import type { LoopTool } from "../src/main/harness/loop";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentDriver, HarnessTool, TurnInput } from "../src/main/agents/types";
import { catalog, closeAfter, tempDir } from "./helpers";

describe("driver-local managed factory boundaries", () => {
  it.each(["auto", "manual"] as const)("an explicit %s plan choice admits subsequent managed calls without accepting unrelated mode changes", async (choice) => {
    const store = new Store(join(tempDir(), "plan-factory.db")); closeAfter(() => store.close());
    const run = vi.fn(async () => ({ text: "read after approved plan" }));
    const raw: HarnessTool = { name: "summary", description: "Read", input: {}, effect: "read", autoAllow: true, run };
    let result: unknown, native: unknown;
    const driver: AgentDriver = { id: "fixture", label: "Fixture", defaultModel: "fake", capabilities: SAFE_DEFAULTS, skillCallPrefix: "$", skillsDelivery: { mode: "none" }, models: () => [{ id: "fake", label: "Fixture" }], runTurn: async (input) => {
      const descriptor = input.managedTools!([raw])[0]!;
      expect(await input.requestPlanDecision({ plan: "Read after the explicit user choice" })).toBe(choice);
      result = await descriptor.run({}, { threadId: input.threadId, signal: input.signal });
      native = await input.managedRun!(raw, {}, input.signal);
    } };
    const service = new Service(store, () => catalog(), [driver], (update) => { if (update.type === "plan-approval") service.respondPlan(update.request.requestId, choice); }); closeAfter(() => service.dispose());
    const project = store.addProject(tempDir()), thread = service.createThread(project.id);
    store.updateThread(thread.id, { permissionMode: "plan" });
    const manager = new ManagedToolRules({ policy: { rules: () => null, rulesRevision: () => "one" }, thread: () => ({ projectId: thread.projectId, permissionMode: store.getThread(thread.id).permissionMode, kind: "chat", agent: "fixture", signal: service.turnSignal(thread.id) }), approve: async () => false }); closeAfter(() => manager.dispose());
    service.setManagedTools((_thread, tools) => manager.tools(tools));
    service.setManagedRun((thread, tool, args, signal) => manager.execute(tool, args, { threadId: thread.id, projectId: thread.projectId, signal }));
    await service.send({ threadId: thread.id, text: "Local plan protocol test" });
    expect(result).toMatchObject({ text: "read after approved plan" }); expect(native).toMatchObject({ text: "read after approved plan" }); expect(run).toHaveBeenCalledTimes(2);
  });
  it("gates a native web call once, preserves its schema/output, and freezes its actual arguments", async () => {
    const turn = new AbortController(); let decision: "ask" | "allow" | null = "ask", finish!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; }), wait = new Promise<void>((r) => { finish = r; });
    const approve = vi.fn(async () => { entered(); await wait; return true; });
    const manager = new ManagedToolRules({ policy: { rules: (_t, read) => decision === "allow" && !read ? null : decision, rulesRevision: () => "one" }, thread: () => ({ projectId: "project", permissionMode: "ask", kind: "chat", agent: "fixture", signal: turn.signal }), approve });
    closeAfter(() => manager.dispose());
    const result = { text: "body", display: { summary: "original display", result: { ok: true } }, data: { value: 42 } };
    const native = { definition: { name: "web_fetch", description: "Native web", parameters: { type: "object", properties: { url: { type: "string" } } } }, displayName: "Fetch", access: "web" as const, summarize: (args: Record<string, unknown>) => String(args.url), run: vi.fn<LoopTool["run"]>(async () => result) };
    const input = { threadId: "thread", projectId: "project", signal: turn.signal, managedTools: (tools: HarnessTool[]) => manager.tools(tools), managedRun: (tool: HarnessTool, args: Record<string, unknown>, signal: AbortSignal) => manager.execute(tool, args, { threadId: "thread", projectId: "project", signal }) };
    const tool = managedLoopTool(native, input), args = { url: "https://first.example.test/" };
    expect(tool.definition).toBe(native.definition); expect(tool.access).toBe(native.access);
    expect(tool.deferPermission!(args)).toBe(true);
    const running = tool.run(args, { id: "call", signal: turn.signal, onOutput: () => {} });
    await ready; args.url = "https://substituted.example.test/"; finish();
    expect(await running).toBe(result); expect(native.run.mock.calls[0]?.[0]).toEqual({ url: "https://first.example.test/" }); expect(approve).toHaveBeenCalledOnce();
    decision = "allow";
    expect(tool.deferPermission!(args)).toBe(false); // Web access isn't a verified read.
  });

  it("an old driver's descriptor and native callback cannot attach themselves to a newer turn", async () => {
    const store = new Store(join(tempDir(), "factory.db")); closeAfter(() => store.close());
    let input!: TurnInput, release!: () => void;
    const driver: AgentDriver = { id: "fixture", label: "Fixture", defaultModel: "fake", capabilities: SAFE_DEFAULTS, skillCallPrefix: "$", skillsDelivery: { mode: "none" }, models: () => [{ id: "fake", label: "Fixture" }], runTurn: async (i) => { input = i; await new Promise<void>((r) => { release = r; }); } };
    const service = new Service(store, () => catalog(), [driver], () => {}); closeAfter(() => service.dispose());
    const project = store.addProject(tempDir()), thread = service.createThread(project.id), approve = vi.fn(async () => true);
    const manager = new ManagedToolRules({ policy: { rules: () => "ask", rulesRevision: () => "one" }, thread: () => ({ projectId: thread.projectId, permissionMode: thread.permissionMode, kind: "chat", agent: "fixture", signal: service.turnSignal(thread.id) }), approve }); closeAfter(() => manager.dispose());
    service.setManagedTools((_thread, tools) => manager.tools(tools));
    service.setManagedRun((thread, tool, args, signal) => manager.execute(tool, args, { threadId: thread.id, projectId: thread.projectId, signal }));
    const run = vi.fn(async () => ({ text: "local result" })), raw: HarnessTool = { name: "todowrite", description: "Fixture", input: { value: z.string() }, effect: "read", autoAllow: true, run };
    const first = service.send({ threadId: thread.id, text: "First local fake turn" }); await vi.waitFor(() => expect(input).toBeDefined());
    const old = input, descriptor = old.managedTools!([raw])[0]!;
    release(); await first;
    const next = service.send({ threadId: thread.id, text: "Second local fake turn" }); await vi.waitFor(() => expect(input).not.toBe(old));
    expect(await descriptor.run({ value: "stale" }, { threadId: thread.id, signal: old.signal })).toMatchObject({ isError: true, text: expect.stringContaining("stale") });
    expect(await old.managedRun!(raw, { value: "stale" }, old.signal)).toMatchObject({ isError: true });
    expect(descriptor.deferPermission!({ value: "stale" }, { threadId: thread.id, signal: input.signal })).toBe(false);
    expect(run).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
    expect(await input.managedTools!([raw])[0]!.run({ value: "current" }, { threadId: thread.id, signal: input.signal })).toMatchObject({ text: "local result" });
    expect(run).toHaveBeenCalledOnce(); expect(approve).toHaveBeenCalledOnce(); release(); await next;
  });
});
