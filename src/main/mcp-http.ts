import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HarnessTool, ToolOutput } from "./agents/types";

export const TOOL_SERVER_NAME = "unskilled";

export interface ToolServer {
  url: string;
  /** Sent as `Authorization: Bearer <token>`; requests without it are refused. */
  token: string;
  close(): Promise<void>;
}

function toResult(out: ToolOutput) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text: out.text },
  ];
  if (out.imagePng) content.push({ type: "image", data: out.imagePng, mimeType: "image/png" });
  return { content, isError: out.isError };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The harness's own tools (the browser pane's) as a Streamable HTTP MCP
 * server on 127.0.0.1, for agents that take tools over MCP rather than
 * in-process (ACP agents such as deepseek-harness). Stateless: every request
 * gets a fresh server over the current tool list.
 */
export async function startToolServer(tools: () => HarnessTool[]): Promise<ToolServer> {
  const token = randomBytes(24).toString("hex");
  const http = createServer((req, res) => {
    if (!authorized(req, token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless servers have no server-initiated stream to offer.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const server = new McpServer({ name: TOOL_SERVER_NAME, version: "1.0.0" });
    for (const t of tools()) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args: unknown) =>
        toResult(await t.run(args as never)),
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
