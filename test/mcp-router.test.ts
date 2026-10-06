import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpToolInfo } from "../src/main/mcp/servers";
import { McpClientPool, MCP_ROUTER_INDEX_MAX_NAMES, rankTools, routerIndex, routerTools } from "../src/main/mcp/router";
import type { McpServerEntry, McpServerSpec } from "../src/shared/types";
import { makeTools } from "../scripts/mock-extensions-lib.mjs";
import { tempDir } from "./helpers";

const MANY = join(__dirname, "fixtures", "mock-mcp-many.mjs");
const PIDFILE = join(__dirname, "fixtures", "mock-mcp-pidfile.mjs");
const HANG = join(__dirname, "fixtures", "mock-mcp-hang.mjs");
const SSE = join(__dirname, "fixtures", "mock-mcp-sse.mjs");

/** Start the SSE fixture; resolves with its /sse URL and a stop function. */
async function sseFixture(): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, [SSE], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => {
      const m = /PORT (\d+)/.exec(d.toString());
      if (m) resolve(m[1]!);
    });
    child.on("exit", () => reject(new Error("SSE fixture exited")));
  });
  return { url: `http://127.0.0.1:${port}/sse`, stop: () => child.kill() };
}

interface MockTool {
  name: string;
  description: string;
  inputSchema: { required?: string[]; properties: Record<string, { type: string }> };
  sentinel: string;
}

const mockTools = (server: string, count: number, seed: number): MockTool[] => makeTools(server, count, seed) as MockTool[];

/** Values for a tool's required fields, so the mock server's zod schema accepts the call. */
function requiredArgs(tool: MockTool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of tool.inputSchema.required ?? []) {
    const type = tool.inputSchema.properties[key]?.type;
    out[key] = type === "number" ? 1 : type === "boolean" ? true : "x";
  }
  return out;
}

function readPids(file: string): number[] {
  return readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number);
}

const tool = (server: string, name: string, description = ""): { server: string; tool: McpToolInfo } => ({ server, tool: { name, description, inputSchema: {} } });

describe("rankTools", () => {
  it("puts an exact tool name first even when BM25 prefers another", () => {
    const ranked = rankTools([tool("s", "alpha", "beta beta beta"), tool("s", "beta")], "beta", 5);
    expect(ranked[0]!.tool.name).toBe("beta");
    expect(ranked[0]!.score).toBe(Infinity);
  });

  it("accepts server.tool, server__tool and mcp__server__tool exact forms", () => {
    const entries = [tool("fs", "read")];
    for (const query of ["read", "fs.read", "fs__read", "mcp__fs__read", "FS.READ"]) {
      expect(rankTools(entries, query, 5)[0]!.score).toBe(Infinity);
    }
  });

  it("orders ties deterministically by server and tool name", () => {
    const entries = [tool("s", "b", "gamma"), tool("s", "a", "gamma")];
    const forward = rankTools(entries, "gamma", 5).map((r) => r.tool.name);
    const backward = rankTools([...entries].reverse(), "gamma", 5).map((r) => r.tool.name);
    expect(forward).toEqual(["a", "b"]);
    expect(backward).toEqual(forward);
  });

  it("respects the limit and returns nothing on no match", () => {
    const entries = [tool("s", "a", "gamma"), tool("s", "b", "gamma"), tool("s", "c", "gamma")];
    expect(rankTools(entries, "gamma", 2)).toHaveLength(2);
    expect(rankTools(entries, "zzz", 5)).toEqual([]);
  });
});

describe("routerIndex", () => {
  it("orders servers and their tool names, with per-server counts", () => {
    const text = routerIndex([
      { name: "zeta", tools: ["b", "a"] },
      { name: "alpha", tools: ["only"] },
    ]);
    expect(text).toContain("- alpha (1 tools): only");
    expect(text).toContain("- zeta (2 tools): a, b");
    expect(text.indexOf("- alpha")).toBeLessThan(text.indexOf("- zeta"));
  });

  it("marks a server without a cached listing as not listed yet", () => {
    const text = routerIndex([{ name: "db", tools: null }]);
    expect(text).toContain("- db (not listed yet)");
  });

  it("drops the names but keeps the counts past the name budget", () => {
    const names = Array.from({ length: MCP_ROUTER_INDEX_MAX_NAMES + 1 }, (_, i) => `tool_${i}`);
    const text = routerIndex([{ name: "big", tools: names }]);
    expect(text).toContain(`- big (${MCP_ROUTER_INDEX_MAX_NAMES + 1} tools)`);
    expect(text).not.toContain("tool_0");
  });

  it("returns nothing without servers", () => {
    expect(routerIndex([])).toBe("");
  });
});

describe("McpClientPool", () => {
  it("connects, calls a tool and joins its text content", async () => {
    const pool = new McpClientPool();
    const spec: McpServerSpec = { type: "stdio", command: process.execPath, args: [MANY, "--name", "mock-database", "--tools", "5", "--seed", "1"] };
    const target = mockTools("mock-database", 5, 1)[0]!;
    const r = await pool.callTool(spec, target.name, requiredArgs(target));
    expect(r.ok).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`SENTINEL-mock-database-${target.name}`);
    await pool.closeAll();
  }, 20_000);

  it("reports a server's tools/list_changed through onToolsChanged", async () => {
    const fixture = await sseFixture();
    const changed: McpServerSpec[] = [];
    const pool = new McpClientPool({ onToolsChanged: (spec) => void changed.push(spec) });
    const spec: McpServerSpec = { type: "sse", url: fixture.url };
    try {
      const r = await pool.callTool(spec, "add_tool", {});
      expect(r.text).toBe("Added added_1.");
      for (let i = 0; i < 100 && !changed.length; i++) await new Promise((res) => setTimeout(res, 20));
      expect(changed).toEqual([spec]);
      expect((await pool.callTool(spec, "added_1", {})).text).toBe("added_1 works");
    } finally {
      await pool.closeAll();
      fixture.stop();
    }
  }, 20_000);

  it("shares one connection between concurrent calls", async () => {
    const pidFile = join(tempDir(), "pids");
    const pool = new McpClientPool();
    const spec: McpServerSpec = {
      type: "stdio",
      command: process.execPath,
      args: [PIDFILE, "--name", "mock-database", "--tools", "5", "--seed", "1"],
      env: { PID_FILE: pidFile },
    };
    const target = mockTools("mock-database", 5, 1)[0]!;
    const args = requiredArgs(target);
    const [a, b] = await Promise.all([pool.callTool(spec, target.name, args), pool.callTool(spec, target.name, args)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.text).toContain(`SENTINEL-mock-database-${target.name}`);
    await pool.closeAll();
    expect(new Set(readPids(pidFile)).size).toBe(1);
  }, 20_000);

  it("closeAll leaves no live child", async () => {
    const pidFile = join(tempDir(), "pids");
    const pool = new McpClientPool();
    const spec: McpServerSpec = {
      type: "stdio",
      command: process.execPath,
      args: [PIDFILE, "--name", "mock-database", "--tools", "5", "--seed", "1"],
      env: { PID_FILE: pidFile },
    };
    const target = mockTools("mock-database", 5, 1)[0]!;
    const r = await pool.callTool(spec, target.name, requiredArgs(target));
    expect(r.ok).toBe(true);
    const pid = readPids(pidFile)[0]!;
    await pool.closeAll();
    await new Promise((res) => setTimeout(res, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("times out a hung connect and stops the child", async () => {
    const pidFile = join(tempDir(), "hang");
    const pool = new McpClientPool({ connectTimeoutMs: 1500 });
    const spec: McpServerSpec = { type: "stdio", command: process.execPath, args: [HANG], env: { HANG_PID_FILE: pidFile } };
    const started = Date.now();
    const r = await pool.callTool(spec, "anything", {});
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((res) => setTimeout(res, 500));
    expect(existsSync(pidFile)).toBe(true);
    expect(() => process.kill(readPids(pidFile)[0]!, 0)).toThrow();
    await pool.closeAll();
  }, 20_000);
});

type Listing = { ok: boolean; tools: McpToolInfo[] };

function fakeRouter(
  entries: McpServerEntry[],
  listings: Map<McpServerSpec, Listing>,
  pool: { callTool: (spec: McpServerSpec, name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string; isError: boolean }> },
  projectId?: string,
) {
  const tools = routerTools(
    {
      servers: () => entries,
      listings: { refresh: async () => {}, peek: (spec) => listings.get(spec) ?? null },
      pool,
    },
    projectId,
  );
  return { search: tools.find((t) => t.name === "search_tools")!, call: tools.find((t) => t.name === "call_mcp_tool")! };
}

const DB_SPEC: McpServerSpec = { type: "stdio", command: "db" };
const DB_SCHEMA = { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] };
const dbEntry: McpServerEntry = { name: "db", spec: DB_SPEC, enabled: true };
const dbListing: Listing = {
  ok: true,
  tools: [
    { name: "run_query", description: "run a database query", inputSchema: DB_SCHEMA },
    { name: "list_tables", description: "list database tables", inputSchema: { type: "object", properties: {} } },
  ],
};

describe("routerTools", () => {
  it("search_tools returns matching tools with their input schemas", async () => {
    const { search } = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), { callTool: async () => ({ ok: true, text: "", isError: false }) });
    const out = await search.run({ query: "database query", limit: 5 }, { projectId: "p1" });
    expect(out.isError).toBeUndefined();
    const parsed = JSON.parse(out.text) as { server: string; tool: string; description: string; inputSchema: unknown }[];
    expect(parsed[0]).toEqual({ server: "db", tool: "run_query", description: "run a database query", inputSchema: DB_SCHEMA });
  });

  it("puts the project's server and tool names into the tool descriptions", () => {
    const { search, call } = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), { callTool: async () => ({ ok: true, text: "", isError: false }) }, "p1");
    expect(search.description).toContain("db");
    expect(search.description).toContain("run_query");
    expect(search.description).toContain("list_tables");
    expect(call.description).toContain("Servers: db.");
  });

  it("builds the same description for the same listings", () => {
    const pool = { callTool: async () => ({ ok: true, text: "", isError: false }) };
    const a = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), pool, "p1");
    const b = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), pool, "p1");
    expect(a.search.description).toBe(b.search.description);
    expect(a.call.description).toBe(b.call.description);
  });

  it("search_tools errors when the project has no servers", async () => {
    const { search } = fakeRouter([], new Map(), { callTool: async () => ({ ok: true, text: "", isError: false }) });
    const out = await search.run({ query: "anything" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("No MCP servers");
  });

  it("call_mcp_tool errors on an unknown server, naming the available ones", async () => {
    const { call } = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), { callTool: async () => ({ ok: true, text: "", isError: false }) });
    const out = await call.run({ server: "nope", tool: "run_query" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("nope");
    expect(out.text).toContain("db");
  });

  it("call_mcp_tool says the server didn't answer, not that the tool is unknown, when listing failed", async () => {
    let called = false;
    const listings = new Map<McpServerSpec, Listing>([[DB_SPEC, { ok: false, tools: [], error: "No answer in 15 seconds." } as Listing]]);
    const { call } = fakeRouter([dbEntry], listings, { callTool: async () => ((called = true), { ok: true, text: "", isError: false }) });
    const out = await call.run({ server: "db", tool: "run_query" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe('Couldn\'t reach MCP server "db": No answer in 15 seconds.');
    expect(called).toBe(false);
  });

  it("call_mcp_tool errors on an unknown tool, naming the closest ones", async () => {
    const { call } = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), { callTool: async () => ({ ok: true, text: "", isError: false }) });
    const out = await call.run({ server: "db", tool: "database tables" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("run_query");
    expect(out.text).toContain("list_tables");
  });

  it("call_mcp_tool rejects invalid arguments without calling the server", async () => {
    const calls: unknown[] = [];
    const pool = {
      callTool: async (spec: McpServerSpec, name: string, args: Record<string, unknown>) => {
        calls.push([spec, name, args]);
        return { ok: true, text: "RAN", isError: false };
      },
    };
    const { call } = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), pool);
    const missing = await call.run({ server: "db", tool: "run_query", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.text)).toMatchObject({ status: "validation_error", server: "db", tool: "run_query", expected: DB_SCHEMA });
    const wrongType = await call.run({ server: "db", tool: "run_query", arguments: { sql: 5 } });
    expect(wrongType.isError).toBe(true);
    expect(JSON.parse(wrongType.text).status).toBe("validation_error");
    expect(calls).toHaveLength(0);
  });

  it("call_mcp_tool forwards valid arguments and returns the server's text", async () => {
    const calls: unknown[] = [];
    const pool = {
      callTool: async (spec: McpServerSpec, name: string, args: Record<string, unknown>) => {
        calls.push([spec, name, args]);
        return { ok: true, text: "RAN", isError: false };
      },
    };
    const { call } = fakeRouter([dbEntry], new Map([[DB_SPEC, dbListing]]), pool);
    const out = await call.run({ server: "db", tool: "run_query", arguments: { sql: "select 1" } });
    expect(out.text).toBe("RAN");
    expect(calls).toEqual([[DB_SPEC, "run_query", { sql: "select 1" }]]);
  });
});
