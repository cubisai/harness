// One place that turns a server spec into an MCP SDK client transport, so the
// tool listing, the router pool and the gateway's SSE bridge agree.

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "../../shared/types";

export type ClientTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

/**
 * A transport for this spec; headers go on every request, env on the spawned
 * process. A `fetchFn` (the gateway's, which adds the credentials itself)
 * replaces the plain headers for URL servers.
 */
export function clientTransport(spec: McpServerSpec, fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>): ClientTransport {
  if (spec.type === "stdio") {
    return new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env: { ...getDefaultEnvironment(), ...spec.env }, stderr: "ignore" });
  }
  if (fetchFn) return spec.type === "sse" ? new SSEClientTransport(new URL(spec.url), { fetch: fetchFn }) : new StreamableHTTPClientTransport(new URL(spec.url), { fetch: fetchFn });
  const requestInit = { headers: spec.headers };
  if (spec.type === "sse") return new SSEClientTransport(new URL(spec.url), { requestInit, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...spec.headers } }) } });
  return new StreamableHTTPClientTransport(new URL(spec.url), { requestInit });
}
