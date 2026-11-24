import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PluginTools } from "../src/main/apps/tools";
import { ManagedToolRules } from "../src/main/apps/tool-rules";
import { validateApp } from "../src/main/apps/manifest";
import { AppCalls } from "../src/main/apps/calls";
import { AppRegistry } from "../src/main/apps/registry";
import { harnessToolOptions, TOOL_SERVER } from "../src/main/agents/claude";
import { codexToolConfig } from "../src/main/agents/codex";
import { startToolServer, withBrowserOnDemandFlag, withCode, withDesign, withShells, withThread } from "../src/main/mcp-http";
import { callServerTool, McpClientPool } from "../src/main/mcp/router";
import { McpToolsCache } from "../src/main/mcp/servers";
import type { AppInfo, McpServerEntry } from "../src/shared/types";
import type { HarnessTool } from "../src/main/agents/types";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
function managedRuntime(target = "summary") {
  const turn = new AbortController(), approve = vi.fn(async () => false), run = vi.fn(async () => ({ text: "must not run" }));
  const raw: HarnessTool = { name: target === "browser_snapshot" || target === "browser_call" ? "browser_snapshot" : "summary", description: "Local read", input: {}, autoAllow: true, effect: "read", run };
  const manager = new ManagedToolRules({ policy: { rules: (t) => t.kind === "tool" && t.name === target ? "ask" : null, rulesRevision: () => "one" }, thread: () => ({ projectId: "project", permissionMode: "full", kind: "chat", agent: "fixture", signal: turn.signal }), approve });
  cleanups.push(() => manager.dispose()); return { manager, raw, approve, run };
}

describe("mandatory generic managed rules on real transports", () => {
  it("Claude's auto-allowed in-process tool still reaches the mandatory execution gate", async () => {
    const e = managedRuntime(), tool = e.manager.tool(e.raw, "thread"), opts = harnessToolOptions([tool], { threadId: "thread", projectId: "project" });
    expect(opts.allowedTools).toContain(`mcp__${TOOL_SERVER}__summary`);
    const server = (opts.mcpServers?.[TOOL_SERVER] as unknown as { instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> } }).instance;
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); cleanups.push(() => server.close());
    const client = new Client({ name: "claude-managed-fixture", version: "1" }); await client.connect(b); cleanups.push(() => client.close());
    expect((await client.callTool({ name: "summary", arguments: {} })).isError).toBe(true);
    expect(e.approve).toHaveBeenCalledOnce(); expect(e.run).not.toHaveBeenCalled();
  });
  it.each(["codex", "acp", "code", "design"])("%s's thread-bound HTTP tools cannot bypass mandatory Ask", async (kind) => {
    const e = managedRuntime(), server = await startToolServer(() => [e.raw], undefined, undefined, undefined, 5, undefined, undefined, undefined, undefined, (tools, id) => e.manager.tools(tools, id));
    cleanups.push(() => server.close());
    const url = kind === "codex" ? withShells(server.url, "thread") : kind === "code" ? withCode(server.url, "thread") : kind === "design" ? withDesign(server.url, "thread") : withThread(server.url, "thread");
    const client = new Client({ name: kind, version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } })); cleanups.push(() => client.close());
    expect((await client.callTool({ name: "summary", arguments: {} })).isError).toBe(true);
    expect(e.approve).toHaveBeenCalledOnce(); expect(e.run).not.toHaveBeenCalled();
  });
  it.each(["browser_call", "browser_snapshot"])("on-demand browser delivery gates exact %s targets without running an inner tool", async (target) => {
    const e = managedRuntime(target), server = await startToolServer(() => [e.raw], undefined, undefined, undefined, 5, undefined, undefined, undefined, undefined, (tools, id) => e.manager.tools(tools, id));
    cleanups.push(() => server.close());
    const client = new Client({ name: "on-demand-fixture", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(withBrowserOnDemandFlag(withThread(server.url, "thread"), true)), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } })); cleanups.push(() => client.close());
    expect((await client.callTool({ name: "browser_call", arguments: { tool: "browser_snapshot", arguments: {} } })).isError).toBe(true);
    expect(e.approve).toHaveBeenCalledOnce(); expect(e.run).not.toHaveBeenCalled();
  });
});
function runtime() {
  const check = validateApp("notes", [{ path: "app.json", content: JSON.stringify({ name: "notes", title: "Notes", description: "Notes", tools: [{ name: "save", description: "Save", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }] }) }, { path: "index.html", content: "<h1>Notes</h1>" }]);
  if (!check.ok) throw new Error("Invalid fixture");
  const app: AppInfo = { key: "g~notes", name: "notes", scope: "global", title: "Notes", description: "", grants: [], path: "", url: "" };
  const turn = new AbortController();
  const createWindow = vi.fn(() => { throw new Error("Denied calls must not start a sandbox"); });
  // Model-side Full access cannot bypass this main-side single-use forced Ask.
  const approve = vi.fn(async (_tid: string, _title: string, _summary: string, _signal: AbortSignal, _connector: boolean, forced?: boolean) => !forced);
  const tools = new PluginTools({ registry: { list: () => [app], manifest: () => check.manifest }, calls: { call: async () => ({ ok: true, result: null }), storeGet: () => null, storeSet: () => ({ ok: true, result: null }) }, signal: () => turn.signal, createWindow, approve, emit: () => {}, forceAsk: (name) => name === "plugin_notes__save", rulesRevision: () => "policy-one" });
  cleanups.push(() => tools.dispose());
  return { tool: tools.tools("thread", null)[0]!, createWindow, approve };
}

describe("forced plugin Ask on real engine MCP transports", () => {
  it("Claude's in-process MCP call reaches mandatory main approval despite autoAllow", async () => {
    const e = runtime(), opts = harnessToolOptions([e.tool], { threadId: "thread" });
    const server = (opts.mcpServers?.[TOOL_SERVER] as unknown as { instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> } }).instance;
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
    cleanups.push(() => server.close());
    const client = new Client({ name: "claude-fixture", version: "1" }); await client.connect(b);
    cleanups.push(() => client.close());
    const out = await client.callTool({ name: e.tool.name, arguments: { title: "A" } });
    expect(out.isError).toBe(true);
    expect(e.approve).toHaveBeenCalledWith("thread", "Notes", expect.any(String), expect.any(AbortSignal), false, true);
    expect(e.createWindow).not.toHaveBeenCalled();
  });
  it.each(["codex", "acp"])("%s's HTTP call cannot skip forced Ask under Full access", async (engine) => {
    const e = runtime(), server = await startToolServer(() => [], undefined, undefined, undefined, 5, undefined, undefined, undefined, () => [e.tool]);
    cleanups.push(() => server.close());
    let url = withShells(server.url, "thread"); if (engine === "acp") url = withThread(url, "thread");
    const config = codexToolConfig({ url, token: server.token }, [e.tool], "full");
    expect(config).toHaveProperty("mcp_servers.cubiq");
    const client = new Client({ name: engine, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
    cleanups.push(() => client.close());
    const out = await client.callTool({ name: e.tool.name, arguments: { title: "A" } });
    expect(out.isError).toBe(true); expect(e.approve).toHaveBeenCalledOnce(); expect(e.createWindow).not.toHaveBeenCalled();
    expect(e.approve.mock.calls[0]?.at(-1)).toBe(true);
  });
  it("the native harness tool entry retains mandatory approval instead of trusting its autoAllow descriptor", async () => {
    const e = runtime(); expect(e.tool.autoAllow).toBe(true);
    expect((await e.tool.run({ title: "A" }, { threadId: "thread" })).isError).toBe(true);
    expect(e.approve).toHaveBeenCalledOnce(); expect(e.createWindow).not.toHaveBeenCalled();
  });
});

describe("app/card connector Ask through real MCP transport", () => {
  it("asks before execution and cached reads, and spends only one exact-call token", async () => {
    const root = mkdtempSync(join(tmpdir(), "rules-transport-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ran = vi.fn(async () => ({ text: '{"total":42}' }));
    const tool: HarnessTool = { name: "summary", description: "Summary", input: { day: z.number().optional() }, effect: "read", autoAllow: true, run: ran };
    const server = await startToolServer(() => [tool]); cleanups.push(() => server.close());
    const entries: McpServerEntry[] = [{ name: "shop", enabled: true, spec: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.token}` } } }];
    const listings = new McpToolsCache(), pool = new McpClientPool(); cleanups.push(() => pool.closeAll());
    const dir = join(root, "apps", "sales"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "sales", title: "Sales", description: "Sales", cacheSec: 30, grants: [{ server: "shop", tools: ["summary"] }] }));
    writeFileSync(join(dir, "index.html"), "<h1>Sales</h1>");
    let forced = false, revision = "none";
    const calls = new AppCalls({ registry: new AppRegistry({ globalDir: join(root, "apps"), projectPath: () => null }), dataDir: join(root, "data"), rules: { decision: () => forced ? "ask" : null, revision: () => revision }, call: (pid, server, name, args, before, signal) => callServerTool({ servers: () => entries, listings, pool }, pid, server, name, args, signal, before) });
    expect(await calls.call("g~sales", null, "shop", "summary", { day: 1 }, undefined, { readOnly: true })).toMatchObject({ ok: true });
    expect(ran).toHaveBeenCalledOnce();
    // Same revision deliberately proves the pre-cache decision, not just cache-key invalidation.
    forced = true;
    const q = await calls.call("g~sales", null, "shop", "summary", { day: 1 }, undefined, { readOnly: true });
    expect(q).toHaveProperty("approval"); expect(ran).toHaveBeenCalledOnce();
    if (!("approval" in q)) throw new Error("Expected approval");
    expect(await calls.call("g~sales", null, "shop", "summary", { day: 1 }, { token: q.approval.token }, { readOnly: true })).toMatchObject({ ok: true });
    expect(ran).toHaveBeenCalledTimes(2);
    expect(await calls.call("g~sales", null, "shop", "summary", { day: 1 }, { token: q.approval.token }, { readOnly: true })).toHaveProperty("approval");
    expect(ran).toHaveBeenCalledTimes(2);
    revision = "updated";
    expect(await calls.call("g~sales", null, "shop", "summary", { day: 1 }, { token: q.approval.token }, { readOnly: true })).toHaveProperty("approval");
    expect(ran).toHaveBeenCalledTimes(2);
  });
});
