import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { HarnessTool } from "../src/main/agents/types";
import { summarizeToolInput } from "../src/main/agents/summarize";
import { BROWSER_CALL, BROWSER_TOOLS, withBrowserOnDemand } from "../src/main/browser/on-demand";
import { browserTools } from "../src/main/browser/tools";
import { fetchedUrl } from "../src/renderer/src/turns";

const tool = (name: string, autoAllow: boolean, input: z.ZodRawShape = {}, run = vi.fn(async () => ({ text: `${name} ran` }))): HarnessTool =>
  ({ name, description: `${name} does things`, input, autoAllow, effect: autoAllow ? "read" : "mutate", run }) as unknown as HarnessTool;

const names = (list: HarnessTool[]) => list.map((t) => t.name);

describe("withBrowserOnDemand", () => {
  const open = tool("browser_open", true, { url: z.string() });
  const snapshot = tool("browser_snapshot", true);
  const evalTool = tool("browser_eval", false, { code: z.string() });
  const list = [tool("memory_read", true), open, snapshot, evalTool, tool("shell_start", false)];

  it("puts browser_tools and browser_call where the first browser tool was, and keeps browser_eval, which asks", () => {
    expect(names(withBrowserOnDemand(list))).toEqual(["memory_read", BROWSER_TOOLS, BROWSER_CALL, "browser_eval", "shell_start"]);
  });

  it("makes the pair once, so the definitions never change between turns", () => {
    const a = withBrowserOnDemand(list);
    const b = withBrowserOnDemand([...list]);
    expect(b[1]).toBe(a[1]);
    expect(b[2]).toBe(a[2]);
  });

  it("leaves a list without browser tools as it is", () => {
    const plain = [tool("memory_read", true)];
    expect(withBrowserOnDemand(plain)).toBe(plain);
  });

  it("runs without asking, like the tools it stands in for", () => {
    const [, list2, call] = withBrowserOnDemand(list);
    expect(list2!.autoAllow).toBe(true);
    expect(list2!.effect).toBe("read");
    expect(call!.autoAllow).toBe(true);
    expect(call!.effect).toBe("mutate");
  });

  it("lists the deferred tools with their input schemas, or one by name", async () => {
    const lister = withBrowserOnDemand(list)[1]!;
    const all = JSON.parse((await lister.run({})).text) as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    expect(all.map((t) => t.name)).toEqual(["browser_open", "browser_snapshot"]);
    expect(all[0]!.inputSchema.properties).toHaveProperty("url");
    expect(JSON.parse((await lister.run({ name: "browser_open" })).text)).toHaveLength(1);
    expect(await lister.run({ name: "browser_eval" })).toMatchObject({ isError: true });
  });

  it("runs the named tool with checked arguments and the caller's context", async () => {
    const call = withBrowserOnDemand(list)[2]!;
    const ctx = { threadId: "t1" };
    expect(await call.run({ tool: "browser_open", arguments: { url: "http://localhost:5173" } }, ctx as never)).toEqual({ text: "browser_open ran" });
    expect(open.run).toHaveBeenCalledWith({ url: "http://localhost:5173" }, ctx);
    expect(await call.run({ tool: "browser_snapshot" })).toEqual({ text: "browser_snapshot ran" });
  });

  it("refuses an unknown tool, browser_eval, and bad arguments, with the schema to fix them", async () => {
    const call = withBrowserOnDemand(list)[2]!;
    expect(await call.run({ tool: "browser_eval", arguments: { code: "1" } })).toMatchObject({ isError: true });
    expect(evalTool.run).not.toHaveBeenCalled();
    const bad = await call.run({ tool: "browser_open", arguments: {} });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Invalid arguments for browser_open: url");
    expect(bad.text).toContain('"url"');
  });

  it("with the real browser tools, defers all seven that never ask and saves over 1.2k tokens a request", () => {
    const real = browserTools({} as never, { busy: () => false });
    const after = withBrowserOnDemand(real);
    expect(names(after)).toEqual([BROWSER_TOOLS, BROWSER_CALL, "browser_eval"]);
    const size = (l: HarnessTool[]) => l.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, input: z.toJSONSchema(z.object(t.input), { unrepresentable: "any" }) }).length, 0);
    expect((size(real) - size(after)) / 4).toBeGreaterThan(1200);
  });
});

describe("browser_call rows", () => {
  it("read as the tool they run", () => {
    expect(summarizeToolInput("browser_call", { tool: "browser_open", arguments: { url: "https://example.com" } })).toBe("browser_open · https://example.com");
    expect(summarizeToolInput("cubiq_browser_call", { tool: "browser_snapshot" })).toBe("browser_snapshot");
    expect(withBrowserOnDemand([tool("browser_open", true)])[1]!.summarize?.({ tool: "browser_open", arguments: { url: "https://a.b" } })).toBe("browser_open · https://a.b");
  });

  it("still count as an opened page", () => {
    expect(fetchedUrl({ name: "browser_call", payload: { tool: "browser_open", arguments: { url: "https://a.b/c" } } })).toBe("https://a.b/c");
    expect(fetchedUrl({ name: "cubiq_browser_call", payload: { tool: "browser_snapshot", arguments: {} } })).toBeNull();
    expect(fetchedUrl({ name: "browser_open", payload: { url: "https://a.b/c" } })).toBe("https://a.b/c");
  });
});

describe("the tool server with ?b=1", () => {
  it("serves browser_tools and browser_call in place of the browser tools that never ask, and runs them through the call", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { startToolServer, withBrowserOnDemandFlag } = await import("../src/main/mcp-http");
    const { closeAfter } = await import("./helpers");
    const open = tool("browser_open", true, { url: z.string() }, vi.fn(async () => ({ text: "opened" })));
    const server = await startToolServer(() => [open, tool("browser_eval", false, { code: z.string() }), tool("memory_read", true)]);
    closeAfter(() => void server.close());
    const connect = async (url: string) => {
      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
      return client;
    };
    const plain = await connect(withBrowserOnDemandFlag(server.url, false));
    expect((await plain.listTools()).tools.map((t) => t.name)).toEqual(["browser_open", "browser_eval", "memory_read"]);
    await plain.close();
    const onDemand = await connect(withBrowserOnDemandFlag(server.url, true));
    expect((await onDemand.listTools()).tools.map((t) => t.name)).toEqual([BROWSER_TOOLS, BROWSER_CALL, "browser_eval", "memory_read"]);
    const out = (await onDemand.callTool({ name: BROWSER_CALL, arguments: { tool: "browser_open", arguments: { url: "http://x" } } })) as { content: { text: string }[] };
    expect(out.content[0]!.text).toBe("opened");
    expect(open.run).toHaveBeenCalledWith({ url: "http://x" }, undefined);
    await onDemand.close();
  });
});
