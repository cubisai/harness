import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HarnessTool, ToolContext } from "../src/main/agents/types";
import { startToolServer, withProject, withThread } from "../src/main/mcp-http";
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

  it("builds the extra tools for the project ?p= names", async () => {
    const seen: (string | undefined)[] = [];
    const server = await startToolServer(() => [echo], (pid) => {
      seen.push(pid);
      return [{ ...skill, name: `skill_${pid ?? "none"}` }];
    });
    closeAfter(() => void server.close());
    const plain = await connect(server.skillsUrl, server.token);
    expect((await plain.listTools()).tools.map((t) => t.name)).toEqual(["echo", "skill_none"]);
    await plain.close();
    const scoped = await connect(withProject(server.skillsUrl, "p7"), server.token);
    expect((await scoped.listTools()).tools.map((t) => t.name)).toEqual(["echo", "skill_p7"]);
    await scoped.close();
    expect(seen).toContain("p7");
  });

  it("adds the routed tools on /mcp-routed only", async () => {
    const routed: HarnessTool = { ...skill, name: "search_tools", description: "Search MCP tools" };
    const server = await startToolServer(() => [echo], () => [skill], () => [routed]);
    closeAfter(() => void server.close());
    expect(server.routedUrl.endsWith("/mcp-routed")).toBe(true);
    // /mcp and /mcp-skills keep serving what they did before: no router tools.
    const base = await connect(server.url, server.token);
    expect((await base.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    await base.close();
    const skills = await connect(server.skillsUrl, server.token);
    expect((await skills.listTools()).tools.map((t) => t.name)).toEqual(["echo", "skill"]);
    await skills.close();
    const all = await connect(server.routedUrl, server.token);
    expect((await all.listTools()).tools.map((t) => t.name)).toEqual(["echo", "skill", "search_tools"]);
    await all.close();
  });

  it("tells the routed tool factory which project is calling, from the URL's ?p=", async () => {
    const seen: (string | undefined)[] = [];
    const server = await startToolServer(
      () => [echo],
      () => [skill],
      (pid) => {
        seen.push(pid);
        return [{ ...skill, name: "search_tools", description: "Search MCP tools" }];
      },
    );
    closeAfter(() => void server.close());
    const withP = await connect(withProject(server.routedUrl, "p2"), server.token);
    await withP.listTools();
    await withP.close();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((pid) => pid === "p2")).toBe(true);
    const plain = await connect(server.routedUrl, server.token);
    await plain.listTools();
    await plain.close();
    expect(seen).toContain(undefined);
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

  it("withProject adds ?p= only when there is a project", () => {
    const url = "http://127.0.0.1:5/mcp";
    expect(withProject(url, undefined)).toBe(url);
    expect(new URL(withProject(url, "p1")).searchParams.get("p")).toBe("p1");
  });

  it("tells a tool which project is calling, from the URL's ?p=", async () => {
    const seen: (ToolContext | undefined)[] = [];
    const ctxTool: HarnessTool = {
      name: "ctx",
      description: "Records the caller context",
      input: {},
      autoAllow: true,
      run: async (_args, ctx) => {
        seen.push(ctx);
        return { text: "ok" };
      },
    };
    const server = await startToolServer(() => [ctxTool]);
    closeAfter(() => void server.close());
    const withP = await connect(withProject(server.url, "p1"), server.token);
    await withP.callTool({ name: "ctx", arguments: {} });
    await withP.close();
    const plain = await connect(server.url, server.token);
    await plain.callTool({ name: "ctx", arguments: {} });
    await plain.close();
    expect(seen).toEqual([{ projectId: "p1" }, undefined]);
  });

  it("keeps a thread tool's call alive past the client's timeout with a progress heartbeat", async () => {
    // OpenCode times an MCP call out after 60s but resets on progress; ask_user waits on a person.
    const wait: HarnessTool = { ...echo, name: "wait", input: {}, run: () => new Promise((r) => setTimeout(() => r({ text: "answered" }), 300)) };
    const server = await startToolServer(() => [echo], undefined, undefined, () => [wait], 40);
    closeAfter(() => void server.close());
    const client = await connect(withThread(server.url, "t1"), server.token);
    let beats = 0;
    const res = await client.callTool({ name: "wait", arguments: {} }, undefined, {
      timeout: 150,
      resetTimeoutOnProgress: true,
      onprogress: () => void (beats += 1),
    });
    expect(res.content).toEqual([{ type: "text", text: "answered" }]);
    expect(beats).toBeGreaterThan(2);
    // Other tools still answer as plain JSON, with no heartbeat.
    expect((await client.callTool({ name: "echo", arguments: { text: "hi" } })).content).toEqual([{ type: "text", text: "echo: hi" }]);
    await client.close();
  });

  it("400s a body that isn't JSON", async () => {
    const server = await startToolServer(() => [echo]);
    closeAfter(() => void server.close());
    const res = await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}` }, body: "{" });
    expect(res.status).toBe(400);
  });
});
