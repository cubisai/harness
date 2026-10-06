import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startToolServer, type ToolServer } from "../src/main/mcp-http";
import { gatewayPath, insufficientScope, McpGateway, parseGatewayPath, type GatewayState } from "../src/main/mcp/gateway";
import type { McpServerSpec } from "../src/shared/types";

type RemoteSpec = Extract<McpServerSpec, { url: string }>;

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ http: HttpServer; base: string }> {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => {
    http.closeAllConnections();
    http.close(() => resolve(undefined));
  }));
  return { http, base: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}

function upstreamServer(): McpServer {
  const server = new McpServer({ name: "upstream", version: "2.0.0" });
  server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `up: ${text}` }] }));
  return server;
}

/** What every upstream saw, for assertions. */
interface Seen {
  auth: (string | undefined)[];
  sessions: (string | undefined)[];
  methods: string[];
  agentBearer: boolean;
}

/**
 * A stateful Streamable HTTP upstream (it issues an mcp-session-id). It wants
 * `x-key: k1`, and, when `bearer` is set, `Authorization: Bearer <bearer()>`;
 * otherwise 401 (with `challenge` as WWW-Authenticate) or `refuse()`'s answer.
 */
async function httpUpstream(opts: { bearer?: () => string; challenge?: string; refuse?: (res: ServerResponse) => boolean } = {}) {
  const seen: Seen = { auth: [], sessions: [], methods: [], agentBearer: false };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const { base } = await listen(async (req, res) => {
    seen.auth.push(req.headers.authorization);
    seen.methods.push(req.method ?? "");
    seen.sessions.push(req.headers["mcp-session-id"] as string | undefined);
    if (req.headers["x-key"] !== "k1") return void res.writeHead(400).end("no key");
    if (opts.refuse?.(res)) return;
    if (opts.bearer && req.headers.authorization !== `Bearer ${opts.bearer()}`) {
      return void res.writeHead(401, opts.challenge ? { "www-authenticate": opts.challenge } : {}).end();
    }
    const id = req.headers["mcp-session-id"] as string | undefined;
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, transport!) });
      await upstreamServer().connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  return { url: `${base}/mcp`, seen };
}

/** A legacy SSE upstream: GET /sse opens the stream, POST /messages carries requests. It wants `x-key: k1`. */
async function sseUpstream() {
  const transports = new Map<string, SSEServerTransport>();
  const { base } = await listen(async (req, res) => {
    if (req.headers["x-key"] !== "k1") return void res.writeHead(401).end();
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      await upstreamServer().connect(transport);
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const t = transports.get(url.searchParams.get("sessionId") ?? "");
      if (!t) return void res.writeHead(404).end();
      await t.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  return { url: `${base}/sse` };
}

interface FakeAuth {
  token: string | null;
  refreshed: string | null;
  refreshCalls: number;
  stepUps: string[];
}

function fakeAuth(token: string | null, refreshed: string | null = null): FakeAuth & { api: ConstructorParameters<typeof McpGateway>[0]["auth"] } {
  const state: FakeAuth = { token, refreshed, refreshCalls: 0, stepUps: [] };
  return Object.assign(state, {
    api: {
      hasTokens: () => state.token !== null,
      accessToken: async () => state.token,
      refresh: async () => {
        state.refreshCalls++;
        state.token = state.refreshed;
        return state.refreshed;
      },
      noteStepUp: (_key: string, scopes: string) => void state.stepUps.push(scopes),
    },
  });
}

/** The app's tool server with the gateway on /mcp-up, serving one remote server as global:remote. */
async function gateway(spec: RemoteSpec, auth = fakeAuth(null)) {
  const states: GatewayState[] = [];
  const gw = new McpGateway({
    target: (scope, name) => (scope === "global" && name === "remote" ? { key: "global:remote", spec } : null),
    auth: auth.api,
    onState: (_k, s) => void states.push(s),
  });
  const server: ToolServer = await startToolServer(() => [], undefined, undefined, undefined, undefined, (req, res, scope, name) => gw.handle(req, res, scope, name));
  closers.push(() => server.close(), () => gw.closeAll());
  const url = new URL(gatewayPath("global", "remote"), server.url).toString();
  return { gw, server, url, states, auth };
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  closers.push(() => client.close());
  return client;
}

describe("gateway paths", () => {
  it("round-trips scope and name, project ids included", () => {
    expect(parseGatewayPath(gatewayPath("project:p 1", "docs"))).toEqual({ scope: "project:p 1", name: "docs" });
    expect(parseGatewayPath("/mcp-up/global")).toBeNull();
    expect(parseGatewayPath("/mcp-up/global/a/b")).toBeNull();
    expect(parseGatewayPath("/mcp")).toBeNull();
  });

  it("reads an insufficient_scope challenge", () => {
    expect(insufficientScope('Bearer error="insufficient_scope", scope="files:write files:read"')).toBe("files:write files:read");
    expect(insufficientScope('Bearer error="invalid_token"')).toBeNull();
    expect(insufficientScope(null)).toBeNull();
  });
});

describe("gateway, Streamable HTTP upstream", () => {
  it("proxies a session with the server's headers and keeps the agent's Bearer to itself", async () => {
    const up = await httpUpstream();
    const g = await gateway({ type: "http", url: up.url, headers: { "x-key": "k1" } });
    const client = await connect(g.url, g.server.token);
    expect(client.getServerVersion()?.name).toBe("upstream");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect((result.content as { text: string }[])[0]?.text).toBe("up: hi");
    // The session id the upstream issued came back on later requests.
    expect(up.seen.sessions.filter(Boolean).length).toBeGreaterThan(0);
    // The gateway's own Bearer never went upstream.
    expect(up.seen.auth.every((a) => a === undefined)).toBe(true);
    // Closing the session reaches the upstream as a DELETE.
    await (client.transport as StreamableHTTPClientTransport).terminateSession();
    expect(up.seen.methods).toContain("DELETE");
    expect(g.states.at(-1)).toEqual({ state: "ok" });
  });

  it("refuses requests without the tool server's Bearer, and unknown servers", async () => {
    const up = await httpUpstream();
    const g = await gateway({ type: "http", url: up.url, headers: { "x-key": "k1" } });
    expect((await fetch(g.url, { method: "POST", body: "{}" })).status).toBe(401);
    const other = new URL(gatewayPath("global", "nope"), g.server.url);
    expect((await fetch(other, { method: "POST", headers: { Authorization: `Bearer ${g.server.token}` }, body: "{}" })).status).toBe(404);
    expect(up.seen.methods).toEqual([]);
  });

  it("adds the access token, and refreshes once on a 401", async () => {
    const up = await httpUpstream({ bearer: () => "at-new" });
    const auth = fakeAuth("at-old", "at-new");
    const g = await gateway({ type: "http", url: up.url, headers: { "x-key": "k1" } }, auth);
    const client = await connect(g.url, g.server.token);
    expect((await client.listTools()).tools).toHaveLength(1);
    expect(auth.refreshCalls).toBe(1);
    expect(up.seen.auth).toContain("Bearer at-old");
    expect(up.seen.auth.at(-1)).toBe("Bearer at-new");
  });

  it("says needs-auth and hides the challenge from the agent when there's no way in", async () => {
    const up = await httpUpstream({ bearer: () => "never", challenge: 'Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource"' });
    const auth = fakeAuth("at-old", null);
    const g = await gateway({ type: "http", url: up.url, headers: { "x-key": "k1" } }, auth);
    const res = await fetch(g.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${g.server.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a", version: "1" } } }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(g.states.at(-1)?.state).toBe("needs-auth");
    expect(auth.refreshCalls).toBe(1);
  });

  it("notes a step-up scope from a 403", async () => {
    const up = await httpUpstream({
      refuse: (res) => {
        res.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin"' }).end();
        return true;
      },
    });
    const auth = fakeAuth("at-1");
    const g = await gateway({ type: "http", url: up.url, headers: { "x-key": "k1" } }, auth);
    const res = await fetch(g.url, { method: "POST", headers: { Authorization: `Bearer ${g.server.token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(auth.stepUps).toEqual(["admin"]);
    expect(g.states.at(-1)?.state).toBe("needs-auth");
  });

  it("won't follow a redirect to another site with the credentials", async () => {
    const elsewhere = await listen((_req, res) => res.writeHead(200).end("{}"));
    const { base } = await listen((_req, res) => res.writeHead(307, { location: `${elsewhere.base}/mcp` }).end());
    const g = await gateway({ type: "http", url: `${base}/mcp`, headers: { "x-key": "k1" } });
    const res = await fetch(g.url, { method: "POST", headers: { Authorization: `Bearer ${g.server.token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/another site/);
    expect(g.states.at(-1)?.state).toBe("failed");
  });
});

describe("gateway, SSE upstream", () => {
  it("bridges a legacy SSE server to Streamable HTTP, headers included", async () => {
    const up = await sseUpstream();
    const g = await gateway({ type: "sse", url: up.url, headers: { "x-key": "k1" } });
    const client = await connect(g.url, g.server.token);
    expect(client.getServerVersion()?.name).toBe("upstream");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "sse" } });
    expect((result.content as { text: string }[])[0]?.text).toBe("up: sse");
  });

  it("reports a failure when the SSE server refuses", async () => {
    const up = await sseUpstream();
    const g = await gateway({ type: "sse", url: up.url });
    const res = await fetch(g.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${g.server.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a", version: "1" } } }),
    });
    expect(res.status).toBe(502);
    expect(g.states.at(-1)?.state).not.toBe("ok");
  });
});

describe("McpScopes with the gateway", () => {
  it("hands URL servers to agents as their gateway route, leaves them out until it's up, and keeps stdio as is", async () => {
    const { McpScopes, McpServerStore, viewOf } = await import("../src/main/mcp/servers");
    const { tempDir } = await import("./helpers");
    const { join } = await import("node:path");
    const dir = tempDir();
    const global = new McpServerStore(join(dir, "mcp.json"));
    global.save({ name: "remote", enabled: true, spec: { type: "http", url: "https://x.test/mcp", headers: { "x-key": "secret-1", "x-ref": "${HOME_REF}" } } });
    global.save({ name: "local", enabled: true, spec: { type: "stdio", command: "node", args: ["s.js"] } });
    const scopes = new McpScopes(global, (id) => join(dir, id));
    scopes.project("p1").save({ name: "mine", enabled: true, spec: { type: "sse", url: "https://y.test/sse" } });
    let up = false;
    scopes.setRemote((scope, name) => (up ? { type: "http", url: `http://127.0.0.1:1${gatewayPath(scope, name)}`, headers: { Authorization: "Bearer gw" } } : null));
    expect(scopes.effective("p1").map((s) => s.name)).toEqual(["local"]);
    up = true;
    const got = Object.fromEntries(scopes.effective("p1").map((s) => [s.name, s.spec]));
    expect(got.mine).toEqual({ type: "http", url: "http://127.0.0.1:1/mcp-up/project%3Ap1/mine", headers: { Authorization: "Bearer gw" } });
    expect(got.remote).toEqual({ type: "http", url: "http://127.0.0.1:1/mcp-up/global/remote", headers: { Authorization: "Bearer gw" } });
    expect(got.local).toEqual({ type: "stdio", command: "node", args: ["s.js"] });
    expect(JSON.stringify(got)).not.toContain("secret-1");
    // The edit form gets the ${VAR} reference back, never the secret.
    const view = viewOf(global.list().find((s) => s.name === "remote")!);
    expect(view.publicValues).toEqual({ "x-ref": "${HOME_REF}" });
    expect(viewOf(global.list().find((s) => s.name === "local")!).args).toEqual(["s.js"]);
  });
});
