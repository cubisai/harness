// What the eval runner gives a CLI engine, as the app does: the scenario's
// memory as CubiQ's memory block, and the trial's browser tools over the MCP
// tool server Codex and OpenCode call. No CLI is spawned here.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HarnessTool } from "../src/main/agents/types";
import { cliWiring } from "../evals/lib/agents";

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
