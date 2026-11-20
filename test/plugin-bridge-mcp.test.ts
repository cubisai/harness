import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { appBridgeScript } from "../src/shared/apps";
import { harnessToolOptions, TOOL_SERVER } from "../src/main/agents/claude";
import { codexToolConfig } from "../src/main/agents/codex";
import { startToolServer, withProject, withShells, withThread } from "../src/main/mcp-http";
import { pluginInputShape, parsePluginInput } from "../src/main/apps/tool-schema";
import type { HarnessTool, ToolContext } from "../src/main/agents/types";
import { closeAfter } from "./helpers";

function bridge() {
  const posted: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const listeners: Record<string, (e: unknown) => void> = {};
  const win = { parent, addEventListener: (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; } };
  const doc = { documentElement: { style: { setProperty() {} }, dataset: {} } };
  new Function("window", "document", "console", appBridgeScript({ ownStyle: true }))(win, doc, { error() {}, warn() {} });
  const api = (win as unknown as { cubiq: { onTool(name: string, fn: (args: unknown) => unknown): void; onCard(fn: (data: unknown) => void): () => void } }).cubiq;
  const message = (data: unknown, source: unknown = parent) => listeners.message!({ source, data });
  return { api, posted, message };
}

describe("plugin bridge", () => {
  it("only a parent tool-mode host can invoke a registered handler; reports failures", async () => {
    const b = bridge();
    const handler = vi.fn((args) => ({ text: JSON.stringify(args) }));
    b.api.onTool("save", handler);
    expect(b.posted).toContainEqual({ cubiqApp: 1, op: "tool-register", name: "save" });
    const invoke = { cubiqApp: 1, op: "tool-invoke", id: "invoke", name: "save", args: { n: 1 } };
    b.message(invoke);
    expect(handler).not.toHaveBeenCalled();
    b.message({ cubiqApp: 1, op: "tool-mode" }, {});
    b.message(invoke);
    expect(handler).not.toHaveBeenCalled();
    b.message({ cubiqApp: 1, op: "tool-mode" });
    b.message(invoke, {});
    expect(handler).not.toHaveBeenCalled();
    b.message(invoke);
    await vi.waitFor(() => expect(b.posted).toContainEqual({ cubiqApp: 1, op: "tool-result", id: "invoke", ok: true, result: { text: '{"n":1}' } }));
    expect(handler).toHaveBeenCalledOnce();
    expect(() => b.api.onTool("save", handler)).toThrow("unique");
    b.api.onTool("fail", () => { throw new Error("nope"); });
    b.message({ ...invoke, name: "fail" });
    await vi.waitFor(() => expect(b.posted).toContainEqual(expect.objectContaining({ op: "tool-result", ok: false, error: expect.stringContaining("nope") })));
  });

  it("delivers JSON card data only from the parent and replays to late listeners", () => {
    const b = bridge();
    const first = vi.fn(), late = vi.fn();
    const remove = b.api.onCard(first);
    b.message({ cubiqApp: 1, op: "card", data: { title: "Untrusted <script>" } }, {});
    expect(first).not.toHaveBeenCalled();
    b.message({ cubiqApp: 1, op: "card", data: { title: "Paper" } });
    b.api.onCard(late);
    expect(first).toHaveBeenCalledWith({ title: "Paper" });
    expect(late).toHaveBeenCalledWith({ title: "Paper" });
    remove();
    b.message({ cubiqApp: 1, op: "card", data: null });
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenLastCalledWith(null);
  });
});

describe("plugin tools on engine transports", () => {
  const make = (seen: ToolContext[]): HarnessTool => ({ name: "plugin_notes__save", description: "Save a note", input: pluginInputShape(parsePluginInput({ type: "object", properties: { title: { type: "string" }, tag: { type: "string" } }, required: ["title"] })), autoAllow: true, effect: "mutate", run: async (_args, ctx) => { if (ctx) seen.push(ctx); return { text: "Saved" }; } });
  it("Claude offers the real schema without alwaysLoad and forwards the calling context", async () => {
    const seen: ToolContext[] = [];
    const tool = make(seen);
    const opts = harnessToolOptions([tool], { threadId: "t1", projectId: "p1" });
    const server = (opts.mcpServers?.[TOOL_SERVER] as unknown as { instance: { connect(t: unknown): Promise<void>; _registeredTools: Record<string, { _meta?: Record<string, unknown> }> } }).instance;
    expect(server._registeredTools[tool.name]!._meta?.["anthropic/alwaysLoad"]).toBeUndefined();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    expect((await client.listTools()).tools[0]!.inputSchema.required).toEqual(["title"]);
    expect((await client.callTool({ name: tool.name, arguments: { title: "Paper" } })).content).toEqual([{ type: "text", text: "Saved" }]);
    expect(seen).toEqual([{ threadId: "t1", projectId: "p1" }]);
    await client.close();
  });

  it.each(["codex", "acp"])("%s discovers and calls plugin tools on its thread's MCP URL", async (engine) => {
    const seen: ToolContext[] = [];
    const tool = make(seen);
    const server = await startToolServer(() => [], undefined, undefined, undefined, 5, undefined, undefined, undefined, () => [tool]);
    closeAfter(() => void server.close());
    let url = withShells(withProject(server.url, "p1"), "t1");
    if (engine === "acp") url = withThread(url, "t1");
    const config = codexToolConfig({ url, token: server.token }, [tool], "ask") as { mcp_servers: Record<string, unknown> };
    expect(config.mcp_servers).toHaveProperty("cubiq");
    const client = new Client({ name: engine, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
    const listed = (await client.listTools()).tools;
    expect(listed.map((t) => t.name)).toEqual([tool.name]);
    expect(listed[0]!.inputSchema.required).toEqual(["title"]);
    expect((await client.callTool({ name: tool.name, arguments: { title: "Paper" } })).content).toEqual([{ type: "text", text: "Saved" }]);
    expect(seen[0]).toMatchObject({ projectId: "p1", threadId: "t1", signal: expect.any(AbortSignal) });
    await client.close();
  });
});
