// The way agents reach remote MCP servers: `/mcp-up/<scope>/<name>` on the
// app's own loopback tool server, behind its per-launch Bearer. Main forwards
// each request upstream with the server's credentials (secret headers from the
// vault, an OAuth access token refreshed here), so tokens never reach an
// agent's config, env, argv or logs, and a refresh never reopens a session.
// Streamable HTTP upstreams get a byte-level reverse proxy; legacy SSE
// upstreams get an MCP-level bridge (an SDK client behind a stateless server),
// which also turns them into Streamable HTTP for agents that can't speak SSE.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerSpec } from "../../shared/types";
import type { McpAuth } from "./oauth";
import { clientTransport } from "./transport";

type RemoteSpec = Extract<McpServerSpec, { url: string }>;
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** The route prefix on the tool server. */
export const GATEWAY_PREFIX = "/mcp-up/";
/** A request body larger than this is refused (413); MCP messages are small. */
const MAX_BODY = 16 * 1024 * 1024;
const BRIDGE_CONNECT_MS = 15_000;
/** How long a bridged call may run; agents keep their own, shorter limits. */
const BRIDGE_CALL_MS = 10 * 60_000;

/** The request headers an MCP client sends that the upstream needs; everything else (the gateway's Bearer, cookies…) stays here. */
const FORWARD_REQUEST = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** Response headers that describe this hop, or that agents mustn't act on (they'd start their own sign-in, or keep a cookie). */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-connection", "content-encoding", "content-length", "www-authenticate", "set-cookie"]);

/** The tool-server path for one server; `scope` is "global" or "project:<id>", as in the vault key. */
export function gatewayPath(scope: string, name: string): string {
  return `${GATEWAY_PREFIX}${encodeURIComponent(scope)}/${encodeURIComponent(name)}`;
}

/** The scope and name a gateway path names, or null when it isn't one. */
export function parseGatewayPath(path: string): { scope: string; name: string } | null {
  if (!path.startsWith(GATEWAY_PREFIX)) return null;
  const parts = path.slice(GATEWAY_PREFIX.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    return { scope: decodeURIComponent(parts[0]), name: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

/** What a `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` challenge asks for, if that's what it is. */
export function insufficientScope(header: string | null): string | null {
  if (!header || !/error\s*=\s*"?insufficient_scope"?/i.test(header)) return null;
  return /scope\s*=\s*"([^"]*)"/i.exec(header)?.[1]?.trim() || null;
}

export type GatewayState = { state: "ok" } | { state: "needs-auth"; error: string } | { state: "failed"; error: string };

export interface McpGatewayDeps {
  /** The enabled server at this scope and name, with its header values resolved (vault, ${VAR}); null = 404. `key` is the vault key. */
  target(scope: string, name: string): { key: string; spec: RemoteSpec } | null;
  auth: Pick<McpAuth, "accessToken" | "refresh" | "noteStepUp" | "hasTokens">;
  /** A server's state changed (signed out, refused, back up). */
  onState?(key: string, state: GatewayState): void;
  fetchFn?: FetchLike;
}

interface Bridge {
  client: Client;
  url: string;
  ready: Promise<void>;
}

export class McpGateway {
  private states = new Map<string, GatewayState>();
  private bridges = new Map<string, Bridge>();

  constructor(private deps: McpGatewayDeps) {}

  /** The last state the gateway saw for a server; undefined until a request went through. */
  state(key: string): GatewayState | undefined {
    return this.states.get(key);
  }

  /** Forget a server's state and drop its bridge, after a sign-in, sign-out or edit. */
  async reset(key: string): Promise<void> {
    this.states.delete(key);
    const bridge = this.bridges.get(key);
    this.bridges.delete(key);
    await bridge?.client.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const all = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(all.map((b) => b.client.close().catch(() => {})));
  }

  private setState(key: string, next: GatewayState): void {
    const prev = this.states.get(key);
    this.states.set(key, next);
    if (prev?.state !== next.state || (prev.state !== "ok" && next.state !== "ok" && prev.error !== next.error)) this.deps.onState?.(key, next);
  }

  /** Serve one agent request for the server at this scope and name. Never throws. */
  async handle(req: IncomingMessage, res: ServerResponse, scope: string, name: string): Promise<void> {
    const target = this.deps.target(scope, name);
    if (!target) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (target.spec.type === "sse") await this.bridge(req, res, target.key, target.spec);
      else await this.proxy(req, res, target.key, target.spec);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.setState(target.key, { state: "failed", error });
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(`Upstream MCP server failed: ${error}`);
      else res.destroy();
    }
  }

  /**
   * fetch to the upstream with the server's own headers and, when signed in,
   * its access token; a 401 refreshes once and retries (the body must be
   * replayable, which a string or buffer is); a 403 asking for more scopes is
   * noted for the next sign-in. Redirects are followed within the same origin only.
   */
  private authedFetch(key: string, spec: RemoteSpec): FetchLike {
    const base = this.deps.fetchFn ?? fetch;
    return async (input, init) => {
      const send = async (token: string | null) => {
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(spec.headers ?? {})) headers.set(k, v);
        if (token) headers.set("authorization", `Bearer ${token}`);
        let url = new URL(String(input));
        for (let hop = 0; hop < 4; hop++) {
          const res = await base(url, { ...init, headers, redirect: "manual" });
          const location = res.headers.get("location");
          if (res.status < 300 || res.status >= 400 || !location) return res;
          const next = new URL(location, url);
          // Credentials go only where the user pointed them.
          if (next.origin !== url.origin) throw new Error(`The server redirected to another site (${next.origin}); not following with its credentials.`);
          if (res.status !== 307 && res.status !== 308 && init?.method && init.method !== "GET") throw new Error(`The server redirected a ${init.method} with ${res.status}; update its URL to ${next.href}.`);
          url = next;
        }
        throw new Error("Too many redirects from the MCP server.");
      };
      const signedIn = this.deps.auth.hasTokens(key);
      let token = signedIn ? await this.deps.auth.accessToken(key, spec) : null;
      let res = await send(token);
      if (res.status === 401 && signedIn) {
        token = await this.deps.auth.refresh(key, spec);
        if (token) {
          await res.body?.cancel().catch(() => {});
          res = await send(token);
        }
      }
      if (res.status === 401) {
        const hint = res.headers.get("www-authenticate");
        this.setState(key, { state: "needs-auth", error: signedIn ? "The sign-in expired or was revoked. Connect again." : hint ? "The server wants a sign-in. Connect first." : "The server refused the credentials." });
      } else if (res.status === 403) {
        const scopes = insufficientScope(res.headers.get("www-authenticate"));
        if (scopes) {
          this.deps.auth.noteStepUp(key, scopes);
          this.setState(key, { state: "needs-auth", error: `The server wants more access (${scopes}). Connect again to grant it.` });
        }
      } else if (res.ok) this.setState(key, { state: "ok" });
      return res;
    };
  }

  /** Streamable HTTP: pass the request through byte for byte, credentials added, and stream the answer back. */
  private async proxy(req: IncomingMessage, res: ServerResponse, key: string, spec: RemoteSpec): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      res.writeHead(405, { Allow: "POST, GET, DELETE" }).end();
      return;
    }
    const body = method === "POST" ? await readBody(req) : undefined;
    if (body === null) {
      res.writeHead(413).end();
      return;
    }
    const headers: Record<string, string> = {};
    for (const h of FORWARD_REQUEST) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    // The agent hanging up ends the upstream request too (a long GET stream, a call it gave up on).
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const upstream = await this.authedFetch(key, spec)(spec.url, { method, headers, ...(body && { body: new Uint8Array(body) }), signal: gone.signal });
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k.toLowerCase())) out[k] = v;
    });
    res.writeHead(upstream.status, out);
    if (!upstream.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  /** The SDK client for an SSE upstream, connected once and shared by every request until it fails or is reset. */
  private async sseClient(key: string, spec: RemoteSpec): Promise<Client> {
    let bridge = this.bridges.get(key);
    if (bridge && bridge.url !== spec.url) {
      await this.reset(key);
      bridge = undefined;
    }
    if (!bridge) {
      const client = new Client({ name: "cubiq", version: "1.0.0" });
      const transport = clientTransport(spec, this.authedFetch(key, spec));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No answer in ${BRIDGE_CONNECT_MS / 1000} seconds.`)), BRIDGE_CONNECT_MS);
      });
      const created: Bridge = { client, url: spec.url, ready: Promise.race([client.connect(transport), timeout]).finally(() => clearTimeout(timer)) };
      // A dropped stream means the next request reconnects.
      client.onclose = () => {
        if (this.bridges.get(key) === created) this.bridges.delete(key);
      };
      bridge = created;
      this.bridges.set(key, bridge);
    }
    try {
      await bridge.ready;
    } catch (err) {
      if (this.bridges.get(key) === bridge) this.bridges.delete(key);
      await bridge.client.close().catch(() => {});
      throw err;
    }
    return bridge.client;
  }

  /** SSE: answer as a stateless Streamable HTTP server whose tools, prompts and resources are the upstream's. */
  private async bridge(req: IncomingMessage, res: ServerResponse, key: string, spec: RemoteSpec): Promise<void> {
    if (req.method !== "POST") {
      // Stateless: there's no server-initiated stream to offer.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      res.writeHead(413).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const client = await this.sseClient(key, spec);
    const upstream = client.getServerCapabilities() ?? {};
    const capabilities: ServerCapabilities = {
      ...(upstream.tools && { tools: {} }),
      ...(upstream.prompts && { prompts: {} }),
      ...(upstream.resources && { resources: {} }),
    };
    const info = client.getServerVersion();
    const instructions = client.getInstructions();
    const server = new Server({ name: info?.name ?? "upstream", version: info?.version ?? "1.0.0" }, { capabilities, ...(instructions && { instructions }) });
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const opts = { signal: gone.signal, timeout: BRIDGE_CALL_MS };
    if (capabilities.tools) {
      server.setRequestHandler(ListToolsRequestSchema, (r) => client.request({ method: "tools/list", params: r.params }, ListToolsResultSchema, opts));
      server.setRequestHandler(CallToolRequestSchema, (r) => client.request({ method: "tools/call", params: r.params }, CallToolResultSchema, opts));
    }
    if (capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, (r) => client.request({ method: "prompts/list", params: r.params }, ListPromptsResultSchema, opts));
      server.setRequestHandler(GetPromptRequestSchema, (r) => client.request({ method: "prompts/get", params: r.params }, GetPromptResultSchema, opts));
    }
    if (capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, (r) => client.request({ method: "resources/list", params: r.params }, ListResourcesResultSchema, opts));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, (r) => client.request({ method: "resources/templates/list", params: r.params }, ListResourceTemplatesResultSchema, opts));
      server.setRequestHandler(ReadResourceRequestSchema, (r) => client.request({ method: "resources/read", params: r.params }, ReadResourceResultSchema, opts));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

/** The whole request body, or null when it's over the limit. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
