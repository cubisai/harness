import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HarnessTool, ToolOutput } from "./agents/types";
import { parseGatewayPath } from "./mcp/gateway";

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

/**
 * MCP clients time a tool call out (OpenCode: 60s) unless progress arrives, and
 * OpenCode resets that clock on progress. A thread tool waits on the user
 * (ask_user), so while it runs the server sends a progress heartbeat.
 */
export const HEARTBEAT_MS = 15_000;

function heartbeat(extra: RequestHandlerExtra<ServerRequest, ServerNotification>, ms: number): () => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress } }).catch(() => {});
  }, ms);
  return () => clearInterval(timer);
}

/** Whether a JSON-RPC body (or batch) calls one of the named tools. */
function callsAny(body: unknown, names: Set<string>): boolean {
  return (Array.isArray(body) ? body : [body]).some((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown } } | null;
    return msg?.method === "tools/call" && typeof msg.params?.name === "string" && names.has(msg.params.name);
  });
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false };
  }
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

/** A tool-server URL that also names the calling thread (`?t=`), which serves the thread tools (ask_user). */
export function withThread(url: string, threadId: string | undefined): string {
  if (!threadId) return url;
  const u = new URL(url);
  u.searchParams.set("t", threadId);
  return u.toString();
}

/** A tool-server URL that names a design thread (`?d=`) without naming the caller, which adds its design tools. */
export function withDesign(url: string, threadId: string | undefined): string {
  if (!threadId) return url;
  const u = new URL(url);
  u.searchParams.set("d", threadId);
  return u.toString();
}

/** A tool-server URL that adds code mode's run_code for a thread (`?c=`), without naming it as the caller. */
export function withCode(url: string, threadId: string | undefined): string {
  if (!threadId) return url;
  const u = new URL(url);
  u.searchParams.set("c", threadId);
  return u.toString();
}

/**
 * The harness's own tools (the browser pane's) as a Streamable HTTP MCP
 * server on 127.0.0.1, for agents that take tools over MCP rather than
 * in-process (ACP agents such as OpenCode). `/mcp` serves `tools`;
 * `/mcp-skills` serves those plus `extra` (the skill tool); `/mcp-routed`
 * serves those plus `routed` (the MCP search/call router tools), built for
 * the project the `?p=<projectId>` names (so is the skill tool's list, which a
 * design thread's `?t=` widens to its design-only skills). Stateless: every request gets a
 * fresh server over the current tool list. A `?p=<projectId>` on the URL
 * tells the tools (and the routed factory) which project is calling them; a
 * `?t=<threadId>` adds `threadTools` (ask_user), which act for that thread;
 * a call to one answers as an SSE stream carrying a progress heartbeat.
 * `/mcp-up/<scope>/<name>` hands the request to `upstream` (the gateway to
 * the user's remote servers), behind the same Bearer. A design
 * thread (named by `?d=`, or `?t=`) also gets `design(threadId)`, the design
 * tools; `?d=` alone names no caller, so it adds no thread tools. `?c=<threadId>`
 * adds `code(threadId)`, code mode's run_code for that thread; the driver puts
 * it on the URL at session start, so a session's list never changes.
 */
export async function startToolServer(
  tools: () => HarnessTool[],
  extra?: (projectId: string | undefined, threadId?: string) => HarnessTool[],
  routed?: (projectId: string | undefined) => HarnessTool[],
  threadTools?: () => HarnessTool[],
  heartbeatMs = HEARTBEAT_MS,
  upstream?: (req: IncomingMessage, res: ServerResponse, scope: string, name: string) => Promise<void>,
  design?: (threadId: string) => HarnessTool[],
  code?: (threadId: string) => HarnessTool[],
): Promise<ToolServer> {
  const token = randomBytes(24).toString("hex");
  const http = createServer(async (req, res) => {
    if (!authorized(req, token)) {
      res.writeHead(401).end();
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    const up = upstream ? parseGatewayPath(path) : null;
    if (up && upstream) {
      await upstream(req, res, up.scope, up.name);
      return;
    }
    if (path !== "/mcp" && path !== "/mcp-skills" && path !== "/mcp-routed") {
      res.writeHead(404).end();
      return;
    }
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const projectId = query.get("p") ?? undefined;
    const threadId = query.get("t") ?? undefined;
    const designId = query.get("d") ?? threadId;
    const codeId = query.get("c") ?? undefined;
    if (req.method !== "POST") {
      // Stateless servers have no server-initiated stream to offer.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const parsed = await readJson(req);
    if (!parsed.ok) {
      res.writeHead(400).end();
      return;
    }
    const server = new McpServer({ name: TOOL_SERVER_NAME, version: "1.0.0" });
    // Empty for anything but a design thread, so a chat thread's list is unchanged.
    const base = [...tools(), ...(designId ? (design?.(designId) ?? []) : [])];
    const list =
      path === "/mcp-skills"
        ? [...base, ...(extra?.(projectId, threadId) ?? [])]
        : path === "/mcp-routed"
          ? [...base, ...(extra?.(projectId, threadId) ?? []), ...(routed?.(projectId) ?? [])]
          : base;
    const waiting = threadId ? (threadTools?.() ?? []) : [];
    list.push(...waiting);
    if (codeId) list.push(...(code?.(codeId) ?? []));
    const waitingNames = new Set(waiting.map((t) => t.name));
    // A call the agent abandons (the request closes before the answer) aborts, so a waiting ask_user card goes away.
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    const ctx =
      projectId || threadId || codeId
        ? { ...(projectId ? { projectId } : {}), ...(threadId ? { threadId } : {}), ...(threadId || codeId ? { signal: gone.signal } : {}) }
        : undefined;
    for (const t of list) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.input, ...(t.effect ? { annotations: { readOnlyHint: t.effect === "read" } } : {}) }, async (args: unknown, handlerExtra) => {
        const stop = waitingNames.has(t.name) ? heartbeat(handlerExtra, heartbeatMs) : () => {};
        try {
          return toResult(await t.run(args as never, ctx));
        } finally {
          stop();
        }
      });
    }
    withRequiredArrays(server);
    // Plain JSON answers, except a call that waits on the user: that one streams so the heartbeat reaches the client.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !callsAny(parsed.body, waitingNames) });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, parsed.body))
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
