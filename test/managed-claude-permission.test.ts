import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClaudeDriver } from "../src/main/agents/claude";
import { ManagedToolRules } from "../src/main/apps/tool-rules";
import type { HarnessTool, TurnInput } from "../src/main/agents/types";
import { tempDir } from "./helpers";

const sdk = vi.hoisted(() => ({ work: null as null | ((options: Record<string, unknown>) => Promise<void>) }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...await original<typeof import("@anthropic-ai/claude-agent-sdk")>(),
  query: ({ options }: { options: Record<string, unknown> }) => ({ supportedModels: async () => [], [Symbol.asyncIterator]: async function* () { await sdk.work?.(options); } }),
}));
afterEach(() => { sdk.work = null; });

describe("Claude's real permission callback and in-process MCP execution", () => {
  it.each([["full", "ask"], ["ask", "ask"], ["full", null]] as const)("driver-appended todowrite retains forced Ask in %s mode (rule %s) even outside main's input list", async (mode, rule) => {
    const turn = new AbortController(), approve = vi.fn(async () => false), outer = vi.fn<TurnInput["requestPermission"]>(async () => "deny");
    const manager = new ManagedToolRules({ policy: { rules: (target) => target.kind === "tool" && target.name === "todowrite" ? rule : null, rulesRevision: () => "one" }, thread: () => ({ projectId: "project", permissionMode: mode, kind: "chat", agent: "claude", signal: turn.signal }), approve });
    const input: TurnInput = { threadId: "thread", projectId: "project", cwd: tempDir(), prompt: "Protocol fixture", sessionId: null, model: "sonnet", permissionMode: mode, signal: turn.signal, tools: [], mcpServers: [], managedTools: (tools) => manager.tools(tools), managedPermission: () => false, onEvent: () => {}, onTextDelta: () => {}, onSession: () => {}, requestPermission: outer, requestPlanDecision: async () => ({ keep: "" }) };
    sdk.work = async (options) => {
      expect(options.allowedTools).toContain("mcp__cubiq__todowrite");
      const args = { todos: [{ content: "Local task", status: "pending" }] };
      if (mode === "ask" || rule === null) {
        const permit = options.canUseTool as (name: string, args: Record<string, unknown>, extra: unknown) => Promise<{ behavior: string }>;
        expect((await permit("mcp__cubiq__todowrite", args, { matchedAskRule: true })).behavior).toBe("allow");
      }
      const server = (options.mcpServers as Record<string, { instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> } }>).cubiq!.instance;
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
      const client = new Client({ name: "local-todo-factory-fixture", version: "1" });
      try { await client.connect(b); expect((await client.callTool({ name: "todowrite", arguments: args })).isError).toBe(true); }
      finally { await client.close(); await server.close(); }
    };
    const driver = createClaudeDriver({ useInstalledCli: false });
    try { await driver.runTurn(input); } finally { driver.dispose?.(); manager.dispose(); }
    expect(approve).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled();
  });
  it.each(["ask", "allow"] as const)("%s routes to the exact host gate without changing native permission settings", async (decision) => {
    const turn = new AbortController(), approve = vi.fn(async () => false), outer = vi.fn<TurnInput["requestPermission"]>(async () => "deny");
    const run = vi.fn<HarnessTool["run"]>(async () => ({ text: "Host local guard refused", isError: true }));
    const manager = new ManagedToolRules({ policy: { rules: (_target, read) => decision === "allow" && !read ? null : decision, rulesRevision: () => "one" }, thread: () => ({ projectId: "project", permissionMode: "ask", kind: "chat", agent: "claude", signal: turn.signal }), approve });
    const raw: HarnessTool = { name: "summary", description: "Local read fixture", input: { day: z.number() }, autoAllow: false, effect: "read", run };
    const wrapped = manager.tool(raw, "thread");
    const input: TurnInput = { threadId: "thread", projectId: "project", cwd: tempDir(), prompt: "Local protocol fixture only", sessionId: null, model: "sonnet", permissionMode: "ask", signal: turn.signal, tools: [wrapped], mcpServers: [], onEvent: () => {}, onTextDelta: () => {}, onSession: () => {}, requestPermission: outer, requestPlanDecision: async () => ({ keep: "" }) };
    sdk.work = async (options) => {
      expect(options.permissionMode).toBe("default");
      expect(options.allowedTools).not.toContain("mcp__cubiq__summary");
      const permit = options.canUseTool as (name: string, args: Record<string, unknown>, extra: unknown) => Promise<{ behavior: string; updatedPermissions?: unknown }>;
      const answer = await permit("mcp__cubiq__summary", { day: 1 }, {});
      expect(answer.behavior).toBe("allow"); expect(answer.updatedPermissions).toBeUndefined(); expect(outer).not.toHaveBeenCalled();
      const server = (options.mcpServers as Record<string, { instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> } }>).cubiq!.instance;
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
      const client = new Client({ name: "local-claude-approval-fixture", version: "1" });
      try { await client.connect(b); expect((await client.callTool({ name: "summary", arguments: { day: 1 } })).isError).toBe(true); }
      finally { await client.close(); await server.close(); }
    };
    const driver = createClaudeDriver({ useInstalledCli: false });
    try { await driver.runTurn(input); } finally { driver.dispose?.(); manager.dispose(); }
    expect(outer).not.toHaveBeenCalled();
    if (decision === "ask") { expect(approve).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); }
    else { expect(approve).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledOnce(); }
  });
});
