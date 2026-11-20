import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateApp, type AppManifest } from "../src/main/apps/manifest";
import { parsePluginInput, pluginInputShape } from "../src/main/apps/tool-schema";
import { PluginTools, type PluginToolsDeps } from "../src/main/apps/tools";
import type { CheckWindow } from "../src/main/apps/check";
import type { AppInfo, ThreadEvent } from "../src/shared/types";
import { pluginToolName } from "../src/main/apps/tool-name";
import { carriesThreadOwnTools } from "../src/main/shell-tools";

const input = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "notes", title: "Notes", description: "My notes", entry: "index.html", tools: [{ name: "add", description: "Save a note", inputSchema: input }], toolEntry: "tools.html", cards: [{ name: "saved", entry: "card.html", height: 120 }], ...extra });
const files = (extra: Record<string, unknown> = {}) => [{ path: "app.json", content: manifest(extra) }, ...["index.html", "tools.html", "card.html"].map((path) => ({ path, content: "<p>notes</p>" }))];

describe("plugin manifest and input schemas", () => {
  it("reads local handlers and cards, and exposes a bounded strict schema", () => {
    const r = validateApp("notes", files());
    expect(r.ok && r.manifest).toMatchObject({ toolEntry: "tools.html", tools: [{ name: "add" }], cards: [{ height: 120 }] });
    const schema = z.object(pluginInputShape(parsePluginInput(input))).strict();
    expect(schema.parse({ title: "A" })).toEqual({ title: "A" });
    expect(schema.safeParse({ title: "A", extra: 1 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(pluginToolName("my-notes", "add_item")).toBe("plugin_my_notes__add_item");
    expect(carriesThreadOwnTools([{ name: "plugin_my_notes__add_item" }])).toBe(true);
  });

  it("supports nested typed arrays, optional fields and string enums, not arbitrary schema code", () => {
    const parsed = parsePluginInput({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { on: { type: "boolean" }, count: { type: "integer" }, ratio: { type: "number" }, mode: { type: "string", enum: ["one", "two"] } }, required: ["mode"] } } } });
    const schema = z.object(pluginInputShape(parsed)).strict();
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ items: [{ mode: "one", count: 1, ratio: .5, on: true }] }).success).toBe(true);
    expect(schema.safeParse({ items: [{ mode: "three" }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ mode: "one", count: 1.5 }] }).success).toBe(false);
    for (const bad of [{ type: "object", $ref: "file:///secret" }, { type: "object", additionalProperties: true }, { type: "string" }, { type: "object", required: ["missing"] }, { type: "object", properties: { constructor: { type: "string" } } }]) expect(() => parsePluginInput(bad)).toThrow();
  });

  it("keeps engine tool names bounded and avoids app/tool separator collisions", () => {
    expect(pluginToolName("a--b", "c")).not.toBe(pluginToolName("a", "b__c"));
    const names = [pluginToolName("a".repeat(64), "b".repeat(32)), pluginToolName("a--b", "c")];
    for (const name of names) {
      expect(`mcp__cubiq__${name}`.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^plugin__[a-f0-9]{44}$/);
    }
    expect(pluginToolName("a".repeat(64), "b".repeat(32))).not.toBe(pluginToolName("a".repeat(63) + "b", "b".repeat(32)));
  });

  it("refuses duplicate parts, unknown fields, nonlocal entries, overlong lists, depth and width", () => {
    const errors = (extra: Record<string, unknown>) => { const r = validateApp("notes", files(extra)); return r.ok ? "" : r.errors.join(" "); };
    expect(errors({ toolEntry: "https://example.com/run.html" })).toContain("toolEntry");
    expect(errors({ tools: [{ name: "add", description: "x", inputSchema: input, readOnly: true }] })).toContain("tools");
    expect(errors({ tools: Array(17).fill({ name: "add", description: "x", inputSchema: input }) })).toContain("16 tools");
    expect(errors({ tools: Array(2).fill({ name: "add", description: "x", inputSchema: input }) })).toContain("unique name");
    expect(errors({ cards: [{ name: "saved", entry: "../outside.html" }] })).toContain("local HTML");
    expect(errors({ cards: [{ name: "saved", entry: "card.html", height: 601 }] })).toContain("80-600");
    expect(errors({ cards: Array(2).fill({ name: "saved", entry: "card.html" }) })).toContain("unique name");
    expect(errors({ cards: Array(9).fill({ name: "saved", entry: "card.html" }) })).toContain("8 cards");
    expect(() => parsePluginInput({ type: "object", properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: "string" }])) })).toThrow("64 fields");
    let deep: unknown = { type: "string" };
    for (let i = 0; i < 6; i++) deep = { type: "object", properties: { next: deep } };
    expect(() => parsePluginInput(deep)).toThrow("four nested");
  });

  it("the tool template is a valid ordinary app", () => {
    const dir = "resources/creator/templates/tool";
    const paths = ["app.json", "index.html", "tools.html", "card.html", "app.js", "tools.js", "style.css"];
    expect(validateApp("reading-list-tools", paths.map((path) => ({ path, content: readFileSync(join(dir, path), "utf8") }))).ok).toBe(true);
    expect(readFileSync(join(dir, "card.html"), "utf8")).toContain('<h1 id="title">');
  });
});

function setup(options: { deny?: boolean; noHandler?: boolean; result?: unknown; messages?: Record<string, unknown>[]; startup?: Record<string, unknown>[]; onInvoke?: () => void } = {}) {
  const checked = validateApp("notes", files());
  if (!checked.ok) throw new Error(checked.errors.join());
  let current: AppManifest | null = checked.manifest;
  const app: AppInfo = { key: "g~notes", name: "notes", scope: "global", title: "Notes", description: "", path: "", url: "", grants: [] };
  const turn = new AbortController();
  const emitted: ThreadEvent[] = [];
  const replies: { id: number; body: unknown }[] = [];
  let tick = 0;
  let queue: unknown[] = [];
  const destroy = vi.fn();
  const win: CheckWindow = {
    load: vi.fn(async () => {}),
    evaluate: vi.fn(async (script) => new Function("window", `return ${script}`)({ __cq: {
      start: () => { queue.push(...(options.startup ?? []), ...(options.noHandler ? [] : [{ op: "tool-register", name: "add" }])); },
      drain: () => { const out = queue; queue = []; return { queue: out, loaded: true, ready: true }; },
      invoke: () => { options.onInvoke?.(); queue.push(...(options.messages ?? [])); if (options.result !== "pending") queue.push({ op: "tool-result", id: "invoke", ok: true, result: options.result ?? { text: "Saved", data: { n: 1 }, card: { name: "saved", data: { title: "A" } } } }); },
      reply: (id: number, body: unknown) => { replies.push({ id, body }); },
    } })),
    evaluateApp: async () => null,
    capture: async () => Buffer.alloc(0),
    destroy,
  };
  const deps: PluginToolsDeps = {
    registry: { list: () => current ? [app] : [], manifest: () => current },
    calls: { call: vi.fn(async () => ({ ok: true as const, result: "data" })), storeGet: vi.fn(() => null), storeSet: vi.fn(() => ({ ok: true as const, result: null })) },
    createWindow: vi.fn(() => win), signal: () => turn.signal,
    approve: vi.fn(async () => !options.deny), emit: (_tid, event) => emitted.push(event), now: () => tick, sleep: async () => { tick += 1000; },
  };
  const runtime = new PluginTools(deps);
  const tool = runtime.tools("t1", "project-a")[0]!;
  return { deps, runtime, tool, turn, emitted, replies, win, destroy, change: (m: AppManifest | null) => { current = m; }, manifest: checked.manifest };
}

describe("plugin tool runtime", () => {
  it("passes exact forced Ask to main instead of permitting a Full-access shortcut", async () => {
    const s = setup();
    s.deps.forceAsk = vi.fn((name) => name === "plugin_notes__add");
    s.deps.approve = vi.fn(async (_tid, _title, _summary, _signal, _connector, forced) => !forced); // Full access, but the user declines forced Ask.
    expect((await s.tool.run({ title: "A" })).text).toContain("declined");
    expect(s.deps.forceAsk).toHaveBeenCalledWith("plugin_notes__add", { title: "A" }, "t1");
    expect(s.deps.approve).toHaveBeenCalledWith("t1", "Notes", expect.any(String), expect.any(AbortSignal), false, true);
    expect(s.deps.createWindow).not.toHaveBeenCalled();
  });
  it("rejects both pending approvals and queued calls after a rule revision changes", async () => {
    const s = setup(); let revision = "one", entered!: () => void, approve!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), waiting = new Promise<void>((resolve) => { approve = resolve; });
    s.deps.rulesRevision = () => revision;
    s.deps.approve = vi.fn(async () => { entered(); await waiting; return true; });
    const first = s.tool.run({ title: "A" }), queued = s.tool.run({ title: "B" });
    await started; revision = "two"; s.runtime.invalidateRules(); approve();
    expect((await first).isError).toBe(true); expect((await queued).isError).toBe(true);
    expect(s.deps.approve).toHaveBeenCalledTimes(1); expect(s.deps.createWindow).not.toHaveBeenCalled();
    expect(s.emitted).toEqual([]);
  });
  it("drops cards and active handler results when their rule-owning bundle is turned Off", async () => {
    let revoke!: () => void, revision = "one";
    const s = setup({ onInvoke: () => revoke() });
    s.deps.rulesRevision = () => revision;
    revoke = () => { revision = "off"; s.runtime.invalidateRules(); };
    expect((await s.tool.run({ title: "A" })).isError).toBe(true);
    expect(s.emitted).toEqual([]); expect(s.destroy).toHaveBeenCalled();
  });
  it("runs in a fresh frame only after approval, persists only declared cards and destroys it", async () => {
    const s = setup({ messages: [{ op: "store.set", id: 1, key: "items", value: ["A"] }] });
    expect(s.deps.createWindow).not.toHaveBeenCalled();
    const out = await s.tool.run({ title: "A" }, { threadId: "t1" });
    expect(out).toEqual({ text: "Saved", data: { n: 1 } });
    expect(s.deps.approve).toHaveBeenCalledWith("t1", "Notes", expect.stringContaining('"title":"A"'), expect.any(AbortSignal), false);
    expect(s.deps.calls.storeSet).toHaveBeenCalledWith("g~notes", "items", ["A"]);
    expect(s.emitted).toEqual([{ kind: "plugin-card", key: "g~notes", card: "saved", data: { title: "A" } }]);
    expect(s.destroy).toHaveBeenCalled();
    await s.tool.run({ title: "B" });
    expect(s.deps.createWindow).toHaveBeenCalledTimes(2);
  });

  it("fails closed for missing/cross-thread/aborted turns, malformed input, denial and changed descriptors", async () => {
    const s = setup({ deny: true });
    expect((await s.tool.run({ title: "A" }, { threadId: "other" })).isError).toBe(true);
    expect((await s.tool.run({ extra: 1 })).text).toContain("Invalid");
    expect((await s.tool.run({ title: "A" })).text).toContain("declined");
    expect(s.deps.createWindow).not.toHaveBeenCalled();
    s.change({ ...s.manifest, tools: [{ ...s.manifest.tools![0]!, description: "Changed" }] });
    expect((await s.tool.run({ title: "A" })).text).toContain("changed");
    s.change(null);
    expect(s.runtime.tools("new", null)).toEqual([]);
    expect((await s.tool.run({ title: "A" })).isError).toBe(true);
    s.turn.abort();
    expect((await s.tool.run({ title: "A" })).text).toContain("No running turn");
  });

  it("refuses startup effects and keeps connector context bound to the originating thread", async () => {
    const s = setup({ startup: [{ op: "store.set", id: 1, key: "bad", value: 1 }, { op: "call", id: 2, server: "shop", tool: "read", args: {} }], messages: [{ op: "call", id: 3, server: "shop", tool: "read", args: { days: 1 } }] });
    await s.tool.run({ title: "A" }, { projectId: "other-project" });
    expect(s.deps.calls.storeSet).not.toHaveBeenCalled();
    expect(s.deps.calls.call).toHaveBeenCalledTimes(1);
    expect(s.deps.calls.call).toHaveBeenCalledWith("g~notes", "project-a", "shop", "read", { days: 1 }, undefined, { signal: expect.any(AbortSignal) });
    expect(s.replies.filter((r) => r.id < 3)).toEqual([{ id: 1, body: { ok: false, error: expect.stringContaining("inside an invoked") } }, { id: 2, body: { ok: false, error: expect.stringContaining("inside an invoked") } }]);
  });

  it("gets a separate connector write approval and uses only its returned single-use token", async () => {
    const s = setup({ messages: [{ op: "call", id: 1, server: "shop", tool: "write", args: { n: 1 } }] });
    const call = vi.fn().mockResolvedValueOnce({ ok: false, approval: { token: "one-token", server: "shop", tool: "write", args: '{"n":1}' } }).mockResolvedValue({ ok: true, result: "done" });
    s.deps.calls.call = call;
    await s.tool.run({ title: "A" });
    expect(s.deps.approve).toHaveBeenCalledTimes(2);
    expect(s.deps.approve).toHaveBeenLastCalledWith("t1", "Notes", expect.stringContaining("shop.write"), expect.any(AbortSignal), true);
    expect(call.mock.calls[1]![5]).toEqual({ token: "one-token" });
  });

  it("does not retry a denied connector write", async () => {
    const s = setup({ messages: [{ op: "call", id: 1, server: "shop", tool: "write", args: {} }] });
    s.deps.calls.call = vi.fn(async () => ({ ok: false as const, approval: { token: "token", server: "shop", tool: "write", args: "{}" } }));
    s.deps.approve = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await s.tool.run({ title: "A" });
    expect(s.deps.calls.call).toHaveBeenCalledTimes(1);
    expect(s.replies).toContainEqual({ id: 1, body: { ok: false, error: expect.stringContaining("declined") } });
  });

  it("cancels active and queued calls on update/Off, and emits no stale card", async () => {
    let invalidate!: () => void;
    const s = setup({ result: "pending", onInvoke: () => invalidate() });
    invalidate = () => s.runtime.invalidate("g~notes");
    const first = s.tool.run({ title: "A" });
    const second = s.tool.run({ title: "B" });
    expect((await first).isError).toBe(true);
    expect((await second).isError).toBe(true);
    expect(s.emitted).toEqual([]);
    expect(s.deps.createWindow).toHaveBeenCalledTimes(1);
    expect(s.destroy).toHaveBeenCalled();
    s.runtime.dispose();
    expect((await s.tool.run({ title: "C" })).isError).toBe(true);
  });

  it("cancels a stalled host load immediately and releases the queue", async () => {
    const s = setup();
    let started!: () => void;
    const loading = new Promise<void>((resolve) => { started = resolve; });
    s.win.load = vi.fn(() => { started(); return new Promise<void>(() => {}); });
    const run = s.tool.run({ title: "A" });
    await loading;
    s.runtime.invalidate("g~notes");
    expect((await run).text).toContain("stopped");
    expect(s.destroy).toHaveBeenCalled();
    expect(s.emitted).toEqual([]);
    s.win.load = vi.fn(async () => {});
    expect((await s.tool.run({ title: "B" })).isError).toBeUndefined();
  });

  it("reports a missing handler and bounds tool input, results and card data", async () => {
    const s = setup({ noHandler: true });
    expect((await s.tool.run({ title: "A" })).text).toContain("did not register");
    expect(s.destroy).toHaveBeenCalled();
    expect((await setup().tool.run({ title: "x".repeat(32 * 1024) })).text).toContain("32 KB");
    for (const result of [{ text: "x".repeat(256 * 1024) }, { text: "x", card: { name: "other" } }, { text: "x", card: { name: "saved", data: "x".repeat(64 * 1024) } }, { text: "x", html: "<script>" }]) {
      const r = setup({ result });
      expect((await r.tool.run({ title: "A" })).isError).toBe(true);
      expect(r.emitted).toEqual([]);
    }
  });
});
