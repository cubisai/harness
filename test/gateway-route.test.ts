import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Provider } from "../src/shared/types";
import { createGateway, parseLlmPath } from "../src/main/gateway/route";
import { startToolServer } from "../src/main/mcp-http";
import { closeAfter } from "./helpers";

const KEY = "sk-upstream-test-key";

/** A chat-completions upstream that records requests and answers with the handler's chunks or status. */
async function fakeChat(answer: (body: Record<string, unknown>, res: ServerResponse) => void) {
  const requests: { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      answer(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closeAfter(() => void server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

function sseChunks(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
}

function provider(baseURL: string, over: Partial<Provider> = {}): Provider {
  return {
    id: "th",
    label: "TokenHarbor",
    wireProtocol: "openai-chat",
    baseURL,
    secret: { kind: "safeStorage", ciphertext: "opaque" },
    headers: { "x-literal": "yes" },
    models: [{ id: "flash", modelID: "deepseek-v4-flash", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 128_000, maxOutput: 8_192 }],
    ...over,
  };
}

async function gatewayServer(p: Provider, over: { bodyLimit?: number } = {}) {
  const server = await startToolServer(
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createGateway({ providers: () => [p], secret: () => KEY, secretHeaders: () => ({ "x-secret": "s3cret" }), env: {}, ...over }),
  );
  closeAfter(() => void server.close());
  return server;
}

/** The Anthropic SSE body as [event, data] pairs. */
function events(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") as Record<string, unknown>;
      return { event, data };
    });
}

const messagesBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "deepseek-v4-flash",
    max_tokens: 32_000,
    stream: true,
    system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "high" },
    metadata: { user_id: "u" },
    context_management: { edits: [] },
    ...over,
  });

describe("parseLlmPath", () => {
  it("splits /llm/<provider>/<rest> and rejects anything else", () => {
    expect(parseLlmPath("/llm/th/v1/messages")).toEqual({ providerId: "th", rest: "/v1/messages" });
    expect(parseLlmPath("/llm/th")).toEqual({ providerId: "th", rest: "/" });
    expect(parseLlmPath("/mcp")).toBeNull();
    expect(parseLlmPath("/llm/../x")).toBeNull();
  });
});

describe("translation gateway route", () => {
  it("keeps its token and the tool server's apart, and answers the connectivity check without one", async () => {
    const up = await fakeChat((_b, res) => sseChunks(res, []));
    const server = await gatewayServer(provider(up.url));
    expect(server.llmUrl).toMatch(/\/llm$/);
    expect(server.llmToken).not.toBe(server.token);
    expect((await fetch(`${server.llmUrl}/th/api/hello`, { method: "HEAD" })).status).toBe(200);
    const withMcpToken = await fetch(`${server.llmUrl}/th/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: messagesBody() });
    expect(withMcpToken.status).toBe(401);
    const mcpWithLlmToken = await fetch(server.url, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: "{}" });
    expect(mcpWithLlmToken.status).toBe(401);
    expect(up.requests).toEqual([]);
  });

  it("streams a chat-completions answer back as Anthropic events, with the key and headers added in main", async () => {
    const up = await fakeChat((_b, res) =>
      sseChunks(res, [
        { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Think." } }] },
        { choices: [{ index: 0, delta: { content: "Hel" } }] },
        { choices: [{ index: 0, delta: { content: "lo." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
      ]),
    );
    const server = await gatewayServer(provider(up.url));
    const res = await fetch(`${server.llmUrl}/th/v1/messages?beta=true`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: messagesBody() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const evs = events(await res.text());
    expect(evs.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(evs[9]!.data).toMatchObject({ delta: { stop_reason: "end_turn" }, usage: { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60 } });

    const sent = up.requests[0]!;
    expect(sent.url).toBe("/v1/chat/completions");
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.headers["x-literal"]).toBe("yes");
    expect(sent.headers["x-secret"]).toBe("s3cret");
    expect(sent.headers["anthropic-beta"]).toBeUndefined();
    expect(sent.body).toMatchObject({ model: "deepseek-v4-flash", max_tokens: 8_192, stream: true, reasoning_effort: "high", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] });
    for (const dropped of ["metadata", "thinking", "context_management", "output_config"]) expect(sent.body).not.toHaveProperty(dropped);
  });

  it("answers a non-streaming request with one Anthropic message", async () => {
    const up = await fakeChat((_b, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    });
    const server = await gatewayServer(provider(up.url));
    const res = await fetch(`${server.llmUrl}/th/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: messagesBody({ stream: false }) });
    expect(await res.json()).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } });
  });

  it("passes upstream errors on in Anthropic's shape with the key masked, and never as a 404", async () => {
    let status = 404;
    const up = await fakeChat((_b, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Model not found for key ${KEY}` } }));
    });
    const server = await gatewayServer(provider(up.url));
    const post = () => fetch(`${server.llmUrl}/th/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: messagesBody() });
    const notFound = await post();
    expect(notFound.status).toBe(400);
    const body = (await notFound.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("TokenHarbor: Model not found");
    expect(body.error.message).not.toContain(KEY);
    status = 429;
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { type: string } }).error.type).toBe("rate_limit_error");
  });

  it("ends a stream with an error event, and nothing after it, when the upstream fails mid-way", async () => {
    const up = await fakeChat((_b, res) => sseChunks(res, [{ choices: [{ index: 0, delta: { content: "Hi" } }] }, { error: { message: "upstream overloaded" } }]));
    const server = await gatewayServer(provider(up.url));
    const res = await fetch(`${server.llmUrl}/th/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: messagesBody() });
    const evs = events(await res.text());
    expect(evs.at(-1)).toMatchObject({ event: "error", data: { type: "error", error: { message: "TokenHarbor: upstream overloaded." } } });
    expect(evs.some((e) => e.event === "message_stop")).toBe(false);
  });

  it("refuses an oversized body, an unknown provider and a protocol it doesn't translate", async () => {
    const up = await fakeChat((_b, res) => sseChunks(res, []));
    const big = await gatewayServer(provider(up.url), { bodyLimit: 1_000 });
    const auth = { authorization: `Bearer ${big.llmToken}` };
    expect((await fetch(`${big.llmUrl}/th/v1/messages`, { method: "POST", headers: auth, body: messagesBody({ messages: [{ role: "user", content: "x".repeat(5_000) }] }) })).status).toBe(413);
    expect((await fetch(`${big.llmUrl}/gone/v1/messages`, { method: "POST", headers: auth, body: messagesBody() })).status).toBe(400);
    const anthropic = await gatewayServer(provider(up.url, { wireProtocol: "anthropic-messages" }));
    expect((await fetch(`${anthropic.llmUrl}/th/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${anthropic.llmToken}` }, body: messagesBody() })).status).toBe(400);
    expect(up.requests).toEqual([]);
  });
});

describe("translation gateway route for Codex (/v1/responses)", () => {
  const responsesBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ model: "deepseek-v4-flash", instructions: "Be brief.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], tools: [], stream: true, store: false, include: ["reasoning.encrypted_content"], prompt_cache_key: "k", ...over });

  it("streams a chat-completions answer back as Responses events", async () => {
    const up = await fakeChat((_b, res) =>
      sseChunks(res, [
        { choices: [{ index: 0, delta: { content: "Hello." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
      ]),
    );
    const server = await gatewayServer(provider(up.url));
    const res = await fetch(`${server.llmUrl}/th/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: responsesBody() });
    expect(res.status).toBe(200);
    const evs = events(await res.text());
    expect(evs[0]!.event).toBe("response.created");
    expect(evs.some((e) => e.event === "response.output_text.delta")).toBe(true);
    expect(evs.at(-1)).toMatchObject({ event: "response.completed", data: { response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } } });
    const sent = up.requests[0]!;
    expect(sent.url).toBe("/v1/chat/completions");
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.body).toMatchObject({ model: "deepseek-v4-flash", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] });
    for (const dropped of ["store", "include", "prompt_cache_key"]) expect(sent.body).not.toHaveProperty(dropped);
  });

  it("passes a Responses provider's stream through untouched, with the key added in main", async () => {
    const raw = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n';
    const up = await fakeChat((_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(raw);
    });
    const server = await gatewayServer(provider(up.url, { wireProtocol: "openai-responses" }));
    const res = await fetch(`${server.llmUrl}/th/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: responsesBody() });
    expect(await res.text()).toBe(raw);
    expect(up.requests[0]!.url).toBe("/v1/responses");
    expect(up.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(up.requests[0]!.body).toMatchObject({ model: "deepseek-v4-flash", store: false, prompt_cache_key: "k" });
  });

  it("answers errors in OpenAI's shape, never as a 404, and refuses Anthropic providers for Codex", async () => {
    const up = await fakeChat((_b, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no such model" } }));
    });
    const server = await gatewayServer(provider(up.url));
    const res = await fetch(`${server.llmUrl}/th/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: responsesBody() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: "TokenHarbor: no such model.", type: "invalid_request_error" } });
    const anthropic = await gatewayServer(provider(up.url, { wireProtocol: "anthropic-messages" }));
    const refused = await fetch(`${anthropic.llmUrl}/th/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${anthropic.llmToken}` }, body: responsesBody() });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/doesn't translate for Codex/);
  });
});

describe("translation gateway aborts", () => {
  it("cancels the upstream request when the agent hangs up mid-stream", async () => {
    let upstreamClosed: () => void = () => {};
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const up = await fakeChat((_b, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`);
      // Never finishes: only the gateway's abort ends it.
      res.on("close", () => upstreamClosed());
    });
    const server = await gatewayServer(provider(up.url));
    const client = new AbortController();
    const res = await fetch(`${server.llmUrl}/th/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${server.llmToken}` }, body: messagesBody(), signal: client.signal });
    const reader = res.body!.getReader();
    await reader.read(); // the first events arrived
    client.abort();
    await expect(Promise.race([closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("still open"), 3_000))])).resolves.toBe("closed");
  });
});
