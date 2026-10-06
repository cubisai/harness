import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider } from "../src/shared/types";
import { ModelsDev, discoverModels, pickSmallModel, type DiscoveredModel } from "../src/main/models-catalog";

interface RequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

let servers: Server[] = [];
let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
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

function tempFile(name = "models.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "models-catalog-"));
  dirs.push(dir);
  return join(dir, name);
}

function provider(patch: Partial<Provider>): Provider {
  return {
    id: "gateway",
    label: "Gateway",
    wireProtocol: "openai-chat",
    baseURL: "",
    secret: { kind: "envRef", envVar: "GATEWAY_KEY" },
    models: [],
    ...patch,
  };
}

function dm(id: string, cost: { input: number; output: number } | undefined, tools: boolean): DiscoveredModel {
  return {
    id,
    capabilities: { tools, vision: false, reasoning: false },
    contextWindow: 1000,
    maxOutput: 100,
    enriched: false,
    ...(cost ? { cost } : {}),
  };
}

describe("discoverModels listings", () => {
  it("lists openai-chat models, defaults bare entries and keeps rich fields", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/models")) {
        return send(res, 200, {
          data: [
            { id: "bare" },
            {
              id: "rich",
              name: "Rich",
              context_length: 200_000,
              max_output_tokens: 16_000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools"],
            },
          ],
        });
      }
      return send(res, 404);
    });
    const result = await discoverModels(provider({ baseURL: stub.url }), "sk-key");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((m) => m.id)).toEqual(["bare", "rich"]);

    const bare = result.models[0]!;
    expect(bare.contextWindow).toBe(128_000);
    expect(bare.maxOutput).toBe(8_192);
    expect(bare.capabilities).toEqual({ tools: true, vision: false, reasoning: false });
    expect(bare.enriched).toBe(false);

    const rich = result.models[1]!;
    expect(rich.name).toBe("Rich");
    expect(rich.contextWindow).toBe(200_000);
    expect(rich.maxOutput).toBe(16_000);
    expect(rich.cost?.input).toBeCloseTo(1);
    expect(rich.cost?.output).toBeCloseTo(2);
    expect(rich.enriched).toBe(true);

    // Auth header is sent, content-type is not part of a GET listing.
    expect(stub.requests[0]!.headers.authorization).toBe("Bearer sk-key");
    expect(stub.requests[0]!.headers["content-type"]).toBeUndefined();
  });

  it("reads openai-responses extras: top_provider limits, tool flags, per-1M pricing", async () => {
    const stub = await startStub((_req, res) =>
      send(res, 200, {
        data: [{ id: "gpt-x", top_provider: { max_completion_tokens: 32_000 }, supports_tool_calling: false, pricing: { input: 0.5, output: 1.5 } }],
      }),
    );
    const result = await discoverModels(provider({ wireProtocol: "openai-responses", baseURL: stub.url }), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = result.models[0]!;
    expect(model.maxOutput).toBe(32_000);
    expect(model.capabilities.tools).toBe(false);
    expect(model.cost).toEqual({ input: 0.5, output: 1.5 });
    expect(model.enriched).toBe(true);
  });

  it("reads TokenHarbor's listing: label, per-1M usd pricing, tool_call, prompt cache, null context", async () => {
    const stub = await startStub((_req, res) =>
      send(res, 200, {
        object: "list",
        data: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", pricing: { input_usd_per_1m: 0.1, output_usd_per_1m: 0.4 }, supports_prompt_cache: true, context_length: null, tool_call: true, function_call: true }],
      }),
    );
    const result = await discoverModels(provider({ baseURL: stub.url }), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = result.models[0]!;
    expect(model.name).toBe("DeepSeek V4 Flash");
    expect(model.cost).toEqual({ input: 0.1, output: 0.4 });
    expect(model.capabilities).toMatchObject({ tools: true, promptCaching: true });
    expect(model.contextWindow).toBe(128_000);
  });

  it("reads PGS Grove's listing: context_window, per-m pricing, image input, and skips non-chat models", async () => {
    const stub = await startStub((_req, res) =>
      send(res, 200, {
        data: [
          { id: "mimo-v2.6-pro", type: "chat", context_window: 1_048_576, max_output_tokens: 32_768, modalities: { input: ["text", "image"] }, pricing: { input_per_m: 0.56, output_per_m: 1.12 } },
          { id: "kokoro-82m", type: "tts" },
          { id: "embeddinggemma-300m", type: "embedding" },
        ],
      }),
    );
    const result = await discoverModels(provider({ baseURL: stub.url }), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((m) => m.id)).toEqual(["mimo-v2.6-pro"]);
    expect(result.models[0]).toMatchObject({ contextWindow: 1_048_576, maxOutput: 32_768, cost: { input: 0.56, output: 1.12 }, capabilities: { vision: true } });
  });

  it("pages anthropic listings with after_id and limit", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.includes("after_id=")) return send(res, 200, { data: [{ id: "claude-b", display_name: "B" }], has_more: false });
      return send(res, 200, { data: [{ id: "claude-a", display_name: "A" }], has_more: true, last_id: "claude-a" });
    });
    const result = await discoverModels(provider({ wireProtocol: "anthropic-messages", baseURL: stub.url, authStyle: "x-api-key" }), "sk-key");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(result.models[0]!.name).toBe("A");
    expect(stub.requests.find((r) => r.url.includes("after_id="))?.url).toBe("/v1/models?after_id=claude-a&limit=1000");
    expect(stub.requests[0]!.headers["x-api-key"]).toBe("sk-key");
    // Off api.anthropic.com the default is Bearer, as Claude sends it.
    await discoverModels(provider({ wireProtocol: "anthropic-messages", baseURL: stub.url }), "sk-key");
    expect(stub.requests.at(-1)!.headers.authorization).toBe("Bearer sk-key");
    expect(stub.requests.at(-1)!.headers["x-api-key"]).toBeUndefined();
  });

  it("keeps only generateContent gemini models and pages by token", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.includes("pageToken=")) {
        return send(res, 200, {
          models: [{ name: "models/gemini-c", displayName: "C", inputTokenLimit: 8_000, outputTokenLimit: 2_000, supportedGenerationMethods: ["generateContent"] }],
        });
      }
      return send(res, 200, {
        models: [
          {
            name: "models/gemini-a",
            displayName: "A",
            inputTokenLimit: 1_000_000,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          { name: "models/embedding-1", displayName: "Emb", supportedGenerationMethods: ["embedContent"] },
        ],
        nextPageToken: "tok",
      });
    });
    const result = await discoverModels(provider({ wireProtocol: "gemini", baseURL: stub.url }), "sk");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((m) => m.id)).toEqual(["gemini-a", "gemini-c"]);
    expect(result.models[0]!.contextWindow).toBe(1_000_000);
    expect(result.models[0]!.enriched).toBe(true);
    expect(stub.requests.find((r) => r.url.includes("pageToken="))?.url).toBe("/v1beta/models?pageToken=tok");
  });
});

describe("models.dev enrichment", () => {
  const catalog = {
    openrouter: {
      id: "openrouter",
      api: "https://openrouter.ai/api/v1",
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          tool_call: true,
          reasoning: false,
          attachment: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 128_000, output: 16_384 },
          cost: { input: 2.5, output: 10 },
        },
      },
    },
    local: {
      id: "local",
      api: "https://local.example.com",
      models: {
        llama: { id: "llama", tool_call: false, reasoning: true, attachment: false, limit: { context: 32_000, output: 4_000 } },
      },
    },
  };

  it("enriches by exact id and by the part after a slash", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/api.json")) return send(res, 200, catalog);
      if (req.url.startsWith("/models")) return send(res, 200, { data: [{ id: "gpt-4o" }, { id: "openai/llama" }] });
      return send(res, 404);
    });
    const modelsDev = new ModelsDev({ file: tempFile(), url: `${stub.url}/api.json` });
    const result = await discoverModels(provider({ baseURL: stub.url }), "sk", { modelsDev });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const gpt = result.models[0]!;
    expect(gpt.enriched).toBe(true);
    expect(gpt.contextWindow).toBe(128_000);
    expect(gpt.maxOutput).toBe(16_384);
    expect(gpt.capabilities).toEqual({ tools: true, vision: true, reasoning: false });
    expect(gpt.cost).toEqual({ input: 2.5, output: 10 });

    const llama = result.models[1]!;
    expect(llama.enriched).toBe(true);
    expect(llama.contextWindow).toBe(32_000);
    expect(llama.capabilities).toEqual({ tools: false, vision: false, reasoning: true });
  });

  it("prefers the models.dev provider whose api host matches the base URL", async () => {
    const hosts = {
      a: { api: "https://a.example.com", models: { shared: { id: "shared", tool_call: true, limit: { context: 1_000, output: 100 } } } },
      b: { api: "https://b.example.com", models: { shared: { id: "shared", tool_call: true, limit: { context: 2_000, output: 200 } } } },
    };
    const stub = await startStub((_req, res) => send(res, 200, hosts));
    const modelsDev = new ModelsDev({ file: tempFile(), url: `${stub.url}/api.json` });
    await modelsDev.load();
    expect(modelsDev.lookup("shared", "https://b.example.com")?.contextWindow).toBe(2_000);
    expect(modelsDev.lookup("shared", "https://a.example.com")?.contextWindow).toBe(1_000);
    expect(modelsDev.lookup("shared")?.contextWindow).toBe(1_000);
  });

  it("lets listing fields override models.dev", async () => {
    const mdCatalog = {
      p: {
        api: "https://p.example.com",
        models: { m: { id: "m", tool_call: false, attachment: true, reasoning: true, limit: { context: 999, output: 99 }, cost: { input: 5, output: 6 } } },
      },
    };
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/api.json")) return send(res, 200, mdCatalog);
      if (req.url.startsWith("/models")) {
        return send(res, 200, { data: [{ id: "m", context_length: 200_000, pricing: { prompt: "1", completion: "2" }, supported_parameters: ["tools"] }] });
      }
      return send(res, 404);
    });
    const modelsDev = new ModelsDev({ file: tempFile(), url: `${stub.url}/api.json` });
    const result = await discoverModels(provider({ baseURL: stub.url }), "sk", { modelsDev });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = result.models[0]!;
    expect(model.contextWindow).toBe(200_000); // listing wins
    expect(model.maxOutput).toBe(99); // listing has no output, models.dev wins
    expect(model.cost).toEqual({ input: 1e6, output: 2e6 }); // pricing strings are per token
    expect(model.capabilities.tools).toBe(true); // listing wins over models.dev false
    expect(model.capabilities.vision).toBe(true);
    expect(model.capabilities.reasoning).toBe(true);
    expect(model.enriched).toBe(true);
  });
});

describe("ModelsDev cache", () => {
  const body = (context: number): string =>
    JSON.stringify({ p: { models: { m: { id: "m", tool_call: true, limit: { context, output: 10 } } } } });

  it("uses a fresh cache file without fetching", async () => {
    const file = tempFile();
    writeFileSync(file, body(4_242));
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched++;
      throw new Error("should not fetch");
    }) as typeof fetch;
    const modelsDev = new ModelsDev({ file, url: "http://127.0.0.1:1/api.json", fetchImpl });
    await modelsDev.load();
    expect(fetched).toBe(0);
    expect(modelsDev.lookup("m")?.contextWindow).toBe(4_242);
  });

  it("refetches and rewrites a stale cache file", async () => {
    const file = tempFile();
    writeFileSync(file, body(1));
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(file, past, past);
    const stub = await startStub((_req, res) => send(res, 200, { p2: { models: { m: { id: "m", tool_call: true, limit: { context: 5_000, output: 50 } } } } }));
    const modelsDev = new ModelsDev({ file, url: `${stub.url}/api.json` });
    await modelsDev.load();
    expect(stub.requests.length).toBe(1);
    expect(modelsDev.lookup("m")?.contextWindow).toBe(5_000);
    expect(JSON.parse(readFileSync(file, "utf8")).p2).toBeTruthy();
  });

  it("falls back to a stale cache file when the fetch fails", async () => {
    const file = tempFile();
    writeFileSync(file, body(7_777));
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(file, past, past);
    const modelsDev = new ModelsDev({ file, url: "http://127.0.0.1:1/api.json" });
    await modelsDev.load();
    expect(modelsDev.lookup("m")?.contextWindow).toBe(7_777);
  });

  it("looks up nothing when there is no cache and the fetch fails, but discovery still succeeds", async () => {
    const stub = await startStub((req, res) => {
      if (req.url.startsWith("/models")) return send(res, 200, { data: [{ id: "m" }] });
      return send(res, 404);
    });
    const modelsDev = new ModelsDev({ file: tempFile(), url: "http://127.0.0.1:1/api.json" });
    const result = await discoverModels(provider({ baseURL: stub.url }), "sk", { modelsDev });
    expect(modelsDev.lookup("m")).toBeNull();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models[0]!.contextWindow).toBe(128_000);
    expect(result.models[0]!.enriched).toBe(false);
  });
});

describe("discoverModels errors", () => {
  it("reports a rejected key without echoing it", async () => {
    const stub = await startStub((_req, res) => send(res, 401, { error: "nope" }));
    const result = await discoverModels(provider({ baseURL: stub.url }), "sk-super-secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/rejected/);
    expect(result.error).toMatch(/401/);
    expect(result.error).not.toContain("sk-super-secret");
  });

  it("reports a 404 listing as one to fill in by hand", async () => {
    const stub = await startStub((_req, res) => send(res, 404, { error: "nope" }));
    const result = await discoverModels(provider({ baseURL: stub.url }), "sk");
    expect(result).toEqual({ ok: false, error: "This endpoint doesn't list models (HTTP 404); add models by hand." });
  });

  it("reports an unreadable listing shape", async () => {
    const stub = await startStub((_req, res) => send(res, 200, { unexpected: true }));
    const result = await discoverModels(provider({ baseURL: stub.url }), "sk");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/wasn't in a format/);
  });

  it("refuses a raw path provider with no listing", async () => {
    const result = await discoverModels(provider({ baseURL: "http://example.invalid", pathMode: "raw" }), "sk");
    expect(result).toEqual({ ok: false, error: "Raw path mode has no model listing; add models by hand." });
  });
});

describe("pickSmallModel", () => {
  it("picks the cheapest tool-capable model, breaking ties on output cost", () => {
    const models: DiscoveredModel[] = [
      dm("expensive", { input: 10, output: 1 }, true),
      dm("cheap-high-output", { input: 1, output: 9 }, true),
      dm("cheap-low-output", { input: 1, output: 2 }, true),
      dm("no-tools", { input: 0.1, output: 0.1 }, false),
      dm("no-cost", undefined, true),
    ];
    expect(pickSmallModel(models)).toBe("cheap-low-output");
  });

  it("is undefined without any tool-capable model that has a cost", () => {
    expect(pickSmallModel([dm("x", undefined, true), dm("y", { input: 1, output: 1 }, false)])).toBeUndefined();
    expect(pickSmallModel([])).toBeUndefined();
  });
});
