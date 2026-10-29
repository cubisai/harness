import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeMcpUrl } from "../src/main/mcp/probe";

let server: Server;
let base = "";
/** Every `mcp-session-id` seen on a DELETE /ok. */
const sessionDeletes: string[] = [];
let okApiKey: string | undefined;

function bodyOf(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => undefined);
    req.on("end", () => resolve());
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const INIT = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "okserver" } } };

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const method = req.method ?? "GET";
    void bodyOf(req).then(() => {
      if (path === "/ok" && method === "POST") {
        okApiKey = req.headers["x-api-key"] as string | undefined;
        return json(res, 200, INIT, { "mcp-session-id": "s1" });
      }
      if (path === "/ok" && method === "DELETE") {
        sessionDeletes.push(String(req.headers["mcp-session-id"] ?? ""));
        return void res.writeHead(200).end();
      }
      if (path === "/stream" && method === "POST") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"streamer"}}}\n\n');
        return; // keep the connection open
      }
      if (path === "/oauth" && method === "POST") {
        res.writeHead(401, { "www-authenticate": `Bearer realm="x", resource_metadata="${base}/.well-known/oauth-protected-resource/oauth"` });
        return void res.end();
      }
      if (path === "/wk" && method === "POST") {
        res.writeHead(401, { "www-authenticate": "Bearer" });
        return void res.end();
      }
      if (path === "/.well-known/oauth-protected-resource/wk" && method === "GET") {
        return json(res, 200, { resource: `${base}/wk`, authorization_servers: [base] });
      }
      if (path === "/token" && method === "POST") {
        res.writeHead(401, { "www-authenticate": "Bearer" });
        return void res.end();
      }
      if (path === "/legacy" && method === "POST") return void res.writeHead(405).end();
      if (path === "/legacy" && method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages?sessionId=1\n\n");
        return; // keep the connection open
      }
      if (path === "/notmcp") return void res.writeHead(404).end();
      if (path === "/broken" && method === "POST") return void res.writeHead(500).end();
      if (path === "/hang") return; // never answers
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

describe("probeMcpUrl", () => {
  it("takes a Streamable HTTP answer, names the server and deletes the session", async () => {
    const result = await probeMcpUrl(`${base}/ok`, { headers: { "x-api-key": "zzsecretzz" } });
    expect(result).toEqual({ ok: true, transport: "http", auth: "none", serverName: "okserver" });
    expect(okApiKey).toBe("zzsecretzz");
    expect(JSON.stringify(result)).not.toContain("zzsecretzz");
    await waitFor(() => sessionDeletes.includes("s1"));
    expect(sessionDeletes).toContain("s1");
  });

  it("reads the initialize result out of an open SSE stream", async () => {
    expect(await probeMcpUrl(`${base}/stream`)).toEqual({ ok: true, transport: "http", auth: "none", serverName: "streamer" });
  });

  it("reports OAuth from a resource_metadata challenge", async () => {
    expect(await probeMcpUrl(`${base}/oauth`)).toEqual({
      ok: true,
      transport: "http",
      auth: "oauth",
      resourceMetadata: `${base}/.well-known/oauth-protected-resource/oauth`,
    });
  });

  it("discovers OAuth metadata at the well-known path", async () => {
    expect(await probeMcpUrl(`${base}/wk`)).toEqual({
      ok: true,
      transport: "http",
      auth: "oauth",
      resourceMetadata: `${base}/.well-known/oauth-protected-resource/wk`,
    });
  });

  it("falls back to a token when no OAuth metadata is published", async () => {
    expect(await probeMcpUrl(`${base}/token`)).toEqual({ ok: true, transport: "http", auth: "token" });
  });

  it("falls back to the legacy SSE transport", async () => {
    expect(await probeMcpUrl(`${base}/legacy`)).toEqual({ ok: true, transport: "sse", auth: "none" });
  });

  it("says a 404 to both transports isn't an MCP server", async () => {
    expect(await probeMcpUrl(`${base}/notmcp`)).toEqual({
      ok: false,
      auth: "none",
      error: "It isn't an MCP server (HTTP 404 to initialize, 404 to SSE).",
    });
  });

  it("reports an unexpected HTTP status", async () => {
    expect(await probeMcpUrl(`${base}/broken`)).toEqual({ ok: false, auth: "none", error: "The server answered HTTP 500." });
  });

  it("gives up on a server that never answers", async () => {
    const result = await probeMcpUrl(`${base}/hang`, { timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, auth: "none" });
    expect(result.error).toMatch(/No answer/);
  });

  it("rejects a URL that isn't http(s)", async () => {
    expect(await probeMcpUrl("ftp://x")).toEqual({ ok: false, auth: "none", error: "The URL has to start with http:// or https://." });
  });
});
