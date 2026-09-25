// A tiny stdio MCP server for tests: one tool, and it echoes an env var so tests can see env reach it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "mock", version: "1.0.0" });
server.registerTool("whoami", { description: `Says ${process.env.MOCK_GREETING ?? "hello"}` }, async () => ({
  content: [{ type: "text", text: process.env.MOCK_GREETING ?? "hello" }],
}));
await server.connect(new StdioServerTransport());
