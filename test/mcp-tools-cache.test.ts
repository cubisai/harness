import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listServerTools, McpToolsCache, type McpToolInfo } from "../src/main/mcp/servers";
import type { McpServerEntry, McpServerSpec } from "../src/shared/types";
import { tempDir } from "./helpers";

const MANY = join(__dirname, "fixtures", "mock-mcp-many.mjs");
const HANG = join(__dirname, "fixtures", "mock-mcp-hang.mjs");

const spec: McpServerSpec = { type: "stdio", command: "x" };
const entry = (name: string, enabled = true, s: McpServerSpec = spec): McpServerEntry => ({ name, spec: s, enabled });
const info = (name: string): McpToolInfo => ({ name, description: "", inputSchema: {} });

describe("listServerTools", () => {
  it("lists a stdio server's tools with their schemas", async () => {
    const res = await listServerTools({ type: "stdio", command: process.execPath, args: [MANY, "--name", "mock-database", "--tools", "5", "--seed", "1"] });
    expect(res.ok).toBe(true);
    expect(res.tools).toHaveLength(5);
    for (const t of res.tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTypeOf("object");
    }
  });

  it("times out a hung server and stops its process", async () => {
    const pidFile = join(tempDir(), "pid");
    const res = await listServerTools({ type: "stdio", command: process.execPath, args: [HANG], env: { HANG_PID_FILE: pidFile } }, 1500);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    // Give the kill a moment, then check the pid is really gone.
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf-8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);
});

describe("McpToolsCache", () => {
  it("dedupes concurrent refreshes for the same spec", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cache = new McpToolsCache(async () => {
      calls++;
      await gate;
      return { ok: true, tools: [info("a")] };
    });
    const servers = [entry("a"), entry("b")];
    const first = cache.refresh(servers);
    const second = cache.refresh(servers);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(cache.peek(spec)).toEqual({ ok: true, tools: [info("a")] });
  });

  it("keeps an ok listing for ten minutes and a failure for one", async () => {
    let now = 1_000;
    let ok = true;
    const cache = new McpToolsCache(async () => (ok ? { ok: true, tools: [info("a")] } : { ok: false, tools: [], error: "down" }), () => now);
    await cache.refresh([entry("a")]);
    expect(cache.peek(spec)).toEqual({ ok: true, tools: [info("a")] });
    now += 599_999;
    expect(cache.peek(spec)).not.toBeNull();
    now += 1;
    expect(cache.peek(spec)).toBeNull();
    ok = false;
    await cache.refresh([entry("a")]);
    expect(cache.peek(spec)).toEqual({ ok: false, tools: [], error: "down" });
    now += 59_999;
    expect(cache.peek(spec)).not.toBeNull();
    now += 1;
    expect(cache.peek(spec)).toBeNull();
  });

  it("skips disabled servers", async () => {
    let calls = 0;
    const cache = new McpToolsCache(async () => {
      calls++;
      return { ok: true, tools: [] };
    });
    await cache.refresh([entry("a", false)]);
    expect(calls).toBe(0);
    expect(cache.peek(spec)).toBeNull();
  });
});
