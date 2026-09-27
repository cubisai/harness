import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HarnessTool } from "../src/main/agents/types";
import { startToolServer } from "../src/main/mcp-http";
import { closeAfter } from "./helpers";

const echo: HarnessTool = {
  name: "echo",
  description: "Echo text back",
  input: { text: z.string() },
  autoAllow: true,
  run: async (args) => ({ text: `echo: ${(args as { text: string }).text}` }),
};

const skill: HarnessTool = {
  name: "skill",
  description: "Load a skill",
  input: { name: z.string() },
  autoAllow: true,
  run: async () => ({ text: "skill body" }),
};

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

describe("tool server", () => {
  it("serves harness tools over Streamable HTTP MCP", async () => {
    const server = await startToolServer(() => [echo]);
    closeAfter(() => void server.close());
    const client = await connect(server.url, server.token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(res.content).toEqual([{ type: "text", text: "echo: hi" }]);
    await client.close();
  });

  it("gives every tool schema a required array, even when all its parameters are optional", async () => {
    // OpenCode turns a missing `required` into null, which OpenAI-compatible gateways reject.
    const logs: HarnessTool = { ...echo, name: "logs", input: { clear: z.boolean().optional() } };
    const server = await startToolServer(() => [echo, logs]);
    closeAfter(() => void server.close());
    const client = await connect(server.url, server.token);
    const { tools } = await client.listTools();
    expect(Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required]))).toEqual({ echo: ["text"], logs: [] });
    const res = await client.callTool({ name: "logs", arguments: {} });
    expect(res.content).toEqual([{ type: "text", text: "echo: undefined" }]);
    await client.close();
  });

  it("adds the extra tools on /mcp-skills only", async () => {
    const server = await startToolServer(() => [echo], () => [skill]);
    closeAfter(() => void server.close());
    const base = await connect(server.url, server.token);
    expect((await base.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    await base.close();
    expect(server.skillsUrl.endsWith("/mcp-skills")).toBe(true);
    const skills = await connect(server.skillsUrl, server.token);
    expect((await skills.listTools()).tools.map((t) => t.name)).toEqual(["echo", "skill"]);
    await skills.close();
  });

  it("404s any other path", async () => {
    const server = await startToolServer(() => [echo]);
    closeAfter(() => void server.close());
    const res = await fetch(`http://127.0.0.1:${new URL(server.url).port}/other`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("refuses requests without the token", async () => {
    const server = await startToolServer(() => [echo]);
    closeAfter(() => void server.close());
    const res = await fetch(server.url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
  });
});
