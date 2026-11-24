import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppCalls, type AppCallsDeps, type ToolCaller } from "../src/main/apps/calls";
import { AppRegistry, decodeAppKey, encodeAppKey } from "../src/main/apps/registry";
import type { McpToolInfo } from "../src/main/mcp/servers";

function setup(manifest: Record<string, unknown> = {}, rules?: AppCallsDeps["rules"]) {
  const root = mkdtempSync(join(tmpdir(), "apps-"));
  const globalDir = join(root, "apps");
  const projectDir = join(root, "proj");
  const write = (dir: string, m: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    writeFileSync(join(dir, "app.json"), JSON.stringify(m));
  };
  const base = { name: "sales", title: "Sales", description: "Revenue.", grants: [{ server: "posara", tools: ["list_orders", "refund"] }], ...manifest };
  write(join(globalDir, "sales"), base);
  write(join(projectDir, ".cubiq", "apps", "sales"), { ...base, title: "Project sales" });
  write(join(projectDir, ".cubiq", "apps", "stock"), { ...base, name: "stock", title: "Stock" });
  mkdirSync(join(globalDir, "broken"));
  writeFileSync(join(globalDir, "broken", "app.json"), "{");
  const registry = new AppRegistry({ globalDir, projectPath: (id) => (id === "p1" ? projectDir : null) });
  const tools: Record<string, McpToolInfo> = {
    list_orders: { name: "list_orders", description: "", inputSchema: {}, readOnly: true },
    refund: { name: "refund", description: "", inputSchema: {} },
  };
  const sent: { projectId: string | undefined; tool: string; args: unknown }[] = [];
  const call: ToolCaller = vi.fn(async (projectId, _server, tool, args, before) => {
    const refused = await before(tools[tool]!);
    if (refused) return { text: refused, isError: true };
    sent.push({ projectId, tool, args });
    return tool === "list_orders" ? { text: "", isError: false, data: { orders: [{ id: 1 }] } } : { text: '{"refunded":true}', isError: false };
  });
  let now = 1_000;
  const calls = new AppCalls({ registry, call, dataDir: join(root, "app-data"), now: () => now, rules });
  return { registry, calls, call, sent, tick: (ms: number) => (now += ms) };
}

describe("app registry", () => {
  it("keys round-trip and refuse junk", () => {
    expect(decodeAppKey(encodeAppKey({ scope: "project", projectId: "p-1", name: "sales" }))).toEqual({ scope: "project", projectId: "p-1", name: "sales" });
    for (const bad of ["g~", "g~Sales", "x~sales", "p~p1", "g~a~b", "p~../x~sales"]) expect(decodeAppKey(bad), bad).toBeNull();
  });

  it("lists global and project apps, a project app shadowing the global one; a broken app shows its error", () => {
    const { registry } = setup();
    expect(registry.list(null).map((a) => [a.key, a.title, a.error ?? ""])).toEqual([
      ["g~broken", "broken", expect.stringContaining("not valid JSON")],
      ["g~sales", "Sales", ""],
    ]);
    expect(registry.list("p1").map((a) => a.key)).toEqual(["g~broken", "p~p1~sales", "p~p1~stock"]);
    expect(registry.root("g~broken")).toBeNull();
    expect(registry.root("p~p2~sales")).toBeNull();
  });
});

describe("app calls", () => {
  it("forced Ask cannot use a cached read and requires one approval for each exact invocation", async () => {
    let forced = false;
    const { calls, sent } = setup({ cacheSec: 30 }, { decision: () => forced ? "ask" : null, revision: () => "policy" });
    await calls.call("g~sales", "p1", "posara", "list_orders", {});
    forced = true;
    const q = await calls.call("g~sales", "p1", "posara", "list_orders", {});
    expect(q).toMatchObject({ approval: expect.anything() }); expect(sent).toHaveLength(1);
    if (!("approval" in q)) throw new Error("Expected approval");
    expect(await calls.call("g~sales", "p1", "posara", "list_orders", {}, { token: q.approval.token, remember: true })).toMatchObject({ ok: true });
    expect(sent).toHaveLength(2); expect(calls.allowed("g~sales")).toEqual([]);
    expect(await calls.call("g~sales", "p1", "posara", "list_orders", {}, { token: q.approval.token })).toMatchObject({ approval: expect.anything() });
    expect(sent).toHaveLength(2);
  });
  it("forced Ask overrides remembered writes without erasing the remembered store", async () => {
    let forced = false;
    const { calls, sent } = setup({}, { decision: () => forced ? "ask" : null, revision: () => forced ? "on" : "off" });
    const q = await calls.call("g~sales", "p1", "posara", "refund", {});
    if (!("approval" in q)) throw new Error("Expected approval");
    await calls.call("g~sales", "p1", "posara", "refund", {}, { token: q.approval.token, remember: true });
    forced = true;
    expect(await calls.call("g~sales", "p1", "posara", "refund", {})).toMatchObject({ approval: expect.anything() });
    expect(sent).toHaveLength(1); expect(calls.allowed("g~sales")).toEqual(["posara.refund"]);
    forced = false;
    expect(await calls.call("g~sales", "p1", "posara", "refund", {})).toMatchObject({ ok: true });
  });
  it("Allow cannot widen grants, permit a write, or bypass a read-only surface", async () => {
    const { calls, sent } = setup({}, { decision: () => "allow", revision: () => "policy" });
    expect(await calls.call("g~sales", "p1", "posara", "refund", {})).toMatchObject({ approval: expect.anything() });
    expect(await calls.call("g~sales", "p1", "posara", "refund", {}, undefined, { readOnly: true })).toMatchObject({ blocked: "read-only" });
    expect(await calls.call("g~sales", "p1", "posara", "ungranted", {})).toMatchObject({ error: expect.stringContaining("grants") });
    expect(sent).toEqual([]);
  });
  it("binds single-use approvals to project context and active policy revision", async () => {
    let revision = "one";
    const { calls, sent } = setup({}, { decision: () => "ask", revision: () => revision });
    const ask = async () => {
      const q = await calls.call("g~sales", "p1", "posara", "refund", {});
      if (!("approval" in q)) throw new Error("Expected approval");
      return q.approval.token;
    };
    const token = await ask();
    expect(await calls.call("g~sales", null, "posara", "refund", {}, { token })).toMatchObject({ approval: expect.anything() });
    const old = await ask(); revision = "two";
    expect(await calls.call("g~sales", "p1", "posara", "refund", {}, { token: old })).toMatchObject({ approval: expect.anything() });
    expect(sent).toEqual([]);
    const revoked = await ask(); calls.invalidateRules();
    expect(await calls.call("g~sales", "p1", "posara", "refund", {}, { token: revoked })).toMatchObject({ approval: expect.anything() });
  });
  it("drops late results if a rule-owning bundle changes while a connector executes", async () => {
    let revision = "one", started!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; }), waiting = new Promise<void>((resolve) => { finish = resolve; });
    const { calls, call } = setup({ cacheSec: 30 }, { decision: () => null, revision: () => revision });
    vi.mocked(call).mockImplementationOnce(async (_pid, _server, _tool, _args, before) => {
      const refused = await before({ name: "list_orders", description: "", inputSchema: {}, readOnly: true });
      if (refused) return { text: refused, isError: true };
      started(); await waiting; return { text: "late result", isError: false };
    });
    const run = calls.call("g~sales", "p1", "posara", "list_orders", {});
    await entered; revision = "two"; finish();
    expect(await run).toMatchObject({ ok: false, error: expect.stringContaining("rules changed") });
  });
  it.each(["app", "rules"])("cancels the actual connector transport when %s availability changes", async (kind) => {
    const { calls, call } = setup(); let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(call).mockImplementationOnce(async (_pid, _server, _tool, _args, before, signal) => {
      const refused = await before({ name: "list_orders", description: "", inputSchema: {}, readOnly: true });
      if (refused) return { text: refused, isError: true };
      entered();
      expect(signal).toBeInstanceOf(AbortSignal);
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "transport cancelled", isError: true };
    });
    const run = calls.call("g~sales", "p1", "posara", "list_orders", {});
    await started;
    if (kind === "app") calls.invalidate("g~sales"); else calls.invalidateRules();
    expect(await run).toMatchObject({ ok: false });
  });
  it("read-only card/check callers cannot use a token or remembered grant to mutate data", async () => {
    const { calls, sent } = setup();
    const asked = await calls.call("g~sales", "p1", "posara", "refund", {});
    if (!("approval" in asked)) throw new Error("Expected approval");
    await calls.call("g~sales", "p1", "posara", "refund", {}, { token: asked.approval.token, remember: true });
    expect(sent).toHaveLength(1);
    expect(await calls.call("g~sales", "p1", "posara", "refund", {}, undefined, { readOnly: true })).toMatchObject({ ok: false, error: expect.stringContaining("cannot change"), blocked: "read-only" });
    expect(sent).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    expect(await calls.call("g~sales", "p1", "posara", "list_orders", {}, undefined, { signal: controller.signal })).toMatchObject({ ok: false });
    expect(sent).toHaveLength(1);
  });
  it("runs a granted read-only tool at once and returns its structured data", async () => {
    const { calls, sent } = setup();
    expect(await calls.call("p~p1~sales", null, "posara", "list_orders", {})).toEqual({ ok: true, result: { orders: [{ id: 1 }] } });
    expect(sent).toEqual([{ projectId: "p1", tool: "list_orders", args: {} }]);
    // A global app runs against the project it's opened in.
    await calls.call("g~sales", "p1", "posara", "list_orders", {});
    expect(sent[1]!.projectId).toBe("p1");
  });

  it("refuses ungranted tools and uninstalled apps", async () => {
    const { calls, call } = setup();
    expect(await calls.call("g~sales", null, "posara", "delete_all", {})).toMatchObject({ ok: false, error: expect.stringContaining("not in this app's grants") });
    expect(await calls.call("g~sales", null, "other", "list_orders", {})).toMatchObject({ ok: false });
    expect(await calls.call("g~nope", null, "posara", "list_orders", {})).toMatchObject({ ok: false, error: "This app is not installed." });
    expect(call).not.toHaveBeenCalled();
  });

  it("asks before a tool that isn't read-only; the token is single-use and bound to the exact call", async () => {
    const { calls, sent, tick } = setup();
    const q = await calls.call("g~sales", null, "posara", "refund", { id: 1 });
    expect(q).toMatchObject({ ok: false, approval: { server: "posara", tool: "refund", args: '{"id":1}' } });
    expect(sent).toEqual([]);
    const token = (q as { approval: { token: string } }).approval.token;
    // Different arguments: the token doesn't carry over (and is spent).
    expect(await calls.call("g~sales", null, "posara", "refund", { id: 2 }, { token })).toMatchObject({ approval: expect.anything() });
    const q2 = await calls.call("g~sales", null, "posara", "refund", { id: 1 });
    const token2 = (q2 as { approval: { token: string } }).approval.token;
    expect(await calls.call("g~sales", null, "posara", "refund", { id: 1 }, { token: token2 })).toEqual({ ok: true, result: { refunded: true } });
    expect(await calls.call("g~sales", null, "posara", "refund", { id: 1 }, { token: token2 })).toMatchObject({ approval: expect.anything() });
    // Expired tokens don't work.
    const q3 = await calls.call("g~sales", null, "posara", "refund", { id: 1 });
    tick(121_000);
    expect(await calls.call("g~sales", null, "posara", "refund", { id: 1 }, { token: (q3 as { approval: { token: string } }).approval.token })).toMatchObject({ approval: expect.anything() });
  });

  it("'always allow' sticks for that app and tool only", async () => {
    const { calls } = setup();
    const q = (await calls.call("g~sales", null, "posara", "refund", { id: 1 })) as { approval: { token: string } };
    await calls.call("g~sales", null, "posara", "refund", { id: 1 }, { token: q.approval.token, remember: true });
    expect(await calls.call("g~sales", null, "posara", "refund", { id: 9 })).toMatchObject({ ok: true });
    expect(await calls.call("p~p1~sales", null, "posara", "refund", { id: 9 })).toMatchObject({ approval: expect.anything() });
    calls.forget("g~sales");
    expect(await calls.call("g~sales", null, "posara", "refund", { id: 9 })).toMatchObject({ approval: expect.anything() });
  });

  it("reuses read-only results within cacheSec, never writes", async () => {
    const { calls, sent, tick } = setup({ cacheSec: 30 });
    await calls.call("g~sales", null, "posara", "list_orders", { day: 1 });
    await calls.call("g~sales", null, "posara", "list_orders", { day: 1 });
    expect(sent).toHaveLength(1);
    tick(31_000);
    await calls.call("g~sales", null, "posara", "list_orders", { day: 1 });
    expect(sent).toHaveLength(2);
  });

  it("keeps a small per-app store", () => {
    const { calls } = setup();
    expect(calls.storeSet("g~sales", "range", { days: 7 })).toEqual({ ok: true, result: null });
    expect(calls.storeGet("g~sales", "range")).toEqual({ days: 7 });
    expect(calls.storeGet("p~p1~sales", "range")).toBeNull();
    expect(calls.storeSet("g~sales", "big", "x".repeat(1024 * 1024 + 1))).toMatchObject({ ok: false });
    calls.storeSet("g~sales", "range", null);
    expect(calls.storeGet("g~sales", "range")).toBeNull();
  });
});
