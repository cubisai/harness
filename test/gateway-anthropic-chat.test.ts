import { describe, expect, it } from "vitest";
import {
  ChatToAnthropicStream,
  anthropicToChat,
  chatToAnthropicMessage,
  type AnthropicRequest,
} from "../src/main/gateway/anthropic-chat";
import { createSseParser } from "../src/main/gateway/chat-stream";

interface SseEvent {
  event: string;
  data: any;
}

/** Parse the SSE text a stream translator returns back into {event, data} pairs. */
function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) data = line.slice("data:".length).trim();
      }
      return { event, data: data.length > 0 ? JSON.parse(data) : null };
    });
}

const names = (events: SseEvent[]): string[] => events.map((event) => event.event);
const opts = { model: "up-model", reasoning: false };

describe("createSseParser", () => {
  it("reassembles events and lines split across pushes", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: hel");
    parser.push("lo\n\ndata: wor");
    parser.push("ld\n\n");
    expect(events).toEqual(["hello", "world"]);
  });

  it("handles CRLF line endings", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: a\r\n\r\ndata: b\r\n\r\n");
    expect(events).toEqual(["a", "b"]);
  });

  it("ignores comment lines", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push(": keep-alive\n\ndata: x\n\n");
    expect(events).toEqual(["x"]);
  });

  it("joins multi-line data with a newline", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: one\ndata: two\n\n");
    expect(events).toEqual(["one\ntwo"]);
  });

  it("passes [DONE] through unchanged", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: [DONE]\n\n");
    expect(events).toEqual(["[DONE]"]);
  });

  it("ignores event, id and retry fields", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("event: ping\nid: 5\nretry: 100\ndata: v\n\n");
    expect(events).toEqual(["v"]);
  });

  it("flushes a final event with no trailing blank line on end()", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: last");
    parser.end();
    expect(events).toEqual(["last"]);
  });

  it("does not re-emit an already terminated event on end()", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: a\n\n");
    parser.end();
    expect(events).toEqual(["a"]);
  });
});

describe("anthropicToChat — plumbing", () => {
  it("joins system text blocks with a blank line into the first message", () => {
    const chat = anthropicToChat(
      { system: [{ type: "text", text: "A" }, { type: "text", text: "B" }], messages: [] },
      opts,
    );
    expect(chat.messages[0]).toEqual({ role: "system", content: "A\n\nB" });
  });

  it("keeps a string system prompt", () => {
    const chat = anthropicToChat({ system: "S", messages: [] }, opts);
    expect(chat.messages[0]).toEqual({ role: "system", content: "S" });
  });

  it("omits the system message when empty", () => {
    expect(anthropicToChat({ messages: [] }, opts).messages).toEqual([]);
  });

  it("maps a plain user string", () => {
    const chat = anthropicToChat({ messages: [{ role: "user", content: "hi" }] }, opts);
    expect(chat.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("always uses opts.model and never the request model", () => {
    const chat = anthropicToChat({ model: "claude-3", messages: [] }, opts);
    expect(chat.model).toBe("up-model");
  });

  it("clamps max_tokens to maxOutput", () => {
    expect(anthropicToChat({ max_tokens: 5000, messages: [] }, { ...opts, maxOutput: 1000 }).max_tokens).toBe(1000);
    expect(anthropicToChat({ max_tokens: 500, messages: [] }, { ...opts, maxOutput: 1000 }).max_tokens).toBe(500);
    expect(anthropicToChat({ messages: [] }, opts).max_tokens).toBeUndefined();
  });

  it("copies temperature, top_p and stop_sequences", () => {
    const chat = anthropicToChat({ temperature: 0.5, top_p: 0.9, stop_sequences: ["a", "b"], messages: [] }, opts);
    expect(chat.temperature).toBe(0.5);
    expect(chat.top_p).toBe(0.9);
    expect(chat.stop).toEqual(["a", "b"]);
  });

  it("only sets stream_options when streaming", () => {
    const streaming = anthropicToChat({ stream: true, messages: [] }, opts);
    expect(streaming.stream).toBe(true);
    expect(streaming.stream_options).toEqual({ include_usage: true });

    const once = anthropicToChat({ messages: [] }, opts);
    expect(once.stream).toBe(false);
    expect(once.stream_options).toBeUndefined();
  });
});

describe("anthropicToChat — user content", () => {
  it("emits tool_result before the remaining user text", () => {
    const chat = anthropicToChat(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "result text" },
              { type: "text", text: "now continue" },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([
      { role: "tool", tool_call_id: "tu_1", content: "result text" },
      { role: "user", content: "now continue" },
    ]);
  });

  it("joins block content and prefixes errors", () => {
    const chat = anthropicToChat(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_2",
                is_error: true,
                content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
              },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([{ role: "tool", tool_call_id: "tu_2", content: "Error: line1\nline2" }]);
  });

  it("adds an extra user image message after tool messages", () => {
    const chat = anthropicToChat(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_3",
                content: [
                  { type: "text", text: "see" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
                ],
              },
              { type: "text", text: "thanks" },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([
      { role: "tool", tool_call_id: "tu_3", content: "see" },
      {
        role: "user",
        content: [
          { type: "text", text: "Image(s) from tool result tu_3:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
      { role: "user", content: "thanks" },
    ]);
  });

  it("maps base64 and url images into one content array", () => {
    const chat = anthropicToChat(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZ" } },
              { type: "image", source: { type: "url", url: "https://x/y.png" } },
              { type: "text", text: "caption" },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZZ" } },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
      { type: "text", text: "caption" },
    ]);
  });

  it("uses a plain string for a single text block", () => {
    const chat = anthropicToChat(
      { messages: [{ role: "user", content: [{ type: "text", text: "solo" }] }] },
      opts,
    );
    expect(chat.messages[0]).toEqual({ role: "user", content: "solo" });
  });
});

describe("anthropicToChat — assistant content", () => {
  it("maps text, tool_use and thinking", () => {
    const chat = anthropicToChat(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reason" },
              { type: "text", text: "hello" },
              { type: "tool_use", id: "tu_9", name: "do", input: { a: 1 } },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages[0]).toEqual({
      role: "assistant",
      content: "hello",
      reasoning_content: "reason",
      tool_calls: [{ id: "tu_9", type: "function", function: { name: "do", arguments: '{"a":1}' } }],
    });
  });

  it("sets content to null when only tools are present", () => {
    const chat = anthropicToChat(
      { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: {} }] }] },
      opts,
    );
    expect(chat.messages[0]?.content).toBeNull();
    expect(chat.messages[0]?.tool_calls).toEqual([{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }]);
  });

  it("keeps an assistant string as-is", () => {
    const chat = anthropicToChat({ messages: [{ role: "assistant", content: "plain" }] }, opts);
    expect(chat.messages[0]).toEqual({ role: "assistant", content: "plain" });
  });

  it("drops redacted_thinking and unknown block types", () => {
    const chat = anthropicToChat(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "xx" },
              { type: "document", source: { type: "url" } },
              { type: "text", text: "kept" },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages[0]).toEqual({ role: "assistant", content: "kept" });
  });
});

describe("anthropicToChat — tools and choice", () => {
  it("keeps function tools and drops server tools", () => {
    const chat = anthropicToChat(
      {
        tools: [
          { name: "local", description: "d", input_schema: { type: "object" } },
          { name: "custom", type: "custom", input_schema: {} },
          { name: "web", type: "web_search_20250305" },
        ],
        messages: [],
      },
      opts,
    );
    expect(chat.tools?.map((tool) => tool.function.name)).toEqual(["local", "custom"]);
    expect(chat.tools?.[0]).toEqual({
      type: "function",
      function: { name: "local", description: "d", parameters: { type: "object" } },
    });
  });

  it("omits tools when none remain", () => {
    const chat = anthropicToChat({ tools: [{ name: "web", type: "web_search_20250305" }], messages: [] }, opts);
    expect(chat.tools).toBeUndefined();
    expect(chat.tool_choice).toBeUndefined();
    expect(chat.parallel_tool_calls).toBeUndefined();
  });

  it("maps tool_choice variants and disable_parallel_tool_use", () => {
    const tool = [{ name: "t", input_schema: {} }];
    expect(anthropicToChat({ tools: tool, tool_choice: { type: "auto" }, messages: [] }, opts).tool_choice).toBe("auto");
    expect(anthropicToChat({ tools: tool, tool_choice: { type: "any" }, messages: [] }, opts).tool_choice).toBe("required");
    expect(anthropicToChat({ tools: tool, tool_choice: { type: "none" }, messages: [] }, opts).tool_choice).toBe("none");
    expect(
      anthropicToChat({ tools: tool, tool_choice: { type: "tool", name: "t" }, messages: [] }, opts).tool_choice,
    ).toEqual({ type: "function", function: { name: "t" } });
    const parallel = anthropicToChat(
      { tools: tool, tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages: [] },
      opts,
    );
    expect(parallel.parallel_tool_calls).toBe(false);
  });
});

describe("anthropicToChat — reasoning", () => {
  it("maps effort only when reasoning is on and thinking is enabled/adaptive", () => {
    const withThinking = (effort?: string, type = "enabled") =>
      anthropicToChat(
        { thinking: { type }, output_config: effort === undefined ? {} : { effort }, messages: [] },
        { ...opts, reasoning: true },
      ).reasoning_effort;

    expect(withThinking("max")).toBe("high");
    expect(withThinking("xhigh")).toBe("high");
    expect(withThinking("low")).toBe("low");
    expect(withThinking("high")).toBe("high");
    expect(withThinking(undefined)).toBe("medium");
    expect(withThinking("weird")).toBe("medium");
    expect(withThinking("low", "adaptive")).toBe("low");
    expect(withThinking("low", "disabled")).toBeUndefined();
  });

  it("never sends reasoning_effort when reasoning is off or thinking is missing", () => {
    expect(
      anthropicToChat({ thinking: { type: "enabled" }, messages: [] }, { ...opts, reasoning: false }).reasoning_effort,
    ).toBeUndefined();
    expect(anthropicToChat({ messages: [] }, { ...opts, reasoning: true }).reasoning_effort).toBeUndefined();
  });
});

describe("anthropicToChat — dropped fields", () => {
  it("never forwards Anthropic-only fields", () => {
    const chat = anthropicToChat(
      {
        model: "claude-x",
        metadata: { user_id: "u" },
        thinking: { type: "enabled", budget_tokens: 1000 },
        output_config: { effort: "high" },
        context_management: { foo: 1 },
        safeguards: { bar: 2 },
        top_k: 5,
        system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hi" }],
      } as AnthropicRequest,
      { ...opts, reasoning: true },
    );
    for (const key of ["metadata", "thinking", "output_config", "context_management", "safeguards", "top_k", "cache_control"]) {
      expect(key in chat).toBe(false);
    }
    expect(chat.reasoning_effort).toBe("high");
  });
});

describe("ChatToAnthropicStream", () => {
  it("emits an exact event sequence for text", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_1" });
    let text = stream.push({ choices: [{ delta: { content: "Hello" } }] });
    expect(stream.push({ choices: [{ delta: {} }] })).toBe("");
    text += stream.push({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] });
    text += stream.finish();
    const events = parseSse(text);

    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]!.data.message).toMatchObject({
      id: "msg_1",
      model: "m",
      role: "assistant",
      content: [],
      stop_reason: null,
    });
    expect(events[1]!.data.index).toBe(0);
    expect(events[1]!.data.content_block).toEqual({ type: "text", text: "" });
    expect(events[2]!.data.delta).toEqual({ type: "text_delta", text: "Hello" });
    expect(events[3]!.data.delta).toEqual({ type: "text_delta", text: " world" });
    expect(events[4]!.data.index).toBe(0);
    expect(events[5]!.data.delta.stop_reason).toBe("end_turn");
    expect(events[5]!.data.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("closes a thinking block with a signature before text starts", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_2" });
    let text = stream.push({ choices: [{ delta: { reasoning_content: "hmm" } }] });
    text += stream.push({ choices: [{ delta: { content: "answer" } }] });
    text += stream.finish();
    const events = parseSse(text);

    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]!.data.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
    expect(events[2]!.data.delta).toEqual({ type: "thinking_delta", thinking: "hmm" });
    expect(events[3]!.data.delta).toEqual({ type: "signature_delta", signature: "cubiq-gateway" });
    expect(events[4]!.data.index).toBe(0);
    expect(events[5]!.data.index).toBe(1);
    expect(events[5]!.data.content_block).toEqual({ type: "text", text: "" });
    expect(events[6]!.data.delta).toEqual({ type: "text_delta", text: "answer" });
  });

  it("buffers fragmented parallel tool calls and emits them in index order at finish", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_3" });
    let text = stream.push({
      choices: [{ delta: { tool_calls: [{ index: 1, id: "toolu_2", function: { name: "get_time", arguments: "{}" } }] } }],
    });
    text += stream.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_1", function: { name: "get_weather" } }] } }],
    });
    text += stream.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }],
    });
    text += stream.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] }, finish_reason: "tool_calls" }],
    });
    text += stream.finish();
    const events = parseSse(text);

    expect(events.filter((event) => event.event === "content_block_start")).toHaveLength(2);
    const starts = events.filter((event) => event.event === "content_block_start");
    expect(starts[0]!.data.content_block).toMatchObject({
      type: "tool_use",
      id: "toolu_1",
      name: "get_weather",
      input: {},
    });
    expect(starts[0]!.data.index).toBe(0);
    expect(starts[1]!.data.content_block).toMatchObject({ type: "tool_use", id: "toolu_2", name: "get_time" });
    expect(starts[1]!.data.index).toBe(1);

    const deltas = events.filter((event) => event.event === "content_block_delta");
    expect(deltas[0]!.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"city":"SF"}' });
    expect(deltas[1]!.data.delta).toEqual({ type: "input_json_delta", partial_json: "{}" });

    const final = events.find((event) => event.event === "message_delta");
    expect(final!.data.delta.stop_reason).toBe("tool_use");
  });

  it("falls back to a generated tool call id", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_x" });
    let text = stream.push({ choices: [{ delta: { tool_calls: [{ function: { name: "f", arguments: "{}" } }] } }] });
    text += stream.finish();
    const start = parseSse(text).find((event) => event.event === "content_block_start");
    expect(start!.data.content_block.id).toBe("call_msg_x_0");
  });

  it("maps finish_reason length to max_tokens", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_4" });
    let text = stream.push({ choices: [{ delta: { content: "x" } }] });
    text += stream.push({ choices: [{ delta: {}, finish_reason: "length" }] });
    text += stream.finish();
    const final = parseSse(text).find((event) => event.event === "message_delta");
    expect(final!.data.delta.stop_reason).toBe("max_tokens");
  });

  it("forgets an end_turn reason when tool calls were buffered", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_5" });
    let text = stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "f", arguments: "{}" } }] } }] });
    text += stream.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
    text += stream.finish();
    const final = parseSse(text).find((event) => event.event === "message_delta");
    expect(final!.data.delta.stop_reason).toBe("tool_use");
  });

  it("uses OpenAI cached_tokens and excludes them from input_tokens", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_6" });
    let text = stream.push({ choices: [{ delta: { content: "x" } }] });
    text += stream.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } });
    text += stream.finish();
    const final = parseSse(text).find((event) => event.event === "message_delta");
    expect(final!.data.usage).toEqual({ input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30 });
  });

  it("uses DeepSeek prompt_cache_hit_tokens", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_7" });
    let text = stream.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 } });
    text += stream.finish();
    const final = parseSse(text).find((event) => event.event === "message_delta");
    expect(final!.data.usage).toEqual({ input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 });
  });

  it("starts the message on finish when nothing was pushed", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_8" });
    const events = parseSse(stream.finish());
    expect(names(events)[0]).toBe("message_start");
    expect(names(events).at(-1)).toBe("message_stop");
  });

  it("is idempotent and ignores pushes after finish", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_9" });
    stream.push({ choices: [{ delta: { content: "x" } }] });
    const first = stream.finish();
    expect(first.length).toBeGreaterThan(0);
    expect(stream.finish()).toBe("");
    expect(stream.push({ choices: [{ delta: { content: "y" } }] })).toBe("");
  });

  it("ignores non-object chunks and streams from a later valid one", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_10" });
    expect(stream.push(null)).toBe("");
    expect(stream.push("nope")).toBe("");
    expect(stream.push(42)).toBe("");
    const events = parseSse(stream.push({ choices: [{ delta: { content: "ok" } }] }));
    expect(events[0]!.event).toBe("message_start");
  });

  it("formats error events", () => {
    const stream = new ChatToAnthropicStream({ model: "m", messageId: "msg_11" });
    const events = parseSse(stream.error("boom"));
    expect(events).toEqual([{ event: "error", data: { type: "error", error: { type: "api_error", message: "boom" } } }]);
  });
});

describe("chatToAnthropicMessage", () => {
  it("maps thinking, text and tool_use, tolerating bad JSON", () => {
    const message = chatToAnthropicMessage(
      {
        choices: [
          {
            message: {
              content: "hi",
              reasoning_content: "why",
              tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "not json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      { model: "m", messageId: "msg_1" },
    ) as any;

    expect(message.id).toBe("msg_1");
    expect(message.type).toBe("message");
    expect(message.role).toBe("assistant");
    expect(message.model).toBe("m");
    expect(message.stop_sequence).toBeNull();
    expect(message.content).toEqual([
      { type: "thinking", thinking: "why", signature: "cubiq-gateway" },
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t", name: "f", input: {} },
    ]);
    expect(message.stop_reason).toBe("tool_use");
    expect(message.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("maps stop_reason and cached usage", () => {
    const message = chatToAnthropicMessage(
      {
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 20 } },
      },
      { model: "m", messageId: "msg_2" },
    ) as any;

    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
    expect(message.usage).toEqual({ input_tokens: 30, output_tokens: 8, cache_read_input_tokens: 20 });
  });
});

describe("anthropicToChat system messages inside messages", () => {
  it("joins one before the first answer to the system prompt, and tags a later one as a user message", () => {
    const chat = anthropicToChat(
      {
        system: [{ type: "text", text: "You are Claude Code." }],
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: [{ type: "text", text: "Primary working directory: /p" }] } as never,
          { role: "assistant", content: "hello" },
          { role: "system", content: "Reminder: be brief." } as never,
          { role: "user", content: "again" },
        ],
      },
      { model: "m", reasoning: false },
    );
    expect(chat.messages).toEqual([
      { role: "system", content: "You are Claude Code.\n\nPrimary working directory: /p" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "<system>\nReminder: be brief.\n</system>" },
      { role: "user", content: "again" },
    ]);
  });

  it("still starts with a system message when only an in-messages one exists, and omits an empty one", () => {
    const withEnv = anthropicToChat({ messages: [{ role: "system", content: "env" } as never, { role: "user", content: "hi" }] }, { model: "m", reasoning: false });
    expect(withEnv.messages[0]).toEqual({ role: "system", content: "env" });
    const none = anthropicToChat({ messages: [{ role: "user", content: "hi" }] }, { model: "m", reasoning: false });
    expect(none.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
