import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appLoopTool } from "../src/main/harness/driver";
import { McpClientPool, routerTools } from "../src/main/mcp/router";
import type { McpToolInfo } from "../src/main/mcp/servers";
import type { McpServerEntry, McpServerSpec } from "../src/shared/types";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "fixtures", "mock-mcp-structured.mjs");

const spec: McpServerSpec = { type: "stdio", command: process.execPath, args: [FIXTURE] };

const pool = new McpClientPool();

afterAll(async () => {
  await pool.closeAll();
});

const entry: McpServerEntry = { name: "s", spec, enabled: true };
const stats: McpToolInfo = {
  name: "stats",
  description: "two items",
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object", properties: { count: { type: "number" }, names: { type: "array", items: { type: "string" } } } },
};
const listing = { ok: true, tools: [stats] };

/** The two router tools, as a project with one enabled server ("s") and its cached listing. */
function router() {
  const tools = routerTools({
    servers: () => [entry],
    listings: { refresh: async () => {}, peek: () => listing },
    pool,
  });
  return { search: tools.find((t) => t.name === "search_tools")!, call: tools.find((t) => t.name === "call_mcp_tool")! };
}

describe("MCP structuredContent", () => {
  it("keeps a tool's structured content alongside its text", async () => {
    const r = await pool.callTool(spec, "stats", {});
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ count: 2, names: ["a", "b"] });
    expect(r.text).toBe("2 items");
  }, 20_000);

  it("renders structured content as JSON when the content is empty", async () => {
    const r = await pool.callTool(spec, "bare", {});
    expect(r.text).toBe(JSON.stringify({ ok: true }));
    expect(r.data).toEqual({ ok: true });
  }, 20_000);

  it("renders resource links, inline resources and omitted binary parts", async () => {
    const r = await pool.callTool(spec, "links", {});
    expect(r.text).toContain("[resource_link file:///x.txt (x)]");
    expect(r.text).toContain("inline text");
    expect(r.text).toContain("[image content omitted]");
    expect(r.data).toBeUndefined();
  }, 20_000);

  it("search_tools lists the output schema and call_mcp_tool returns the data", async () => {
    const { search, call } = router();
    const found = await search.run({ query: "stats" }, { projectId: "p1" });
    expect(found.isError).toBeUndefined();
    expect(found.text).toContain('"outputSchema"');
    const out = await call.run({ server: "s", tool: "stats", arguments: {} }, { projectId: "p1" });
    expect(out.isError).toBe(false);
    expect(out.data).toEqual({ count: 2, names: ["a", "b"] });
  }, 20_000);

  it("hands a run_code script the data, and only the script", async () => {
    const { call } = router();
    const loop = appLoopTool(call, { threadId: "t" }, tempDir());
    expect(loop.returns).toBe("unknown");
    const args = { server: "s", tool: "stats", arguments: {} };
    const signal = new AbortController().signal;
    const scripted = await loop.run(args, { id: "c1", signal, onOutput() {}, script: true });
    expect(scripted.data).toEqual({ count: 2, names: ["a", "b"] });
    const plain = await loop.run(args, { id: "c2", signal, onOutput() {} });
    expect("data" in plain).toBe(false);
  }, 20_000);
});
