import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ManagedToolRules, managedCallPermission, connectorCallPermission, type RuleThread } from "../src/main/apps/tool-rules";
import { deferManagedPermission, isMainMediatedServer, managedTarget, wireManagedTarget } from "../src/main/agents/managed-permission";
import { createCodexDriver } from "../src/main/agents/codex";
import { createAcpDriver, decidePluginAsk } from "../src/main/agents/acp/driver";
import { managedCodeLoop } from "../src/main/harness/driver";
import { startToolServer, withThread } from "../src/main/mcp-http";
import type { AgentDriver, HarnessTool, TurnInput } from "../src/main/agents/types";
import type { McpServerEntry, PermissionMode, ThreadEvent } from "../src/shared/types";
import { tempDir } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.unstubAllEnvs(); });
function fixture(effect: HarnessTool["effect"] | "unknown" = "read", autoAllow = false) {
  const turn = new AbortController(); let decision: "ask" | "allow" | null = "ask", policy = "one";
  let thread: RuleThread = { projectId: "project", permissionMode: "ask", kind: "chat", agent: "fixture", signal: turn.signal };
  const run = vi.fn<HarnessTool["run"]>(async (args) => ({ text: JSON.stringify(args) }));
  const approve = vi.fn(async () => false);
  const raw: HarnessTool = { name: "summary", description: "Local fixture", input: { day: z.number().optional() }, autoAllow, ...(effect === "unknown" ? {} : { effect }), run };
  const manager = new ManagedToolRules({ policy: { rules: (_t, read) => decision === "allow" && !read ? null : decision, rulesRevision: () => policy }, thread: () => thread, approve });
  cleanup.push(() => manager.dispose());
  const tool = manager.tool(raw, "thread");
  const events: ThreadEvent[] = [], outer = vi.fn<TurnInput["requestPermission"]>(async () => "deny");
  const input: TurnInput = { threadId: "thread", projectId: "project", cwd: tempDir(), prompt: "fixture", sessionId: null, model: "fake", permissionMode: "ask", signal: turn.signal, tools: [tool], mcpServers: [], onEvent: (e) => events.push(e), onTextDelta: () => {}, onSession: () => {}, requestPermission: outer, requestPlanDecision: async () => ({ keep: "" }) };
  return { manager, tool, run, approve, input, events, outer, turn,
    rule: (d: typeof decision) => { decision = d; },
    revise: () => { policy = "two"; manager.invalidate(); },
    context: (patch: Partial<RuleThread>) => { thread = { ...thread, ...patch }; },
  };
}

describe("exact native-to-host permission routing", () => {
  it("routes Ask to execution without granting or changing the tool descriptor", async () => {
    const e = fixture(), target = { kind: "tool" as const, name: "summary" };
    expect(deferManagedPermission(e.input, target, { day: 1 })).toBe(true);
    expect(e.tool.autoAllow).toBe(false); expect(e.run).not.toHaveBeenCalled(); expect(e.approve).not.toHaveBeenCalled();
    expect(await e.tool.run({ day: 1 }, { threadId: "thread", signal: e.turn.signal })).toMatchObject({ isError: true });
    expect(e.approve).toHaveBeenCalledOnce(); expect(e.run).not.toHaveBeenCalled();
  });
  it("ordinary native plugin invocation approvals defer to the plugin's existing host gate", () => {
    const e = fixture();
    const plugin: HarnessTool = { name: "plugin_notes__save", description: "Main-created plugin tool", input: {}, autoAllow: false, pluginRulesHandled: true, effect: "mutate", run: async () => ({ text: "Not invoked" }) };
    e.input.tools = [plugin];
    expect(deferManagedPermission(e.input, { kind: "tool", name: plugin.name }, {})).toBe(true);
    expect(plugin.autoAllow).toBe(false);
    expect(deferManagedPermission(e.input, { kind: "tool", name: plugin.name }, {}, "ask")).toBe(false);
    expect(deferManagedPermission({ ...e.input, tools: [{ ...plugin, pluginRulesHandled: undefined }] }, { kind: "tool", name: plugin.name }, {})).toBe(false);
  });
  it("a read-Allow shortcut still validates input and respects a tool-local denial", async () => {
    const e = fixture(); e.rule("allow"); e.run.mockResolvedValueOnce({ text: "Local guard denied", isError: true });
    expect(deferManagedPermission(e.input, { kind: "tool", name: "summary" }, { day: 1 })).toBe(true);
    expect(await e.tool.run({ day: 1 }, { threadId: "thread" })).toEqual({ text: "Local guard denied", isError: true });
    expect(e.approve).not.toHaveBeenCalled(); expect(e.tool.autoAllow).toBe(false);
    expect(deferManagedPermission(e.input, { kind: "tool", name: "summary" }, { day: "bad" })).toBe(false);
  });
  it.each(["mutate", "unknown"] as const)("Allow never routes an unknown/write tool (%s)", (effect) => {
    const e = fixture(effect);
    e.rule("allow"); expect(deferManagedPermission(e.input, { kind: "tool", name: "summary" }, {})).toBe(false);
  });
  it.each(["policy", "mode", "project", "agent", "input"])("a deferred %s change fails closed before effects or another approval", async (change) => {
    const e = fixture(); expect(e.tool.deferPermission!({ day: 1 }, { threadId: "thread", projectId: "project", signal: e.turn.signal })).toBe(true);
    if (change === "policy") { e.rule(null); e.revise(); }
    if (change === "mode") e.context({ permissionMode: "full" });
    if (change === "project") e.context({ projectId: "other" });
    if (change === "agent") e.context({ agent: "other" });
    expect(await e.tool.run({ day: change === "input" ? 2 : 1 }, { threadId: "thread" })).toMatchObject({ isError: true });
    expect(e.run).not.toHaveBeenCalled(); expect(e.approve).not.toHaveBeenCalled();
  });
  it("unknown Codex display arguments are routing only; the real call still asks single-use", async () => {
    const e = fixture(); e.approve.mockResolvedValue(true);
    expect(deferManagedPermission(e.input, { kind: "tool", name: "summary" })).toBe(true);
    await e.tool.run({ day: 1 }); await e.tool.run({ day: 1 }); expect(e.approve).toHaveBeenCalledTimes(2);
  });
  it("does not accept a foreign/old turn, native tools, description substrings or model approval fields", () => {
    const e = fixture();
    expect(e.tool.deferPermission!({}, { threadId: "thread", signal: new AbortController().signal })).toBe(false);
    expect(wireManagedTarget(e.input, "Run mcp__cubiq__summary now")).toBeNull();
    expect(deferManagedPermission(e.input, { kind: "tool", name: "Bash" }, { approved: true })).toBe(false);
    expect(deferManagedPermission(e.input, { kind: "tool", name: "summary" }, { day: 1, approved: true })).toBe(false);
    const other: McpServerEntry = { name: "unskilled", enabled: true, spec: { type: "stdio", command: "never-run" } };
    expect(managedTarget({ mcpServers: [other] }, "unskilled", "summary")).toEqual({ kind: "connector", server: "unskilled", tool: "summary" });
    expect(isMainMediatedServer({ ...other, mainMediated: true })).toBe(false);
  });
  it("Ask wins across outer and inner policies; only a verified read can use Allow", () => {
    expect(managedCallPermission(["allow", "ask"], true, true, "full")).toEqual({ ask: true, forced: true });
    expect(managedCallPermission(["ask", "ask"], true, true, "ask")).toEqual({ ask: true, forced: true });
    expect(managedCallPermission(["allow", null], true, true, "ask")).toEqual({ ask: false, forced: false });
    expect(managedCallPermission(["allow", null], false, true, "ask")).toEqual({ ask: true, forced: false });
  });
  it("ordinary native connector asks cannot disappear in mediation; only exact read-Allow skips them", () => {
    expect(connectorCallPermission(null, true, "ask", { ask: true })).toEqual({ ask: true, forced: false });
    expect(connectorCallPermission("allow", true, "ask", { ask: true })).toEqual({ ask: false, forced: false });
    expect(connectorCallPermission("allow", false, "ask", { ask: true })).toEqual({ ask: true, forced: false });
    expect(connectorCallPermission("ask", true, "full", { ask: true })).toEqual({ ask: true, forced: true });
    expect(connectorCallPermission("allow", true, "full", { ask: true, forced: true })).toEqual({ ask: true, forced: true });
  });
  it("concurrent identical connector calls cannot consume each other's native Ask requirement", () => {
    const e = fixture();
    const ctx = { threadId: "thread", projectId: "project", signal: e.turn.signal, normalApproval: true as const };
    expect(e.manager.deferCall("mcp:shop.summary", undefined, ctx)).toBe(true);
    expect(e.manager.takeDeferral("mcp:shop.summary", { day: 1 }, ctx)).toMatchObject({ ask: true });
    expect(e.manager.takeDeferral("mcp:shop.summary", { day: 2 }, ctx)).toEqual({ ask: true, forced: false });
    expect(e.manager.deferCall("mcp:shop.summary", undefined, { ...ctx, requireApproval: true })).toBe(true);
    expect(e.manager.takeDeferral("mcp:shop.summary", {}, ctx)).toEqual({ ask: true, forced: true });
  });
  it("OpenCode's own managed permission ask also defers, without approving native commands", async () => {
    const e = fixture(), managedPermission = vi.fn((target: { kind: string; name?: string }) => target.kind === "tool" && target.name === "summary");
    const input = { permissionMode: "ask" as const, requestPermission: e.outer, managedPermission };
    expect(await decidePluginAsk(input, { kind: "permission", tool: "mcp__cubiq__summary", summary: "fixture" } as never)).toBe("allow-once");
    expect(e.outer).not.toHaveBeenCalled();
    expect(await decidePluginAsk(input, { kind: "permission", tool: "bash", summary: "native command" } as never)).toBe("deny");
  });
});

describe("real native driver callbacks plus loopback execution", () => {
  it.each(["codex", "acp"] as const)("%s asks once in main, not once per engine and once per host", async (engine) => {
    const e = fixture(), server = await startToolServer(() => [e.tool]); cleanup.push(() => server.close());
    const result = join(tempDir(), "result.json"), home = tempDir();
    const env = { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, MANAGED_RESULT: result };
    vi.stubEnv("CODEX_HOME", home);
    const peer = resolve("test/fixtures/managed-approval-agent.mjs");
    const driver: AgentDriver = engine === "codex"
      ? createCodexDriver({ command: process.execPath, args: [peer, engine], clientVersion: "fixture", injection: () => ({ byok: false, env }), toolServer: async () => ({ ...server, url: withThread(server.url, "thread") }) })
      : createAcpDriver({ id: "fixture", label: "Fixture", command: process.execPath, args: [peer, engine] }, { clientVersion: "fixture", injection: () => ({ byok: false, env }), toolServer: async () => server });
    cleanup.push(() => driver.dispose?.());
    await driver.runTurn(e.input);
    const report = JSON.parse(readFileSync(result, "utf8"));
    expect(report.error).toBeUndefined(); expect(report.result.isError).toBe(true);
    expect(e.outer).not.toHaveBeenCalled(); expect(e.approve).toHaveBeenCalledOnce(); expect(e.run).not.toHaveBeenCalled();
  });
});

describe("native code mode mandatory execution gate", () => {
  it("wraps only the native code execution, preserving its advertised schema/access and refusing Allow escalation", async () => {
    const e = fixture("mutate", true);
    const native = { definition: { name: "run_code", description: "Native code", parameters: { type: "object", properties: { code: { type: "string" } } } }, displayName: "run_code", access: "read" as const, summarize: () => "code", run: vi.fn(async () => ({ text: "Executed", isError: false })) };
    const loop = managedCodeLoop(native, { managedRunCode: (args, execute, signal) => e.manager.execute({ ...e.tool, name: "run_code", input: { code: z.string() }, effect: "mutate", run: (input, ctx) => execute(input, ctx!.signal!) }, args, { threadId: "thread", projectId: "project", signal }) });
    expect(loop.definition).toBe(native.definition); expect(loop.access).toBe("read");
    expect(await loop.run({ code: "return 1" }, { id: "call", signal: e.turn.signal, onOutput: () => {} })).toMatchObject({ isError: true });
    expect(e.approve).toHaveBeenCalledOnce(); expect(native.run).not.toHaveBeenCalled();
    e.rule("allow"); native.run.mockResolvedValueOnce({ text: "Native guard refused", isError: true });
    expect(await loop.run({ code: "return 1" }, { id: "next", signal: e.turn.signal, onOutput: () => {} })).toMatchObject({ isError: true, text: "Native guard refused" });
    expect(e.approve).toHaveBeenCalledOnce();
  });
});
