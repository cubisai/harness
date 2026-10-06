// A legacy SSE MCP server for tests and live checks: GET /sse opens the stream,
// POST /messages?sessionId= carries requests. `whoami` echoes MOCK_GREETING;
// `add_tool` registers another tool, so the server sends tools/list_changed.
// Usage: node mock-mcp-sse.mjs [--port N] [--key K]  (prints "PORT <n>" once listening;
// with --key, every request must carry `x-key: K`).
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const key = arg("key");
const greeting = process.env.MOCK_GREETING ?? "hello from sse";

function mcpServer() {
  const server = new McpServer({ name: "mock-sse", version: "1.0.0" });
  let added = 0;
  server.registerTool("whoami", { description: "Says who this server is" }, async () => ({ content: [{ type: "text", text: greeting }] }));
  server.registerTool("add_tool", { description: "Adds a tool to this server, which then announces its tool list changed" }, async () => {
    const name = `added_${++added}`;
    server.registerTool(name, { description: `Tool added at runtime (#${added})` }, async () => ({ content: [{ type: "text", text: `${name} works` }] }));
    return { content: [{ type: "text", text: `Added ${name}.` }] };
  });
  return server;
}

const transports = new Map();
const http = createServer(async (req, res) => {
  if (key && req.headers["x-key"] !== key) return void res.writeHead(401).end();
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    await mcpServer().connect(transport);
    return;
  }
  if (req.method === "POST" && url.pathname === "/messages") {
    const transport = transports.get(url.searchParams.get("sessionId") ?? "");
    if (!transport) return void res.writeHead(404).end();
    await transport.handlePostMessage(req, res);
    return;
  }
  // What a Streamable HTTP probe gets from an SSE-only server.
  res.writeHead(405, { Allow: "GET" }).end();
});
http.listen(Number(arg("port") ?? 0), "127.0.0.1", () => console.log(`PORT ${http.address().port}`));
