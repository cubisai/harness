// A stdio MCP server like mock-mcp-many.mjs, but it also appends its own pid
// to PID_FILE, so the pool tests can prove one connection per server and that
// a closed child is really gone. Test-only; never touches src/.
//   node mock-mcp-pidfile.mjs --name <server> --tools <M> --seed <S>
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeTools } from "../../scripts/mock-extensions-lib.mjs";

if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `${process.pid}\n`);

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = value("--name") ?? "mock";
const tools = Number(value("--tools") ?? 10);
const seed = Number(value("--seed") ?? 1);

const server = new McpServer({ name, version: "1.0.0" });

for (const tool of makeTools(name, tools, seed)) {
  const shape = {};
  for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
    const field = prop.type === "number" ? z.number() : prop.type === "boolean" ? z.boolean() : z.string();
    shape[key] = tool.inputSchema.required.includes(key) ? field.describe(prop.description) : field.describe(prop.description).optional();
  }
  server.registerTool(tool.name, { description: tool.description, inputSchema: shape }, async (received) => ({
    content: [{ type: "text", text: `${tool.sentinel} ${JSON.stringify(received)}` }],
  }));
}

await server.connect(new StdioServerTransport());
