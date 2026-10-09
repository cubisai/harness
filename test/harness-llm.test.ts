import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Provider } from "../src/shared/types";
import { PROTOCOLS, adaptiveThinking, generate, routeFor, streamLlm, type LlmEvent, type LlmMessage, type LlmRequest, LlmError } from "../src/main/harness/llm";
import { closeAfter } from "./helpers";

const KEY = "sk-harness-test-key";

function provider(baseURL: string, over: Partial<Provider> = {}): Provider {
  return { id: "th", label: "TokenHarbor", wireProtocol: "openai-chat", baseURL, secret: { kind: "safeStorage", ciphertext: "opaque" }, models: [], ...over };
}

const history: LlmMessage[] = [
  { role: "user", content: [{ type: "text", text: "list files" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I should look.", replay: { protocol: "anthropic-messages", data: { type: "thinking", thinking: "I should look.", signature: "sig1" } } },
      { type: "text", text: "Looking." },
      { type: "tool-call", id: "call_1", name: "glob", input: { pattern: "*" } },
    ],
  },
  { role: "tool", results: [{ callId: "call_1", name: "glob", text: "a.ts\nb.ts", imagePng: "iVBORw0" }] },
];

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "m",
  system: ["You are CubiQ.", "Project rules."],
  messages: history,
  tools: [
    { name: "glob", description: "Find files", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
    { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ],
  ...over,
});

/** Feed SSE data payloads through a protocol's stepper and collect the events. */
function run(protocol: keyof typeof PROTOCOLS, payloads: unknown[]): LlmEvent[] {
  const s = PROTOCOLS[protocol].stepper();
  return [...payloads.flatMap((p) => s.push(typeof p === "string" ? p : JSON.stringify(p))), ...s.end()];
}
const finish = (events: LlmEvent[]) => events.at(-1) as Extract<LlmEvent, { type: "finish" }>;

describe("openai-chat", () => {
  it("lowers system, tool calls, reasoning and tool results (images in a follow-up user message)", () => {
    const body = PROTOCOLS["openai-chat"].body(request());
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: "system", content: "You are CubiQ.\n\nProject rules." });
    expect(messages[1]).toEqual({ role: "user", content: "list files" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "Looking.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } }],
      reasoning_content: "I should look.",
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "a.ts\nb.ts" });
    expect(messages[4]).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0" } }] });
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(PROTOCOLS["openai-chat"].body(request({ reasoning: true, effort: "high" })).reasoning_effort).toBe("high");
  });

  it("streams reasoning, text and split tool-call arguments into one message", () => {
    const events = run("openai-chat", [
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } },
      "[DONE]",
    ]);
    expect(events.filter((e) => e.type === "text-delta")).toEqual([{ type: "text-delta", text: "Hi" }]);
    expect(events.filter((e) => e.type === "tool-input-delta")).toHaveLength(2);
    const f = finish(events);
    expect(f.reason).toBe("tool-calls");
    expect(f.message).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "Hi" },
      { type: "tool-call", id: "c1", name: "read", input: { path: "a" } },
    ]);
    expect(f.usage).toMatchObject({ inputTokens: 40, cacheReadTokens: 60, outputTokens: 20 });
  });

  it("keeps invalid tool arguments for the loop to report, and reads DeepSeek's cache field", () => {
    const f = finish(
      run("openai-chat", [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{oops" } }] } }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 4 } },
      ]),
    );
    expect(f.message[0]).toEqual({ type: "tool-call", id: "c1", name: "read", input: {}, invalidInput: "{oops" });
    expect(f.usage.cacheReadTokens).toBe(4);
  });

  it("turns an error chunk into an LlmError", () => {
    expect(() => run("openai-chat", [{ error: { message: "This model's maximum context length is 8192 tokens" } }])).toThrow(LlmError);
    try {
      run("openai-chat", [{ error: { message: "This model's maximum context length is 8192 tokens" } }]);
    } catch (e) {
      expect((e as LlmError).kind).toBe("overflow");
    }
  });
});

describe("openai-responses", () => {
  it("is stateless, non-strict, and replays only Responses reasoning items", () => {
    const req = request({
      reasoning: true,
      effort: "medium",
      cacheKey: "thread-1",
      messages: [
        history[0]!,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "sum", replay: { protocol: "openai-responses", data: { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] } } },
            { type: "reasoning", text: "other protocol", replay: { protocol: "anthropic-messages", data: { type: "thinking" } } },
            { type: "tool-call", id: "call_1", name: "glob", input: {} },
          ],
        },
        { role: "tool", results: [{ callId: "call_1", name: "glob", text: "boom", isError: true }] },
      ],
    });
    const body = PROTOCOLS["openai-responses"].body(req);
    expect(body).toMatchObject({ store: false, stream: true, instructions: "You are CubiQ.\n\nProject rules.", prompt_cache_key: "thread-1", include: ["reasoning.encrypted_content"], reasoning: { effort: "medium", summary: "auto" } });
    expect((body.tools as Record<string, unknown>[])[0]).toMatchObject({ type: "function", name: "glob", strict: false });
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] },
      { type: "function_call", call_id: "call_1", name: "glob", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "Error: boom" },
    ]);
    const plain = PROTOCOLS["openai-responses"].body(request());
    expect(plain).not.toHaveProperty("include");
    expect(plain).not.toHaveProperty("reasoning");
  });

  it("builds the message from finished items and keeps the reasoning item for replay", () => {
    const events = run("openai-responses", [
      { type: "response.reasoning_summary_text.delta", delta: "plan" },
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs_9", status: "completed", encrypted_content: "E", summary: [{ type: "summary_text", text: "plan" }] } },
      { type: "response.output_text.delta", delta: "Done" },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Done" }] } },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"x"}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read", arguments: '{"path":"x"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 4 } } } },
    ]);
    expect(events.find((e) => e.type === "tool-input-delta")).toEqual({ type: "tool-input-delta", id: "call_9", name: "read", delta: '{"path":"x"}' });
    const f = finish(events);
    expect(f.reason).toBe("tool-calls");
    expect(f.message).toEqual([
      { type: "reasoning", text: "plan", replay: { protocol: "openai-responses", data: { type: "reasoning", id: "rs_9", encrypted_content: "E", summary: [{ type: "summary_text", text: "plan" }] } } },
      { type: "text", text: "Done" },
      { type: "tool-call", id: "call_9", name: "read", input: { path: "x" } },
    ]);
    expect(f.usage).toEqual({ inputTokens: 20, outputTokens: 9, cacheReadTokens: 30, cacheWriteTokens: null, reasoningTokens: 4 });
  });

  it("reports a cut-off answer as length, and keeps delta text when no message item arrives", () => {
    const f = finish(run("openai-responses", [{ type: "response.output_text.delta", delta: "partial" }, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]));
    expect(f.reason).toBe("length");
    expect(f.message).toEqual([{ type: "text", text: "partial" }]);
  });
});

describe("anthropic-messages", () => {
  it("marks three cache breakpoints and replays thinking verbatim", () => {
    const body = PROTOCOLS["anthropic-messages"].body(request());
    const tools = body.tools as Record<string, unknown>[];
    const system = body.system as Record<string, unknown>[];
    const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]).toMatchObject({ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } });
    expect(system).toEqual([{ type: "text", text: "You are CubiQ." }, { type: "text", text: "Project rules.", cache_control: { type: "ephemeral" } }]);
    expect(messages[1]!.content).toEqual([
      { type: "thinking", thinking: "I should look.", signature: "sig1" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "call_1", name: "glob", input: { pattern: "*" } },
    ]);
    const results = messages[2]!;
    expect(results.role).toBe("user");
    expect(results.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1", cache_control: { type: "ephemeral" } });
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3);
    expect(JSON.stringify(PROTOCOLS["anthropic-messages"].body(request({ cache: "none" })))).not.toContain("cache_control");
  });

  it("drops reasoning it can't replay and an assistant turn left empty", () => {
    const body = PROTOCOLS["anthropic-messages"].body(request({ messages: [history[0]!, { role: "assistant", content: [{ type: "reasoning", text: "unsigned" }] }, { role: "user", content: [{ type: "text", text: "again" }] }] }));
    expect((body.messages as unknown[]).map((m) => (m as { role: string }).role)).toEqual(["user", "user"]);
  });

  it("thinks adaptively on Claude 4.6+ and with a budget elsewhere", () => {
    expect(PROTOCOLS["anthropic-messages"].body(request({ model: "claude-sonnet-5-5", reasoning: true, effort: "high" }))).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } });
    const older = PROTOCOLS["anthropic-messages"].body(request({ model: "claude-haiku-4-5", reasoning: true, effort: "medium", maxTokens: 4000 }));
    expect(older.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(older.max_tokens).toBe(8192 + 4096);
    expect(older).not.toHaveProperty("output_config");
    expect(PROTOCOLS["anthropic-messages"].body(request({ model: "claude-opus-5-5" }))).not.toHaveProperty("thinking");
    expect([adaptiveThinking("claude-opus-4-6"), adaptiveThinking("anthropic/claude-sonnet-4.6"), adaptiveThinking("claude-opus-5-5"), adaptiveThinking("claude-fable-5-1")]).toEqual([true, true, true, true]);
    expect([adaptiveThinking("claude-sonnet-4-5-20250929"), adaptiveThinking("claude-opus-4-20250514"), adaptiveThinking("claude-3-7-sonnet-latest"), adaptiveThinking("MiniMax-M2")]).toEqual([false, false, false, false]);
  });

  it("streams thinking with its signature, text and a tool call", () => {
    const events = run("anthropic-messages", [
      { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "On it." } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ]);
    expect(events.filter((e) => e.type === "reasoning-delta")).toEqual([{ type: "reasoning-delta", text: "hmm" }]);
    const f = finish(events);
    expect(f.reason).toBe("tool-calls");
    expect(f.message).toEqual([
      { type: "reasoning", text: "hmm", replay: { protocol: "anthropic-messages", data: { type: "thinking", thinking: "hmm", signature: "SIG" } } },
      { type: "text", text: "On it." },
      { type: "tool-call", id: "toolu_1", name: "read", input: { path: "a.ts" } },
    ]);
    expect(f.usage).toEqual({ inputTokens: 12, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 40, reasoningTokens: null });
  });

  it("maps an overloaded error event to a transient LlmError", () => {
    try {
      run("anthropic-messages", [{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).kind).toBe("transient");
    }
  });
});

/** A local upstream answering each request with the next handler. */
async function upstream(handlers: ((req: IncomingMessage, body: string, res: ServerResponse) => void)[]) {
  const seen: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: raw });
      const h = handlers[Math.min(seen.length - 1, handlers.length - 1)]!;
      h(req, raw, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closeAfter(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

const sse = (res: ServerResponse, payloads: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join(""));
};
const okChat = (res: ServerResponse) => sse(res, [{ choices: [{ delta: { content: "pong" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
const noSleep = async () => {};
const chatRequest = (): LlmRequest => ({ model: "deepseek-v4", system: [], messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [] });

describe("client", () => {
  it("routes each protocol to its path with its auth, env-ref and secret headers", () => {
    const p = provider("https://tokenharbor.ai/v1", { headers: { "x-org": "${env:TH_ORG}", "x-missing": "${env:NOPE}", "X-Team": "plain" } });
    const chat = routeFor(p, "openai-chat", "m", KEY, { "x-team": "secret" }, { TH_ORG: "org-1" });
    expect(chat.url).toBe("https://tokenharbor.ai/v1/chat/completions");
    expect(chat.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "x-org": "org-1", "x-team": "secret" });
    expect(chat.headers).not.toHaveProperty("x-missing");
    expect(chat.headers).not.toHaveProperty("X-Team");
    expect(routeFor(p, "openai-responses", "m", KEY).url).toBe("https://tokenharbor.ai/v1/responses");
    const messages = routeFor(p, "anthropic-messages", "m", KEY);
    expect(messages.url).toBe("https://tokenharbor.ai/v1/messages");
    expect(messages.headers).toMatchObject({ "anthropic-version": "2023-06-01", Authorization: `Bearer ${KEY}` });
    expect(routeFor(provider("https://api.anthropic.com"), "anthropic-messages", "m", KEY).headers["x-api-key"]).toBe(KEY);
  });

  it("retries a transient failure before any output, then streams", async () => {
    const up = await upstream([(_q, _b, res) => res.writeHead(503).end('{"error":{"message":"busy"}}'), (_q, _b, res) => okChat(res)]);
    const result = await generate(routeFor(provider(up.base), "openai-chat", "deepseek-v4", KEY), chatRequest(), { sleep: noSleep });
    expect(result.text).toBe("pong");
    expect(up.seen).toHaveLength(2);
    expect(JSON.parse(up.seen[0]!.body)).toMatchObject({ model: "deepseek-v4", stream: true });
    expect(up.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("never retries once output was seen", async () => {
    const up = await upstream([(_q, _b, res) => sse(res, [{ choices: [{ delta: { content: "half" } }] }, { error: { message: "server_error", code: "server_error" } }]), (_q, _b, res) => okChat(res)]);
    const events: LlmEvent[] = [];
    await expect(
      (async () => {
        for await (const e of streamLlm(routeFor(provider(up.base), "openai-chat", "m", KEY), chatRequest(), { sleep: noSleep })) events.push(e);
      })(),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(events).toEqual([{ type: "text-delta", text: "half" }]);
    expect(up.seen).toHaveLength(1);
  });

  it("classifies auth and overflow without retrying, with the key masked", async () => {
    const up = await upstream([
      (_q, _b, res) => res.writeHead(401).end(JSON.stringify({ error: { message: `bad key ${KEY}` } })),
      (_q, _b, res) => res.writeHead(400).end(JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens." } })),
    ]);
    const route = routeFor(provider(up.base), "openai-chat", "m", KEY);
    const auth = await generate(route, chatRequest(), { sleep: noSleep }).catch((e: LlmError) => e);
    expect(auth).toMatchObject({ kind: "auth", status: 401 });
    expect((auth as LlmError).message).not.toContain(KEY);
    expect((auth as LlmError).message).toContain("TokenHarbor");
    await expect(generate(route, chatRequest(), { sleep: noSleep })).rejects.toMatchObject({ kind: "overflow" });
    expect(up.seen).toHaveLength(2);
  });

  it("gives up on a silent stream and stops on abort", async () => {
    const up = await upstream([(_q, _b, res) => res.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders()]);
    const route = routeFor(provider(up.base), "openai-chat", "m", KEY);
    await expect(generate(route, chatRequest(), { idleTimeoutMs: 100, retries: 0 })).rejects.toMatchObject({ kind: "transient" });
    const abort = new AbortController();
    const pending = generate(route, chatRequest(), { signal: abort.signal, retries: 0 });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });
});
