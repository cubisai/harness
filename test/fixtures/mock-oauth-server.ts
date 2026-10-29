// A loopback authorization server for the OAuth tests: RFC 9728 protected
// resource metadata, RFC 8414 authorization-server metadata, dynamic
// registration, and token/revocation endpoints, with every request recorded so
// a test can assert on it. Plain http on 127.0.0.1, which is exactly the case
// guardedFetch lets through (the MCP server itself lives on loopback).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  pathname: string;
  /** The form body, for the urlencoded requests. */
  form: Record<string, string>;
  /** The parsed JSON body, for the registration request. */
  json?: unknown;
}

export interface MockOAuthConfig {
  /** Whether the authorization server advertises `authorization_response_iss_parameter_supported` (default true). */
  issParameterSupported?: boolean;
  /** Answer refresh_token grants with 400 invalid_grant. */
  refreshFails?: boolean;
}

export interface MockOAuthServer {
  base: string;
  requests: RecordedRequest[];
  config: MockOAuthConfig;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Start the fake authorization server on a free loopback port. */
export async function startMockOAuthServer(config: MockOAuthConfig = {}): Promise<MockOAuthServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const raw = method === "POST" ? await readBody(req) : "";
      const request: RecordedRequest = { method, pathname: url.pathname, form: {} };
      if (raw) {
        try {
          request.json = JSON.parse(raw);
        } catch {
          request.form = Object.fromEntries(new URLSearchParams(raw));
        }
      }
      requests.push(request);

      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      if (method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          revocation_endpoint: `${base}/revoke`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: config.issParameterSupported ?? true,
        });
      }
      if (method === "POST" && url.pathname === "/register") {
        const meta = (request.json ?? {}) as { redirect_uris?: string[] };
        return json(res, 201, {
          client_id: "client-1",
          token_endpoint_auth_method: "none",
          redirect_uris: meta.redirect_uris ?? [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (method === "POST" && url.pathname === "/token") {
        const grant = request.form.grant_type;
        if (grant === "refresh_token" && config.refreshFails) return json(res, 400, { error: "invalid_grant" });
        if (grant === "refresh_token") {
          return json(res, 200, { access_token: "at-2", token_type: "Bearer", expires_in: 3600, refresh_token: request.form.refresh_token ?? "rt-1", scope: "read" });
        }
        return json(res, 200, { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", scope: "read" });
      }
      if (method === "POST" && url.pathname === "/revoke") return void res.writeHead(200).end();
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
