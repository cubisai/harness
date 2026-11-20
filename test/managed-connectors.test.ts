import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ManagedConnectors } from "../src/main/mcp/managed-connectors";
import { McpGateway } from "../src/main/mcp/gateway";
import { McpClientPool } from "../src/main/mcp/router";
import { forAcp, forClaude, forCodex } from "../src/main/mcp/servers";
import { startToolServer, type ToolServer } from "../src/main/mcp-http";
import type { McpServerEntry, McpServerSpec, PermissionMode } from "../src/shared/types";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function fixture(spec: McpServerSpec = { type: "stdio", command: process.execPath, args: [resolve("test/fixtures/mcp-plugin-connector.mjs")], env: { FIXTURE_KEY: "private-secret" } }) {
  let projectId = "project", scope = "global", enabled = true, policy = "one", forced = false, allowed = false, native: false | { ask: boolean; forced?: boolean } = false, mode: PermissionMode = "full", kind = "chat", agent = "fixture", now = 1_000;
  let currentSpec = spec, turn = new AbortController(), server: ToolServer | null = null;
  const pools: McpClientPool[] = [];
  const approve = vi.fn(async (_tid: string, _server: string, _tool: string, _args: Record<string, unknown>, _signal: AbortSignal) => true);
  const connectors = new ManagedConnectors({
    configured: () => enabled ? [{ scope, entry: { name: "shop", spec: currentSpec, enabled: true } }] : [],
    resolve: (e) => e.spec, endpoint: () => server,
    pool: (_scope, _name, changed) => { const pool = new McpClientPool({ onToolsChanged: changed }); pools.push(pool); return pool; },
    thread: (id) => id.startsWith("thread") ? { projectId, permissionMode: mode, kind, agent, signal: turn.signal } : null,
    policy: { rules: (_target, read) => forced ? "ask" : allowed && read ? "allow" : null, rulesRevision: () => policy }, approve, now: () => now,
    nativeAsk: () => native,
  });
  server = await startToolServer(() => [], undefined, undefined, undefined, undefined, (req, res, prefix, id) => prefix === "managed" ? connectors.handle(req, res, id) : Promise.resolve(void res.writeHead(404).end()));
  cleanups.push(() => server!.close(), () => connectors.closeAll());
  return { connectors, pools, approve, server,
    force: () => { forced = true; policy = "forced"; },
    allow: () => { allowed = true; policy = "allowed"; }, native: (requirement: typeof native) => { native = requirement; },
    rules: () => { policy = "changed"; connectors.invalidateRules(); },
    off: () => { enabled = false; connectors.invalidate(scope, "shop"); },
    on: () => { enabled = true; connectors.invalidate(scope, "shop"); },
    replace: () => { currentSpec = { type: "stdio", command: "must-not-run" }; },
    override: () => { scope = "project:project"; },
    project: () => { projectId = "other"; },
    mode: (m: PermissionMode) => { mode = m; },
    kind: (k: string) => { kind = k; },
    agent: () => { agent = "other"; },
    turn: () => { turn = new AbortController(); },
    tick: () => { now += 600_001; },
  };
}
async function client(entry: McpServerEntry, engine = "fixture") {
  if (entry.spec.type === "stdio") throw new Error("A native connector must be mediated");
  const c = new Client({ name: engine, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(entry.spec.url), { requestInit: { headers: entry.spec.headers } }));
  cleanups.push(() => c.close()); return c;
}

describe("main-mediated external connectors", () => {
  it("hands ordinary native asks to one schema-verified host approval and skips only exact read-Allow", async () => {
    const e = await fixture(); e.mode("ask"); e.native({ ask: true });
    const c = await client(e.connectors.entries("project", "thread")[0]!);
    await c.callTool({ name: "summary", arguments: { day: 1 } }); expect(e.approve).toHaveBeenCalledOnce();
    e.allow(); await c.callTool({ name: "summary", arguments: { day: 1 } }); expect(e.approve).toHaveBeenCalledOnce();
    await c.callTool({ name: "save", arguments: {} }); expect(e.approve).toHaveBeenCalledTimes(2);
    e.native({ ask: true, forced: true }); await c.callTool({ name: "summary", arguments: {} }); expect(e.approve).toHaveBeenCalledTimes(3);
    e.force(); e.mode("full"); e.approve.mockResolvedValueOnce(false);
    expect((await c.callTool({ name: "summary", arguments: {} })).isError).toBe(true); expect(e.approve).toHaveBeenCalledTimes(4);
  });
  it.each(["claude", "codex", "acp"])("%s receives a lazy opaque route for stdio, with a mandatory Ask inside execution", async (engine) => {
    const e = await fixture(), entry = e.connectors.entries("project", "thread")[0]!;
    expect(e.pools).toHaveLength(0); expect(JSON.stringify(entry)).not.toMatch(/private-secret|mcp-plugin-connector|command/);
    if (engine === "claude") expect(forClaude([entry]).shop?.type).toBe("http");
    if (engine === "codex") expect(forCodex([entry]).shop).not.toHaveProperty("command");
    if (engine === "acp") { expect(forAcp([entry], true)[0]).toHaveProperty("type", "http"); expect(forAcp([entry], false)).toEqual([]); }
    const c = await client(entry, engine); expect(e.pools).toHaveLength(0);
    expect((await c.listTools()).tools).toHaveLength(2);
    e.force(); e.approve.mockResolvedValueOnce(false);
    expect((await c.callTool({ name: "summary", arguments: { day: 1 } })).isError).toBe(true);
    const r = await c.callTool({ name: "summary", arguments: { day: 1 } });
    expect(r.isError).not.toBe(true); expect(r.structuredContent).toEqual({ total: 42 });
    await c.callTool({ name: "summary", arguments: { day: 1 } }); expect(e.approve).toHaveBeenCalledTimes(3);
  });
  it("main listing routes cannot execute and neither query parameters nor model approval fields can bind a turn", async () => {
    const e = await fixture(), entry = e.connectors.entries("project")[0]!;
    if (entry.spec.type === "stdio") throw new Error("Wrong transport");
    const c = await client({ ...entry, spec: { ...entry.spec, url: `${entry.spec.url}?t=thread&p=project` } });
    expect((await c.listTools()).tools).toHaveLength(2);
    expect((await c.callTool({ name: "summary", arguments: { approval: "yes", threadId: "thread" } })).isError).toBe(true);
    expect(e.approve).not.toHaveBeenCalled();
    expect(e.connectors.entries("other", "thread")).toEqual([]);
  });
  it("a project's Off/On invalidation retires its old route without dropping another project's listing", async () => {
    const e = await fixture(), c = await client(e.connectors.entries("project", "thread")[0]!);
    const other = await client(e.connectors.entries("other")[0]!);
    e.connectors.invalidateProject("project", "shop");
    await expect(c.callTool({ name: "summary" })).rejects.toThrow();
    expect((await other.listTools()).tools).toHaveLength(2);
    expect(e.connectors.entries("project", "thread")[0]?.spec).toBeDefined();
  });
  it.each(["off", "replace", "override", "project"] as const)("old live sessions refuse %s rather than silently substitute a connector", async (change) => {
    const e = await fixture(), c = await client(e.connectors.entries("project", "thread")[0]!);
    expect((await c.callTool({ name: "summary" })).isError).not.toBe(true);
    e[change](); await expect(c.callTool({ name: "summary" })).rejects.toThrow();
    if (change === "off") { e.on(); await expect(c.callTool({ name: "summary" })).rejects.toThrow(); }
  });
  it.each(["rules", "mode", "kind", "agent", "turn", "project"] as const)("discards a pending approval after %s changes", async (change) => {
    const e = await fixture(); e.force(); const c = await client(e.connectors.entries("project", "thread")[0]!);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), ready = new Promise<void>((r) => { release = r; });
    e.approve.mockImplementationOnce(async () => { entered(); await ready; return true; });
    const call = c.callTool({ name: "summary" }); await started;
    if (change === "mode") e.mode("plan"); else if (change === "kind") e.kind("design"); else e[change]();
    release(); expect((await call).isError).toBe(true);
  });
  it("freezes actual input before waiting and validates schemas/Plan/design before requesting approval", async () => {
    const e = await fixture(); e.connectors.entries("project", "thread"); e.force();
    const input = { day: 1 };
    e.approve.mockImplementationOnce(async (_tid, _server, _tool, shown) => { input.day = 2; shown.day = 3; return true; });
    expect(await e.connectors.call("project", "shop", "summary", input, { threadId: "thread" })).toMatchObject({ isError: false });
    expect(e.approve.mock.calls[0]?.[3]).toEqual({ day: 3 });
    e.mode("plan"); expect(await e.connectors.call("project", "shop", "save", {}, { threadId: "thread" })).toMatchObject({ isError: true, text: expect.stringContaining("Plan/design") });
    e.mode("full"); e.kind("design"); expect(await e.connectors.call("project", "shop", "save", {}, { threadId: "thread" })).toMatchObject({ isError: true });
    expect(await e.connectors.call("project", "shop", "summary", { day: "no" }, { threadId: "thread" })).toMatchObject({ isError: true });
    expect(e.approve).toHaveBeenCalledOnce();
  });
  it("main app/card gates retain denials without an extra approval, and stale read hints expire", async () => {
    const e = await fixture(); e.connectors.entries("project", "thread");
    const before = vi.fn(async () => "Missing grant");
    expect(await e.connectors.call("project", "shop", "save", {}, { before })).toMatchObject({ isError: true, text: "Missing grant" });
    expect(e.approve).not.toHaveBeenCalled();
    const pool = e.pools[0]!, request = vi.spyOn(pool, "request");
    e.tick(); e.mode("plan"); vi.spyOn(pool, "listTools").mockResolvedValueOnce({ ok: true, tools: [{ name: "summary", description: "Now mutating", inputSchema: { type: "object", properties: {} } }] });
    expect(await e.connectors.call("project", "shop", "summary", {}, { threadId: "thread" })).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
  });
  it("Off interrupts real HTTP transport; thread deletion refuses existing sessions", async () => {
    let entered!: () => void, cancelled!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), stopped = new Promise<void>((r) => { cancelled = r; });
    const upstream = await startToolServer(() => [{ name: "summary", description: "Local slow read", input: { day: z.number().optional() }, autoAllow: true, effect: "read", run: async (_args, ctx) => { entered(); await new Promise<void>((r) => ctx!.signal!.addEventListener("abort", () => { cancelled(); r(); }, { once: true })); return { text: "late" }; } }]);
    cleanups.push(() => upstream.close());
    const e = await fixture({ type: "http", url: `${upstream.url}?t=fixture`, headers: { Authorization: `Bearer ${upstream.token}` } });
    const c = await client(e.connectors.entries("project", "thread")[0]!);
    const call = c.callTool({ name: "summary" }); await started; e.off(); await stopped; expect((await call).isError).toBe(true);
    e.on(); const fresh = await client(e.connectors.entries("project", "thread")[0]!); e.connectors.forgetThread("thread");
    await expect(fresh.callTool({ name: "summary" })).rejects.toThrow();
  });
});

describe("legacy remote gateway cannot bypass mandatory rules", () => {
  it("refuses individual and batched tools/call before making any upstream HTTP request", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const gateway = new McpGateway({ listingOnly: true, target: () => ({ key: "global:shop", spec: { type: "http", url: "https://never-contact.invalid/mcp" } }), auth: { hasTokens: () => false, accessToken: async () => null, refresh: async () => null, noteStepUp: () => {} }, fetchFn });
    const http = createServer((req, res) => { void gateway.handle(req, res, "global", "shop"); });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => http.close(() => r())), () => gateway.closeAll());
    const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing address");
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summary" } };
    for (const body of [call, [{ jsonrpc: "2.0", id: 2, method: "tools/list" }, call]]) {
      const r = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      expect(r.status).toBe(200); expect(JSON.stringify(await r.json())).toContain("Legacy connector routes");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
