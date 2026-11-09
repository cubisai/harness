import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { harnessToolOptions, TOOL_SERVER } from "../src/main/agents/claude";
import type { HarnessTool } from "../src/main/agents/types";
import { designTools } from "../src/main/design/tools";

/** The names Claude gets from the in-process server. One schema it can't convert fails tools/list, and Claude then sees none of them. */
async function listed(tools: HarnessTool[]): Promise<string[]> {
  const server = (harnessToolOptions(tools).mcpServers?.[TOOL_SERVER] as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return (await client.listTools()).tools.map((t) => t.name);
}

describe("Claude's tool list", () => {
  it("lists every design tool, so one bad schema can't hide the whole cubiq server", async () => {
    const deps = new Proxy({}, { get: () => () => null }) as Parameters<typeof designTools>[0];
    const tools = designTools(deps, "t1");
    expect(await listed(tools)).toEqual(tools.map((t) => t.name));
  });

  it("describes design_tokens_apply's tokens as an object of strings", async () => {
    const server = (harnessToolOptions(designTools(new Proxy({}, { get: () => () => null }) as Parameters<typeof designTools>[0], "t1")).mcpServers?.[TOOL_SERVER] as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const apply = (await client.listTools()).tools.find((t) => t.name === "design_tokens_apply");
    expect((apply?.inputSchema.properties as Record<string, unknown>)["tokens"]).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
  });
});
