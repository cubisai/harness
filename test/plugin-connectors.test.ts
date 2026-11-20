import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PluginConnectors, type OwnedConnector } from "../src/main/apps/connectors";
import { connectorCredentialKey, PluginConnectorCredentials } from "../src/main/apps/connector-credentials";
import { partRuntimeName } from "../src/main/apps/parts";
import { McpVault } from "../src/main/mcp/vault";
import { forAcp, forClaude, forCodex } from "../src/main/mcp/servers";
import { startToolServer, type ToolServer } from "../src/main/mcp-http";
import { McpClientPool } from "../src/main/mcp/router";
import type { McpServerSpec, PermissionMode } from "../src/shared/types";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
function vault() {
  const dir = mkdtempSync(join(tmpdir(), "plugin-connectors-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new McpVault(join(dir, "vault.json"), { available: true, encrypt: (s) => Buffer.from(s).toString("base64"), decrypt: (s) => Buffer.from(s, "base64").toString() });
}
async function fixture(spec: McpServerSpec = { type: "stdio", command: process.execPath, args: [resolve("test/fixtures/mcp-plugin-connector.mjs")], env: { FIXTURE_KEY: "${FIXTURE_KEY}" } }) {
  let revision = "one", enabled = true, removed = false, forced = false, policy = "one", mode: PermissionMode = "full", projectId = "project", now = 1_000;
  const part: OwnedConnector = { name: "shop", spec, runtimeName: partRuntimeName("notes", "shop"), revision, owner: { key: "g~notes", title: "Notes", enabled: true, revision } };
  const secretVault = vault(), credentials = new PluginConnectorCredentials(secretVault, {});
  if (spec.type === "stdio") credentials.save(part.owner.key, part, { FIXTURE_KEY: "fixture-secret" });
  const pools: McpClientPool[] = [], approve = vi.fn(async (_tid: string, _server: string, _tool: string, _args: Record<string, unknown>, _signal: AbortSignal) => true), turn = new AbortController();
  let server: ToolServer | null = null;
  const connectors = new PluginConnectors({
    bundles: {
      connectors: (off) => !removed && (off || enabled) ? [{ ...part, revision, owner: { ...part.owner, enabled, revision } }] : [],
      assertConnector: (c) => { if (!enabled || c.revision !== revision) throw new Error("Off, removed or changed"); },
      rules: () => forced ? "ask" : null, rulesRevision: () => policy,
    },
    endpoint: () => server,
    resolve: (c) => credentials.resolve(c.owner.key, c),
    pool: (_part, _spec, changed) => { const pool = new McpClientPool({ onToolsChanged: changed }); pools.push(pool); return pool; },
    thread: (id) => id.startsWith("thread") ? { projectId, permissionMode: mode, design: false, signal: turn.signal } : null,
    approve,
    now: () => now,
  });
  server = await startToolServer(() => [], undefined, undefined, undefined, undefined, (req, res, scope, name) => scope === "plugin" ? connectors.handle(req, res, name) : Promise.resolve(void res.writeHead(404).end()));
  cleanups.push(() => server!.close(), () => connectors.closeAll());
  return { part, connectors, pools, approve, credentials, secretVault, server,
    off: () => { enabled = false; revision = "off"; connectors.invalidate(part.owner.key); },
    on: () => { enabled = true; revision = "on"; },
    update: () => { revision = "two"; connectors.invalidate(part.owner.key); },
    remove: () => { removed = true; enabled = false; revision = "removed"; connectors.invalidate(part.owner.key); },
    force: () => { forced = true; policy = "forced"; },
    changeRules: () => { policy = "two"; connectors.invalidateRules(); },
    mode: (m: PermissionMode) => { mode = m; }, project: (p: string) => { projectId = p; }, turn,
    tick: (ms: number) => { now += ms; },
  };
}
async function client(spec: McpServerSpec, engine = "fixture") {
  if (spec.type === "stdio") throw new Error("An agent must never receive stdio");
  const client = new Client({ name: engine, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } }));
  cleanups.push(() => client.close()); return client;
}

describe("main-mediated bundled connectors", () => {
  it.each(["claude", "codex", "acp"])("%s gets only a lazy, thread-bound HTTP route for a bundled stdio server", async (engine) => {
    const e = await fixture(), entry = e.connectors.entries("thread")[0]!;
    expect(e.pools).toHaveLength(0); expect(JSON.stringify(entry)).not.toContain("fixture-secret"); expect(JSON.stringify(entry)).not.toContain("mcp-plugin-connector");
    if (engine === "claude") expect(Object.values(forClaude([entry]))[0]?.type).toBe("http");
    if (engine === "codex") expect(Object.values(forCodex([entry]))[0]).not.toHaveProperty("command");
    if (engine === "acp") expect(forAcp([entry], true)[0]).toHaveProperty("type", "http");
    const c = await client(entry.spec, engine); expect(e.pools).toHaveLength(0);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["summary", "save"]);
    const r = await c.callTool({ name: "summary", arguments: { day: 1 } });
    expect(r.isError).toBe(false); expect(r.structuredContent).toEqual({ total: 42 });
    expect((r.content as { text: string }[])[0]?.text).toContain('"configured":true'); expect(e.approve).not.toHaveBeenCalled();
    e.off(); await expect(c.callTool({ name: "summary" })).rejects.toThrow();
    expect(e.secretVault.has(connectorCredentialKey(e.part.owner.key, e.part))).toBe(true);
    e.on(); expect(e.connectors.entries("thread")).toEqual([]);
    const fresh = await client(e.connectors.entries("thread-new")[0]!.spec, engine);
    expect((await fresh.callTool({ name: "summary" })).isError).toBe(false);
  });
  it("main listing routes never execute, and query/argument project IDs cannot replace the originating context", async () => {
    const e = await fixture(), listing = await client(e.connectors.entries()[0]!.spec);
    expect((await listing.listTools()).tools).toHaveLength(2);
    expect((await listing.callTool({ name: "summary" })).isError).toBe(true);
    const route = e.connectors.entries("thread")[0]!, spec = route.spec;
    if (spec.type === "stdio") throw new Error("Wrong transport");
    const c = await client({ ...spec, url: `${spec.url}?p=other&t=other` });
    expect((await c.callTool({ name: "summary", arguments: { day: "invalid" } })).isError).toBe(true);
    e.project("other"); await expect(c.callTool({ name: "summary" })).rejects.toThrow();
    expect(await e.connectors.call("project", e.part.runtimeName, "summary", {}, { threadId: "thread" })).toMatchObject({ isError: true });
  });
  it("a removed connector stays reserved only in its old thread snapshot, preventing standalone name substitution", async () => {
    const e = await fixture(); e.connectors.entries("thread"); e.remove();
    expect(e.connectors.has(e.part.runtimeName)).toBe(false);
    expect(e.connectors.has(e.part.runtimeName, "thread")).toBe(true);
    const before = vi.fn(async () => null);
    expect(await e.connectors.call("project", e.part.runtimeName, "summary", {}, { threadId: "thread", before })).toMatchObject({ isError: true });
    expect(before).not.toHaveBeenCalled(); expect(e.pools).toHaveLength(0);
    e.connectors.forgetThread("thread"); expect(e.connectors.has(e.part.runtimeName, "thread")).toBe(false);
  });
  it("forced Ask under Full access is single-use, and pending/active calls are cancelled when policy changes", async () => {
    const e = await fixture(); e.force(); const c = await client(e.connectors.entries("thread")[0]!.spec);
    e.approve.mockResolvedValueOnce(false);
    expect((await c.callTool({ name: "summary" })).isError).toBe(true);
    expect((await c.callTool({ name: "summary" })).isError).toBe(false);
    expect((await c.callTool({ name: "summary" })).isError).toBe(false); expect(e.approve).toHaveBeenCalledTimes(3);
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    e.approve.mockImplementationOnce(async (_tid, _server, _tool, _args, signal) => { entered(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); return true; });
    const pending = c.callTool({ name: "summary" }); await started; e.changeRules(); expect((await pending).isError).toBe(true);
  });
  it("Plan fences and main app/card denials run before a bundled write even in Full access", async () => {
    const e = await fixture(); e.connectors.entries("thread"); e.mode("plan");
    expect(await e.connectors.call("project", e.part.runtimeName, "save", {}, { threadId: "thread" })).toMatchObject({ isError: true, text: expect.stringContaining("Plan/design") });
    e.mode("full");
    const before = vi.fn(async () => "Unapproved app grant");
    expect(await e.connectors.call("project", e.part.runtimeName, "save", {}, { before })).toMatchObject({ isError: true, text: "Unapproved app grant" });
    expect(before).toHaveBeenCalledOnce(); expect(e.approve).not.toHaveBeenCalled();
  });
  it("expires schema hints so an idle/reconnected connector cannot keep a stale read-only classification", async () => {
    const e = await fixture(); e.connectors.entries("thread");
    expect(await e.connectors.call("project", e.part.runtimeName, "summary", {}, { threadId: "thread" })).toMatchObject({ isError: false });
    const pool = e.pools[0]!, called = vi.spyOn(pool, "callTool"), listing = vi.spyOn(pool, "listTools");
    e.tick(600_001); e.mode("plan");
    listing.mockResolvedValueOnce({ ok: true, tools: [{ name: "summary", description: "Now mutating", inputSchema: { type: "object", properties: {} } }] });
    expect(await e.connectors.call("project", e.part.runtimeName, "summary", {}, { threadId: "thread" })).toMatchObject({ isError: true, text: expect.stringContaining("Plan/design") });
    expect(listing).toHaveBeenCalledOnce(); expect(called).not.toHaveBeenCalled();
  });
  it("old routes fail after Update; stop during a real HTTP connector call cancels transport and discards its result", async () => {
    let entered!: () => void, cancelled!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), stopped = new Promise<void>((resolve) => { cancelled = resolve; });
    const upstream = await startToolServer(() => [{ name: "summary", description: "Local slow connector", input: { day: z.number().optional() }, autoAllow: true, effect: "read", run: async (_args, ctx) => { entered(); await new Promise<void>((resolve) => ctx!.signal!.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true })); return { text: "late" }; } }]);
    cleanups.push(() => upstream.close());
    // A thread-bound local fixture supplies the HTTP disconnect cancellation signal.
    const e = await fixture({ type: "http", url: `${upstream.url}?t=fixture-thread`, headers: { Authorization: `Bearer ${upstream.token}` } });
    const c = await client(e.connectors.entries("thread")[0]!.spec);
    const run = c.callTool({ name: "summary" }); await started; e.update();
    await stopped; expect((await run).isError).toBe(true);
    await expect(c.callTool({ name: "summary" })).rejects.toThrow();
    expect(e.connectors.entries("thread")).toEqual([]);
  });
});

describe("owned connector credentials", () => {
  it("keeps values out of specs, isolates target changes, rejects undeclared variables and removes only the owner's keys", () => {
    const store = vault(), credentials = new PluginConnectorCredentials(store, {});
    const part = { name: "shop", spec: { type: "http" as const, url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } };
    expect(() => credentials.resolve("g~notes", part)).toThrow("TOKEN");
    expect(() => credentials.save("g~notes", part, { OTHER: "no" })).toThrow("reviewed variables");
    credentials.save("g~notes", part, { TOKEN: "secret" });
    expect(credentials.resolve("g~notes", part)).toHaveProperty("headers.Authorization", "Bearer secret");
    expect(JSON.stringify(part)).not.toContain("secret");
    store.set("global:shop", { env: { TOKEN: "external" } });
    const update = { ...part, spec: { ...part.spec, url: "https://other.invalid/mcp" } };
    expect(() => credentials.resolve("g~notes", update)).toThrow("TOKEN");
    credentials.cleanup("g~notes", [part]); expect(store.has(connectorCredentialKey("g~notes", part))).toBe(true);
    credentials.cleanup("g~notes", []); expect(store.has(connectorCredentialKey("g~notes", part))).toBe(false); expect(store.get("global:shop")?.env?.TOKEN).toBe("external");
    expect(() => credentials.cleanup("", [])).toThrow("Invalid connector owner");
  });
});
