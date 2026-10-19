// What the eval runner gives a CLI engine, as the app does: the scenario's
// memory as CubiQ's memory block, and the trial's browser tools over the MCP
// tool server Codex and OpenCode call. No CLI is spawned here.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HarnessTool } from "../src/main/agents/types";
import { cliWiring, openCodeEvalConfig, readUserOpenCodeConfig } from "../evals/lib/agents";
import { reachesHome } from "../evals/lib/runner";
import { tempDir } from "./helpers";

const tool = (name: string): HarnessTool => ({ name, description: name, input: { url: z.string() }, autoAllow: true, run: async () => ({ text: "ok" }) });

async function listed(server: { url: string; token: string }): Promise<string[]> {
  const client = new Client({ name: "eval-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe("cliWiring", () => {
  it("hands the scenario's memory over as CubiQ's memory block, and none without it", () => {
    const w = cliWiring();
    const memory = w.forTrial({ memory: "- The release codename is HERONFALL.", mcpServers: [] });
    expect(memory()).toContain("<harness-memory>");
    expect(memory()).toContain("HERONFALL");
    expect(w.forTrial({ memory: null, mcpServers: [] })()).toBeNull();
    expect(w.forTrial(undefined)()).toBeNull();
  });

  it("serves the current trial's tools from one server across trials", async () => {
    const w = cliWiring();
    try {
      w.forTrial({ memory: null, mcpServers: [], tools: [tool("browser_open"), tool("browser_snapshot")] });
      const server = await w.toolServer();
      expect(await listed(server)).toEqual(["browser_open", "browser_snapshot"]);
      w.forTrial({ memory: null, mcpServers: [], tools: [tool("browser_click")] });
      expect(await w.toolServer()).toBe(server);
      expect(await listed(server)).toEqual(["browser_click"]);
    } finally {
      w.close();
    }
  });
});

describe("openCodeEvalConfig", () => {
  const user = {
    model: "agentrouter/deepseek-v4-flash",
    small_model: "agentrouter/deepseek-v4-flash",
    default_agent: "orchestrator",
    provider: { agentrouter: { npm: "@ai-sdk/anthropic", options: { baseURL: "http://127.0.0.1:3900" } } },
    agent: { orchestrator: { permission: { bash: "allow" } } },
    plugin: ["file:///x.mjs"],
    mcp: { s: { type: "local" } },
    permission: { bash: "allow" },
  };

  it("keeps only the user's providers and models: no agents, plugins, MCP or permissions", () => {
    expect(openCodeEvalConfig(user)).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: user.provider,
      model: "agentrouter/deepseek-v4-flash",
      small_model: "agentrouter/deepseek-v4-flash",
    });
  });

  it("adds a --provider preset's provider and model over the user's", () => {
    const c = openCodeEvalConfig(user, { model: "eval/m", provider: { eval: { npm: "x" } } });
    expect(c.model).toBe("eval/m");
    expect(Object.keys(c.provider as object)).toEqual(["agentrouter", "eval"]);
    expect(openCodeEvalConfig(null)).toEqual({ $schema: "https://opencode.ai/config.json", provider: {} });
  });

  it("reads the global config from XDG_CONFIG_HOME, jsonc included", () => {
    const home = tempDir();
    mkdirSync(join(home, "opencode"));
    writeFileSync(join(home, "opencode", "opencode.jsonc"), '{\n  // the default\n  "model": "a/b",\n}\n');
    expect(readUserOpenCodeConfig({ XDG_CONFIG_HOME: home })).toEqual({ model: "a/b" });
    expect(readUserOpenCodeConfig({ XDG_CONFIG_HOME: tempDir() })).toBeNull();
  });
});

describe("reachesHome", () => {
  const home = "/Users/u";
  const trial = "/private/var/folders/x/T/eval-t-1";

  it("refuses ~, $HOME and absolute paths under home", () => {
    expect(reachesHome("ls ~/.claude/projects", trial, home)).toBe(true);
    expect(reachesHome("cat $HOME/.config/opencode/opencode.json", trial, home)).toBe(true);
    expect(reachesHome("/Users/u/.config/opencode", trial, home)).toBe(true);
    expect(reachesHome("Users/u/.claude/projects/p/memory/a.md", trial, home)).toBe(true);
  });

  it("allows the trial's own folder and paths outside home", () => {
    expect(reachesHome(`${trial}/project/a.txt`, trial, home)).toBe(false);
    expect(reachesHome("echo hi > out.txt", trial, home)).toBe(false);
    expect(reachesHome("ls /usr/bin", trial, home)).toBe(false);
    expect(reachesHome("git diff HEAD~1", trial, home)).toBe(false);
  });

  it("on Windows the trial sits under home: only paths outside it count", () => {
    const winHome = "C:\\Users\\u";
    const winTrial = "C:\\Users\\u\\AppData\\Local\\Temp\\eval-t-1";
    expect(reachesHome(`${winTrial}\\project\\a.txt`, winTrial, winHome)).toBe(false);
    expect(reachesHome("C:\\Users\\u\\.claude\\projects", winTrial, winHome)).toBe(true);
    expect(reachesHome("type %USERPROFILE%\\.gitconfig", winTrial, winHome)).toBe(true);
  });
});
