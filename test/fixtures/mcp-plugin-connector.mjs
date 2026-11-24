import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "local-plugin-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "summary", description: "Fixture summary", inputSchema: { type: "object", properties: { day: { type: "number" } } }, annotations: { readOnlyHint: true } },
  { name: "save", description: "Fixture write", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, args: request.params.arguments, configured: process.env.FIXTURE_KEY === "fixture-secret" }) }], structuredContent: { total: 42 } }));
await server.connect(new StdioServerTransport());
