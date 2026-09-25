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

describe("tool server", () => {
  it("serves harness tools over Streamable HTTP MCP", async () => {
    const server = await startToolServer(() => [echo]);
    closeAfter(() => void server.close());
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(res.content).toEqual([{ type: "text", text: "echo: hi" }]);
    await client.close();
  });

  it("refuses requests without the token", async () => {
    const server = await startToolServer(() => [echo]);
    closeAfter(() => void server.close());
    const res = await fetch(server.url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
  });
});
