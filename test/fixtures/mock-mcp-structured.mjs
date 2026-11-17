// A stdio MCP server for structuredContent tests: a schema'd tool, one with no schema, and link/resource/image parts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "structured", version: "1.0.0" });

server.registerTool(
  "stats",
  {
    description: "Two items, with a structured result",
    inputSchema: {},
    outputSchema: { count: z.number(), names: z.array(z.string()) },
  },
  async () => ({
    content: [{ type: "text", text: "2 items" }],
    structuredContent: { count: 2, names: ["a", "b"] },
  }),
);

server.registerTool("bare", { description: "Structured content and no text" }, async () => ({
  content: [],
  structuredContent: { ok: true },
}));

server.registerTool("links", { description: "A link, an inline resource and an image" }, async () => ({
  content: [
    { type: "resource_link", uri: "file:///x.txt", name: "x" },
    { type: "resource", resource: { uri: "mem://a", text: "inline text" } },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ],
}));

await server.connect(new StdioServerTransport());
