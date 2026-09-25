import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codexServers, readExternalMcp } from "../src/main/mcp/external";
import { forAcp, forClaude, McpServerStore, testServer, viewOf } from "../src/main/mcp/servers";
import { startToolServer } from "../src/main/mcp-http";
import { closeAfter, tempDir } from "./helpers";

const STDIO = join(__dirname, "fixtures", "mock-mcp-stdio.mjs");

describe("McpServerStore", () => {
  it("saves in .mcp.json shape, privately, and never shows values", () => {
    const file = join(tempDir(), "mcp.json");
    const store = new McpServerStore(file);
    store.save({ name: "docs", enabled: true, spec: { type: "stdio", command: " npx ", args: ["-y", "docs-mcp", ""], env: { TOKEN: "secret", " ": "x" } } });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ mcpServers: { docs: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "secret" } } } });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(viewOf(store.list()[0]!)).toEqual({ name: "docs", enabled: true, type: "stdio", target: "npx -y docs-mcp", envKeys: ["TOKEN"], headerKeys: [] });
  });

  it("keeps a stored value when an edit leaves it blank, and renames", () => {
    const store = new McpServerStore(join(tempDir(), "mcp.json"));
    store.save({ name: "api", enabled: true, spec: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer a" } } });
    store.save({ name: "api2", enabled: true, spec: { type: "http", url: "https://mcp.example.com/v2", headers: { Authorization: "" } } }, "api");
    expect(store.list()).toEqual([{ name: "api2", enabled: true, spec: { type: "http", url: "https://mcp.example.com/v2", headers: { Authorization: "Bearer a" } } }]);
  });

  it("disables, removes, and rejects bad input", () => {
    const store = new McpServerStore(join(tempDir(), "mcp.json"));
    store.save({ name: "a", enabled: true, spec: { type: "stdio", command: "a" } });
    store.save({ name: "b", enabled: true, spec: { type: "stdio", command: "b" } });
    store.setEnabled("a", false);
    expect(store.enabled().map((s) => s.name)).toEqual(["b"]);
    store.remove("b");
    expect(store.list().map((s) => [s.name, s.enabled])).toEqual([["a", false]]);
    expect(() => store.save({ name: "unskilled", enabled: true, spec: { type: "stdio", command: "x" } })).toThrow(/app's own/);
    expect(() => store.save({ name: "a b", enabled: true, spec: { type: "stdio", command: "x" } })).toThrow(/letters/);
    expect(() => store.save({ name: "a", enabled: true, spec: { type: "stdio", command: "x" } })).toThrow(/already/);
    expect(() => store.save({ name: "c", enabled: true, spec: { type: "http", url: "ftp://x" } })).toThrow(/http/);
  });

  it("reads Claude Code's .mcp.json entries as they are, and skips junk", () => {
    const file = join(tempDir(), "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { gh: { command: "gh-mcp" }, web: { type: "http", url: "https://x/mcp" }, bad: {}, off: { command: "o", disabled: true } } }));
    expect(new McpServerStore(file).list().map((s) => [s.name, s.spec.type, s.enabled])).toEqual([
      ["gh", "stdio", true],
      ["web", "http", true],
      ["off", "stdio", false],
    ]);
  });
});

describe("MCP formats per agent", () => {
  const servers = [
    { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "d", env: { K: "v" } } },
    { name: "web", enabled: true, spec: { type: "http" as const, url: "https://x/mcp", headers: { A: "b" } } },
  ];
  it("Claude takes them as they are", () => {
    expect(forClaude(servers)).toEqual({ docs: servers[0]!.spec, web: servers[1]!.spec });
  });
  it("ACP gets name/value pairs, and HTTP only when supported", () => {
    expect(forAcp(servers, false)).toEqual([{ name: "docs", command: "d", args: [], env: [{ name: "K", value: "v" }] }]);
    expect(forAcp(servers, true)[1]).toEqual({ type: "http", name: "web", url: "https://x/mcp", headers: [{ name: "A", value: "b" }] });
  });
});

describe("testServer", () => {
  it("lists a stdio server's tools, with its env", async () => {
    const res = await testServer({ type: "stdio", command: process.execPath, args: [STDIO], env: { MOCK_GREETING: "hi there" } });
    expect(res).toEqual({ ok: true, tools: [{ name: "whoami", description: "Says hi there" }] });
  });

  it("lists an HTTP server's tools, sending its headers", async () => {
    const server = await startToolServer(() => [
      { name: "ping", description: "Pong", input: { n: z.number().optional() }, autoAllow: true, run: async () => ({ text: "pong" }) },
    ]);
    closeAfter(() => void server.close());
    expect(await testServer({ type: "http", url: server.url, headers: { Authorization: `Bearer ${server.token}` } })).toMatchObject({ ok: true, tools: [{ name: "ping" }] });
    expect(await testServer({ type: "http", url: server.url })).toMatchObject({ ok: false });
  });

  it("reports a command that doesn't exist", async () => {
    const res = await testServer({ type: "stdio", command: "definitely-not-a-real-mcp-server" }, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("readExternalMcp", () => {
  it("finds what Claude, Codex, Gemini, and OpenCode load themselves, without values", () => {
    const home = tempDir();
    const project = tempDir();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { github: { command: "gh-mcp", args: ["serve"], env: { GITHUB_TOKEN: "secret" } } },
      projects: { [project]: { mcpServers: { local: { type: "http", url: "http://localhost:4000/mcp" } } } },
    }));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { type: "sse", url: "https://s/sse" } } }));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "fs-mcp"]\n[mcp_servers.fs.env]\nTOKEN = "s"\n[mcp_servers."web search"]\nurl = "https://w/mcp"\n');
    mkdirSync(join(home, ".gemini"));
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { g: { httpUrl: "https://g/mcp" } } }));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { o: { type: "local", command: ["bunx", "o-mcp"] } } }));

    const found = readExternalMcp({ home, projectPath: project, env: {} });
    expect(found.map((s) => [s.agent, s.name, s.type, s.target])).toEqual([
      ["Claude", "github", "stdio", "gh-mcp serve"],
      ["Claude", "local", "http", "http://localhost:4000/mcp"],
      ["Claude", "shared", "sse", "https://s/sse"],
      ["Codex", "fs", "stdio", "npx -y fs-mcp"],
      ["Codex", "web search", "http", "https://w/mcp"],
      ["Gemini", "g", "http", "https://g/mcp"],
      ["OpenCode", "o", "stdio", "bunx o-mcp"],
    ]);
    expect(JSON.stringify(found)).not.toContain("secret");
  });

  it("copes with no config at all", () => {
    expect(readExternalMcp({ home: tempDir(), projectPath: null, env: {} })).toEqual([]);
    expect(codexServers("[mcp_servers.x]\nenabled = true")).toEqual([{ name: "x", type: "unknown", target: "" }]);
  });
});
