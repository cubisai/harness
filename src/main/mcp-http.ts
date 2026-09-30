import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HarnessTool, ToolOutput } from "./agents/types";

export const TOOL_SERVER_NAME = "cubiq";

export interface ToolServer {
  url: string;
  /** The same tools plus the extra set (the skill tool), on `/mcp-skills`. */
  skillsUrl: string;
  /** The same tools, the extra set and the routed set (search_tools/call_mcp_tool), on `/mcp-routed`. */
  routedUrl: string;
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

type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools: { inputSchema?: Record<string, unknown> }[] }>;

/**
 * A tool whose parameters are all optional gets an input schema with no
 * `required` key. That is valid JSON Schema, but OpenCode forwards it as
 * `required: null`, and OpenAI-compatible gateways (AgentRouter's DeepSeek)
 * then reject the whole request: "Invalid schema for function
 * 'cubiq_browser_logs': null is not of type 'array'". Wrap the SDK's
 * tools/list handler so every schema carries an array. The handler map is
 * private to the pinned SDK; mcp-http.test.ts fails if that ever changes.
 */
function withRequiredArrays(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, ListHandler> })._requestHandlers;
  const list = handlers.get("tools/list");
  if (!list) return;
  handlers.set("tools/list", async (request, extra) => {
    const result = await list(request, extra);
    for (const tool of result.tools) {
      if (tool.inputSchema && !Array.isArray(tool.inputSchema.required)) tool.inputSchema.required = [];
    }
    return result;
  });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A tool-server URL that tells the tools which project is calling (`?p=`), or the URL unchanged without one. */
export function withProject(url: string, projectId: string | undefined): string {
  if (!projectId) return url;
  const u = new URL(url);
  u.searchParams.set("p", projectId);
  return u.toString();
}

/**
 * The harness's own tools (the browser pane's) as a Streamable HTTP MCP
 * server on 127.0.0.1, for agents that take tools over MCP rather than
 * in-process (ACP agents such as OpenCode). `/mcp` serves `tools`;
 * `/mcp-skills` serves those plus `extra` (the skill tool); `/mcp-routed`
 * serves those plus `routed` (the MCP search/call router tools), built for
 * the project the `?p=<projectId>` names. Stateless: every request gets a
 * fresh server over the current tool list. A `?p=<projectId>` on the URL
 * tells the tools (and the routed factory) which project is calling them.
 */
export async function startToolServer(
  tools: () => HarnessTool[],
  extra?: () => HarnessTool[],
  routed?: (projectId: string | undefined) => HarnessTool[],
): Promise<ToolServer> {
  const token = randomBytes(24).toString("hex");
  const http = createServer((req, res) => {
    if (!authorized(req, token)) {
      res.writeHead(401).end();
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp" && path !== "/mcp-skills" && path !== "/mcp-routed") {
      res.writeHead(404).end();
      return;
    }
    const projectId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("p") ?? undefined;
    if (req.method !== "POST") {
      // Stateless servers have no server-initiated stream to offer.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const server = new McpServer({ name: TOOL_SERVER_NAME, version: "1.0.0" });
    const list =
      path === "/mcp-skills"
        ? [...tools(), ...(extra?.() ?? [])]
        : path === "/mcp-routed"
          ? [...tools(), ...(extra?.() ?? []), ...(routed?.(projectId) ?? [])]
          : tools();
    for (const t of list) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args: unknown) =>
        toResult(await t.run(args as never, projectId ? { projectId } : undefined)),
      );
    }
    withRequiredArrays(server);
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
    skillsUrl: `http://127.0.0.1:${port}/mcp-skills`,
    routedUrl: `http://127.0.0.1:${port}/mcp-routed`,
    token,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
