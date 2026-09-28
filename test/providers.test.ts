import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider, WireProtocol } from "../src/shared/types";
import { catalogFor, codexCompatible, isProviderId, providerWarning, testConnection } from "../src/main/providers";

const capabilities = { tools: true, vision: false, reasoning: true };

// One literal per wire protocol; the `satisfies` is the T1.1 compile-time check.
const byProtocol = {
  "anthropic-messages": {
    id: "anthropic",
    label: "Anthropic",
    wireProtocol: "anthropic-messages",
    baseURL: "https://api.anthropic.com",
    secret: { kind: "envRef", envVar: "ANTHROPIC_API_KEY" },
    models: [{ id: "claude-opus", capabilities, contextWindow: 200_000, maxOutput: 64_000 }],
  },
  "openai-responses": {
    id: "codex",
    label: "Codex",
    wireProtocol: "openai-responses",
    baseURL: "https://api.openai.com",
    secret: { kind: "envRef", envVar: "OPENAI_API_KEY" },
    models: [{ id: "gpt", capabilities, contextWindow: 128_000, maxOutput: 16_000 }],
  },
  "openai-chat": {
    id: "deepseek",
    label: "DeepSeek",
    wireProtocol: "openai-chat",
    baseURL: "https://api.deepseek.com",
    secret: { kind: "envRef", envVar: "DEEPSEEK_API_KEY" },
    models: [{ id: "deepseek-chat", capabilities, contextWindow: 64_000, maxOutput: 8_000 }],
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    wireProtocol: "gemini",
    baseURL: "https://generativelanguage.googleapis.com",
    secret: { kind: "envRef", envVar: "GEMINI_API_KEY" },
    models: [{ id: "gemini-pro", capabilities, contextWindow: 1_000_000, maxOutput: 64_000 }],
  },
} satisfies Record<WireProtocol, Provider>;

describe("isProviderId", () => {
  it("has a compilable fixture for every wire protocol", () => {
    expect(Object.keys(byProtocol)).toHaveLength(4);
  });

  it("rejects reserved ids", () => {
    expect(isProviderId("claude")).toBe(false);
    expect(isProviderId("cubiq")).toBe(false);
    expect(isProviderId("unskilled")).toBe(false);
  });

  it("accepts a slug and rejects whitespace", () => {
    expect(isProviderId("my-gateway")).toBe(true);
    expect(isProviderId("a b")).toBe(false);
  });
});

describe("providerWarning", () => {
  it("is null for the first-party host", () => {
    expect(providerWarning({ baseURL: "https://api.anthropic.com" }, "claude")).toBeNull();
  });

  it("warns about feature loss on a gateway", () => {
    const warning = providerWarning({ baseURL: "https://gateway.example.com" }, "claude");
    expect(warning).toMatch(/Remote Control/);
    expect(warning).toMatch(/MCP tool search/);
  });

  it("treats an unparseable URL as non-first-party and ignores other agents", () => {
    expect(providerWarning({ baseURL: "not a url" }, "claude")).toMatch(/Remote Control/);
    expect(providerWarning({ baseURL: "https://gateway.example.com" }, "opencode")).toBeNull();
  });
});

describe("codexCompatible", () => {
  it("accepts only the Responses API", () => {
    expect(codexCompatible({ wireProtocol: "openai-responses" })).toEqual({ ok: true });
    const bad = codexCompatible({ wireProtocol: "openai-chat" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/Responses/);
  });
});

interface RequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

async function startStub(handler: (req: RequestRecord, res: ServerResponse) => void): Promise<{ url: string; requests: RequestRecord[] }> {
  const requests: RequestRecord[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const record: RequestRecord = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")])),
        body,
      };
      requests.push(record);
      handler(record, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, requests };
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function provider(patch: Partial<Provider>): Provider {
  return {
    id: "gateway",
    label: "Gateway",
    wireProtocol: "openai-chat",
    baseURL: "",
    secret: { kind: "envRef", envVar: "GATEWAY_KEY" },
    models: [{ id: "m", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 4096, maxOutput: 1024 }],
    ...patch,
  };
}

const chatToolCall = { choices: [{ message: { tool_calls: [{ id: "1", type: "function", function: { name: "ping", arguments: "{}" } }] } }] };

describe("testConnection", () => {
  it("401: unreachable with header-semantics triage", async () => {
    const stub = await startStub((_req, res) => send(res, 401, { error: "nope" }));
    const result = await testConnection(provider({ baseURL: stub.url }), "m", "sk-test");
    expect(result.reachable).toBe(false);
    expect(result.triage).toMatch(/X-Api-Key/);
    expect(result.triage).toMatch(/Authorization: Bearer/);
  });

  it("chat that answers but can't call tools: reachable, supportsTools false", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/models")) return send(res, 200, { data: [] });
      return send(res, 200, { choices: [{ message: { content: "hi" } }] });
    });
    const result = await testConnection(provider({ baseURL: stub.url }), "m", "sk-test");
    expect(result.reachable).toBe(true);
    expect(result.listsModels).toBe(true);
    expect(result.supportsTools).toBe(false);
    expect(result.triage).toMatch(/cannot call tools/);
  });

  it("supportsTools true when the tools probe gets a tool call", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/models")) return send(res, 200, { data: [] });
      return send(res, 200, req.body.includes('"tools"') ? chatToolCall : { choices: [{ message: { content: "hi" } }] });
    });
    const result = await testConnection(provider({ baseURL: stub.url }), "m", "sk-test");
    expect(result.reachable).toBe(true);
    expect(result.supportsTools).toBe(true);
    expect(result.triage).toBeUndefined();
  });

  it("404: triage points at raw path mode and models are skipped as null", async () => {
    const stub = await startStub((_req, res) => send(res, 404, { error: "not found" }));
    const result = await testConnection(provider({ baseURL: stub.url }), "m", "sk-test");
    expect(result.reachable).toBe(false);
    expect(result.listsModels).toBeNull();
    expect(result.triage).toMatch(/raw/);
  });

  it("400: triage points at stripping beta headers", async () => {
    const stub = await startStub((_req, res) => send(res, 400, { error: "bad request" }));
    const result = await testConnection(provider({ baseURL: stub.url }), "m", "sk-test");
    expect(result.reachable).toBe(false);
    expect(result.triage).toMatch(/strip/);
  });

  it("betaHeaders strip removes an anthropic-beta header but keeps the rest", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/models")) return send(res, 200, { data: [] });
      return send(res, 200, req.body.includes('"tools"') ? chatToolCall : { choices: [{ message: { content: "hi" } }] });
    });
    const p = provider({ baseURL: stub.url, headers: { "anthropic-beta": "tools-2024", "x-custom": "yes" }, betaHeaders: "strip" });
    await testConnection(p, "m", "sk-test");
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const req of stub.requests) {
      expect(req.headers["anthropic-beta"]).toBeUndefined();
      expect(req.headers["x-custom"]).toBe("yes");
    }
  });

  it("a base already ending in /v1 doesn't become /v1/v1", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/v1/models")) return send(res, 200, { data: [] });
      if (req.body.includes('"tools"')) return send(res, 200, { content: [{ type: "tool_use", name: "ping" }] });
      return send(res, 200, { content: [{ type: "text", text: "hi" }] });
    });
    const p = provider({ baseURL: `${stub.url}/v1`, wireProtocol: "anthropic-messages" });
    const result = await testConnection(p, "m", "sk-test");
    expect(stub.requests.some((r) => r.url.startsWith("/v1/messages"))).toBe(true);
    expect(stub.requests.every((r) => !r.url.includes("/v1/v1"))).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.supportsTools).toBe(true);
  });
});

describe("catalogFor", () => {
  const fixture = (wireProtocol: WireProtocol): Provider => ({
    id: "gateway",
    label: "Gateway",
    wireProtocol,
    baseURL: "https://gateway.example.com",
    secret: { kind: "envRef", envVar: "GATEWAY_KEY" },
    headers: { "x-extra": "1" },
    env: { GATEWAY_FLAG: "on" },
    models: [
      {
        id: "picked",
        modelID: "wire/picked",
        name: "Picked",
        capabilities: { tools: true, vision: true, reasoning: true },
        contextWindow: 200_000,
        maxOutput: 64_000,
        alias: "opus",
      },
      {
        id: "plain",
        capabilities: { tools: false, vision: false, reasoning: false },
        contextWindow: 8_000,
        maxOutput: 1_024,
      },
    ],
  });

  for (const protocol of ["anthropic-messages", "openai-responses", "openai-chat", "gemini"] as const) {
    it(`compiles the catalog for ${protocol}`, () => {
      expect(catalogFor(fixture(protocol))).toMatchSnapshot();
    });
  }
});
