import { describe, expect, it } from "vitest";
import {
  ChatToResponsesStream,
  responsesToChat,
  type ResponsesRequest,
  type ToolNames,
} from "../src/main/gateway/responses-chat";

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

/** Encode text the way the gateway does for a `cubiq:` reasoning item. */
function cubiq(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `cubiq:${btoa(binary)}`;
}

describe("responsesToChat — plumbing", () => {
  it("merges a leading developer message into the system message", () => {
    const { chat } = responsesToChat(
      { instructions: "base", input: [{ type: "message", role: "developer", content: "extra" }] },
      opts,
    );
    expect(chat.messages).toEqual([{ role: "system", content: "base\n\nextra" }]);
  });

  it("creates a system message from a lone leading developer message", () => {
    const { chat } = responsesToChat({ input: [{ type: "message", role: "developer", content: "only" }] }, opts);
    expect(chat.messages).toEqual([{ role: "system", content: "only" }]);
  });

  it("wraps a developer message that arrives after user output", () => {
    const { chat } = responsesToChat(
      {
        input: [
          { type: "message", role: "user", content: "hi" },
          { type: "message", role: "developer", content: "late" },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "<system>\nlate\n</system>" },
    ]);
  });

  it("maps a string input to one user message", () => {
    const { chat } = responsesToChat({ input: "hello" }, opts);
    expect(chat.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("always uses opts.model and never the request model", () => {
    const { chat } = responsesToChat({ model: "gpt-5", input: "x" }, opts);
    expect(chat.model).toBe("up-model");
  });

  it("clamps max_tokens to maxOutput", () => {
    expect(responsesToChat({ max_output_tokens: 5000, input: "x" }, { ...opts, maxOutput: 1000 }).chat.max_tokens).toBe(
      1000,
    );
    expect(responsesToChat({ max_output_tokens: 500, input: "x" }, { ...opts, maxOutput: 1000 }).chat.max_tokens).toBe(
      500,
    );
    expect(responsesToChat({ input: "x" }, opts).chat.max_tokens).toBeUndefined();
  });

  it("copies temperature and top_p when numbers", () => {
    const { chat } = responsesToChat({ temperature: 0.5, top_p: 0.9, input: "x" }, opts);
    expect(chat.temperature).toBe(0.5);
    expect(chat.top_p).toBe(0.9);
  });

  it("only sets stream_options when streaming", () => {
    const streaming = responsesToChat({ stream: true, input: "x" }, opts).chat;
    expect(streaming.stream).toBe(true);
    expect(streaming.stream_options).toEqual({ include_usage: true });

    const once = responsesToChat({ input: "x" }, opts).chat;
    expect(once.stream).toBe(false);
    expect(once.stream_options).toBeUndefined();
  });

  it("never forwards Responses-only fields", () => {
    const req = {
      store: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "k",
      client_metadata: { a: 1 },
      text: { format: { type: "text" } },
      truncation: "auto",
      metadata: { u: 1 },
      service_tier: "auto",
      previous_response_id: "resp_x",
      reasoning: { effort: "low" },
      user: "u",
      input: "hi",
    } as ResponsesRequest;
    const { chat } = responsesToChat(req, { ...opts, reasoning: true });
    for (const key of [
      "store",
      "include",
      "prompt_cache_key",
      "client_metadata",
      "text",
      "truncation",
      "metadata",
      "service_tier",
      "previous_response_id",
      "reasoning",
      "user",
    ]) {
      expect(key in chat).toBe(false);
    }
    expect(chat.reasoning_effort).toBe("low");
  });
});

describe("responsesToChat — user content", () => {
  it("maps input_text and an input_image data URL", () => {
    const { chat } = responsesToChat(
      {
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              { type: "input_image", image_url: "data:image/png;base64,AAA" },
              { type: "input_file", file_id: "f" },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ]);
  });

  it("uses a plain string for a single text part", () => {
    const { chat } = responsesToChat(
      { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "solo" }] }] },
      opts,
    );
    expect(chat.messages).toEqual([{ role: "user", content: "solo" }]);
  });

  it("drops an empty user message", () => {
    const { chat } = responsesToChat({ input: [{ type: "message", role: "user", content: [] }] }, opts);
    expect(chat.messages).toEqual([]);
  });
});

describe("responsesToChat — assistant grouping", () => {
  it("merges reasoning, an assistant message and two function calls into one message", () => {
    const { chat } = responsesToChat(
      {
        input: [
          { type: "reasoning", encrypted_content: cubiq("think") },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
          { type: "function_call", call_id: "c1", name: "alpha", arguments: '{"x":1}' },
          { type: "function_call", call_id: "c2", name: "beta", arguments: '{"y":2}' },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "think",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "alpha", arguments: '{"x":1}' } },
          { id: "c2", type: "function", function: { name: "beta", arguments: '{"y":2}' } },
        ],
      },
    ]);
  });

  it("falls back to the summary parts for reasoning text", () => {
    const { chat } = responsesToChat(
      {
        input: [
          { type: "reasoning", summary: [{ text: "s1" }, { text: "s2" }] },
          { type: "message", role: "assistant", content: "a" },
        ],
      },
      opts,
    );
    expect(chat.messages[0]!.reasoning_content).toBe("s1\n\ns2");
  });

  it("starts an assistant message with null content for a lone function_call", () => {
    const { chat } = responsesToChat(
      { input: [{ type: "function_call", call_id: "c1", name: "f", arguments: "{}" }] },
      opts,
    );
    expect(chat.messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ]);
  });

  it("wraps a custom_tool_call's input as arguments", () => {
    const { chat } = responsesToChat(
      { input: [{ type: "custom_tool_call", call_id: "c1", name: "patch", input: "diff" }] },
      opts,
    );
    expect(chat.messages[0]!.tool_calls![0]!.function.arguments).toBe('{"input":"diff"}');
  });
});

describe("responsesToChat — tool output", () => {
  it("maps string and image-array outputs", () => {
    const { chat } = responsesToChat(
      {
        input: [
          { type: "function_call_output", call_id: "c1", output: "ok" },
          {
            type: "function_call_output",
            call_id: "c2",
            output: [
              { type: "input_text", text: "see" },
              { type: "input_image", image_url: "data:image/png;base64,BBB" },
            ],
          },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "tool", tool_call_id: "c2", content: "see" },
      {
        role: "user",
        content: [
          { type: "text", text: "Image(s) from tool result c2:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
        ],
      },
    ]);
  });

  it("drops unknown item types", () => {
    const { chat } = responsesToChat(
      {
        input: [
          { type: "web_search_call", id: "w" },
          { type: "local_shell_call" },
          { type: "item_reference" },
          { type: "compaction" },
          { type: "message", role: "user", content: "kept" },
        ],
      },
      opts,
    );
    expect(chat.messages).toEqual([{ role: "user", content: "kept" }]);
  });
});
describe("responsesToChat — tools", () => {
  it("flattens namespace tools and records the names map", () => {
    const { chat, names: map } = responsesToChat(
      {
        tools: [
          {
            type: "namespace",
            name: "mcp__cubiq",
            tools: [{ type: "function", name: "browser_eval", description: "d", parameters: { type: "object" } }],
          },
        ],
      },
      opts,
    );
    expect(chat.tools).toEqual([
      { type: "function", function: { name: "mcp__cubiq__browser_eval", description: "d", parameters: { type: "object" } } },
    ]);
    expect(map.get("mcp__cubiq__browser_eval")).toEqual({ name: "browser_eval", namespace: "mcp__cubiq" });
  });

  it("keeps a plain function tool and its default parameters", () => {
    const { chat, names: map } = responsesToChat({ tools: [{ type: "function", name: "read" }] }, opts);
    expect(chat.tools).toEqual([
      { type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } },
    ]);
    expect(map.get("read")).toEqual({ name: "read" });
  });

  it("hashes a flattened name past 64 chars, deterministically", () => {
    const longNs = "mcp__" + "a".repeat(60);
    const tool = { type: "namespace", name: longNs, tools: [{ type: "function", name: "browser_eval" }] };
    const first = responsesToChat({ tools: [tool] }, opts);
    const second = responsesToChat({ tools: [tool] }, opts);
    const flat = first.chat.tools![0]!.function.name;
    expect(flat.length).toBe(64);
    expect(flat).toBe(second.chat.tools![0]!.function.name);
    expect(flat.slice(0, 55)).toBe(`${longNs}__browser_eval`.slice(0, 55));
    expect(first.names.get(flat)).toEqual({ name: "browser_eval", namespace: longNs });
  });

  it("uses the flat name for a namespaced function_call in input", () => {
    const { chat } = responsesToChat(
      {
        input: [
          { type: "function_call", namespace: "mcp__cubiq", name: "browser_eval", call_id: "c1", arguments: "{}" },
        ],
      },
      opts,
    );
    expect(chat.messages[0]!.tool_calls![0]!.function.name).toBe("mcp__cubiq__browser_eval");
  });

  it("drops every non-function tool type", () => {
    const { chat } = responsesToChat(
      {
        tools: [
          { type: "web_search" },
          { type: "local_shell" },
          { type: "custom", name: "c" },
          { type: "image_generation" },
          { type: "file_search" },
          { type: "function", name: "keep" },
        ],
      },
      opts,
    );
    expect(chat.tools?.map((tool) => tool.function.name)).toEqual(["keep"]);
  });

  it("omits tools, choice and parallel flags when none remain", () => {
    const { chat } = responsesToChat(
      { tools: [{ type: "web_search" }], tool_choice: "auto", parallel_tool_calls: true },
      opts,
    );
    expect(chat.tools).toBeUndefined();
    expect(chat.tool_choice).toBeUndefined();
    expect(chat.parallel_tool_calls).toBeUndefined();
  });

  it("maps tool_choice variants", () => {
    const tools = [{ type: "function", name: "t" }];
    const choice = (value: unknown) => responsesToChat({ tools, tool_choice: value, input: "x" }, opts).chat.tool_choice;
    expect(choice("auto")).toBe("auto");
    expect(choice("none")).toBe("none");
    expect(choice("required")).toBe("required");
    expect(choice({ type: "function", name: "t" })).toEqual({ type: "function", function: { name: "t" } });
    expect(choice({ type: "weird" })).toBeUndefined();
  });

  it("copies a boolean parallel_tool_calls when tools remain", () => {
    const tools = [{ type: "function", name: "t" }];
    expect(responsesToChat({ tools, parallel_tool_calls: true }, opts).chat.parallel_tool_calls).toBe(true);
  });
});

describe("responsesToChat — reasoning effort", () => {
  const effort = (value: string | undefined, on = true) =>
    responsesToChat(
      { reasoning: value === undefined ? {} : { effort: value }, input: "x" },
      { ...opts, reasoning: on },
    ).chat.reasoning_effort;

  it("maps known efforts and rewrites minimal/xhigh/none", () => {
    expect(effort("low")).toBe("low");
    expect(effort("medium")).toBe("medium");
    expect(effort("high")).toBe("high");
    expect(effort("minimal")).toBe("low");
    expect(effort("xhigh")).toBe("high");
    expect(effort("none")).toBeUndefined();
    expect(effort("bogus")).toBeUndefined();
  });

  it("only sends effort when reasoning is enabled", () => {
    expect(effort("low", false)).toBeUndefined();
    expect(effort(undefined)).toBeUndefined();
  });
});

describe("ChatToResponsesStream — text", () => {
  it("emits an exact event sequence and sequence numbers", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_1", names: new Map() });
    let text = stream.push({ choices: [{ delta: { content: "Hello" } }] });
    text += stream.push({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] });
    text += stream.finish();
    const events = parseSse(text);

    expect(names(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((event) => event.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events[0]!.data.type).toBe("response.created");
    expect(events[0]!.data.response).toMatchObject({ id: "resp_1", object: "response", model: "m", status: "in_progress", output: [] });
    expect(events.at(-1)!.data.response).toMatchObject({
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_resp_1_0",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello world", annotations: [] }],
        },
      ],
    });
  });

  it("starts the response on finish when nothing was pushed", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_x", names: new Map() });
    const events = parseSse(stream.finish());
    expect(names(events)).toEqual(["response.created", "response.in_progress", "response.completed"]);
  });

  it("is idempotent and ignores pushes after finish", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_2", names: new Map() });
    stream.push({ choices: [{ delta: { content: "x" } }] });
    expect(stream.finish().length).toBeGreaterThan(0);
    expect(stream.finish()).toBe("");
    expect(stream.push({ choices: [{ delta: { content: "y" } }] })).toBe("");
  });

  it("ignores non-object chunks", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_3", names: new Map() });
    expect(stream.push(null)).toBe("");
    expect(stream.push("nope")).toBe("");
    expect(stream.push(42)).toBe("");
    const events = parseSse(stream.push({ choices: [{ delta: { content: "ok" } }] }));
    expect(events[0]!.event).toBe("response.created");
  });
});
describe("ChatToResponsesStream — reasoning", () => {
  it("closes a reasoning item before text, with a cubiq payload that round-trips", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_4", names: new Map() });
    let text = stream.push({ choices: [{ delta: { reasoning_content: "think" } }] });
    text += stream.push({ choices: [{ delta: { content: "answer" } }] });
    text += stream.finish();
    const events = parseSse(text);

    expect(names(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const reasoning = events.find((event) => event.event === "response.output_item.done" && event.data.item.type === "reasoning")!;
    expect(reasoning.data.item.encrypted_content).toBe(cubiq("think"));
    expect(reasoning.data.output_index).toBe(0);

    const { chat } = responsesToChat(
      {
        input: [
          { type: "reasoning", encrypted_content: reasoning.data.item.encrypted_content },
          { type: "message", role: "assistant", content: "answer" },
        ],
      },
      opts,
    );
    expect(chat.messages[0]!.reasoning_content).toBe("think");
  });

  it("round-trips non-ASCII reasoning text", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_5", names: new Map() });
    stream.push({ choices: [{ delta: { reasoning_content: "café ✓" } }] });
    const events = parseSse(stream.finish());
    const item = events.find((event) => event.event === "response.output_item.done")!.data.item;
    expect(item.encrypted_content.startsWith("cubiq:")).toBe(true);

    const { chat } = responsesToChat(
      {
        input: [
          { type: "reasoning", encrypted_content: item.encrypted_content },
          { type: "message", role: "assistant", content: "x" },
        ],
      },
      opts,
    );
    expect(chat.messages[0]!.reasoning_content).toBe("café ✓");
  });

  it("accepts delta.reasoning as an alias", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_6", names: new Map() });
    let text = stream.push({ choices: [{ delta: { reasoning: "hmm" } }] });
    text += stream.finish();
    const delta = parseSse(text).find((event) => event.event === "response.reasoning_summary_text.delta")!;
    expect(delta.data.delta).toBe("hmm");
  });
});

describe("ChatToResponsesStream — tool calls", () => {
  it("buffers a fragmented tool call and emits it at finish", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_7", names: new Map() });
    let text = stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "get_weather" } }] } }] });
    text += stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] });
    text += stream.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"SF"}' } }] }, finish_reason: "tool_calls" }],
    });
    text += stream.finish();
    const events = parseSse(text);

    const started = events.find((event) => event.event === "response.output_item.added")!;
    expect(started.data.item).toMatchObject({ type: "function_call", id: "fc_resp_7_0", call_id: "call_a", name: "get_weather", arguments: "", status: "in_progress" });
    const argsDone = events.find((event) => event.event === "response.function_call_arguments.done")!;
    expect(argsDone.data.arguments).toBe('{"city":"SF"}');
    const done = events.find((event) => event.event === "response.output_item.done")!;
    expect(done.data.item).toEqual({
      type: "function_call",
      id: "fc_resp_7_0",
      call_id: "call_a",
      name: "get_weather",
      arguments: '{"city":"SF"}',
      status: "completed",
    });
    expect(events.at(-1)!.data.response.output).toEqual([done.data.item]);
  });

  it("maps a namespaced upstream name back to {name, namespace}", () => {
    const map: ToolNames = new Map([["mcp__cubiq__browser_eval", { name: "browser_eval", namespace: "mcp__cubiq" }]]);
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_8", names: map });
    let text = stream.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_b", function: { name: "mcp__cubiq__browser_eval", arguments: "{}" } }] } }],
    });
    text += stream.finish();
    const done = parseSse(text).find((event) => event.event === "response.output_item.done")!;
    expect(done.data.item).toMatchObject({
      name: "browser_eval",
      namespace: "mcp__cubiq",
      call_id: "call_b",
      arguments: "{}",
    });
  });

  it("falls back to generated ids and empty arguments", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_9", names: new Map() });
    let text = stream.push({ choices: [{ delta: { tool_calls: [{ function: { name: "f" } }] } }] });
    text += stream.finish();
    const done = parseSse(text).find((event) => event.event === "response.output_item.done")!;
    expect(done.data.item).toMatchObject({ id: "fc_resp_9_0", call_id: "call_resp_9_0", name: "f", arguments: "{}" });
  });
});

describe("ChatToResponsesStream — usage and finish reasons", () => {
  it("maps usage including cached and reasoning tokens", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_10", names: new Map() });
    let text = stream.push({ choices: [{ delta: { content: "x" } }] });
    text += stream.push({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });
    text += stream.finish();
    const final = parseSse(text).at(-1)!;
    expect(final.event).toBe("response.completed");
    expect(final.data.response.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 120,
    });
  });

  it("uses prompt_cache_hit_tokens for cached tokens", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_11", names: new Map() });
    let text = stream.push({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 20 } });
    text += stream.finish();
    expect(parseSse(text).at(-1)!.data.response.usage).toMatchObject({ input_tokens: 50, input_tokens_details: { cached_tokens: 20 } });
  });

  it("maps a length finish to response.incomplete", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_12", names: new Map() });
    let text = stream.push({ choices: [{ delta: { content: "x" }, finish_reason: "length" }] });
    text += stream.finish();
    const final = parseSse(text).at(-1)!;
    expect(final.event).toBe("response.incomplete");
    expect(final.data.response).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
  });

  it("maps a content_filter finish to response.incomplete", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_13", names: new Map() });
    let text = stream.push({ choices: [{ delta: {}, finish_reason: "content_filter" }] });
    text += stream.finish();
    const final = parseSse(text).at(-1)!;
    expect(final.event).toBe("response.incomplete");
    expect(final.data.response.incomplete_details).toEqual({ reason: "content_filter" });
  });
});

describe("ChatToResponsesStream — errors", () => {
  it("emits response.failed and stays silent afterwards", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_14", names: new Map() });
    stream.push({ choices: [{ delta: { content: "x" } }] });
    const events = parseSse(stream.error("boom"));
    expect(names(events).at(-1)).toBe("response.failed");
    expect(events.at(-1)!.data.response).toMatchObject({
      status: "failed",
      error: { code: "server_error", message: "boom" },
    });
    expect(stream.push({ choices: [{ delta: { content: "y" } }] })).toBe("");
    expect(stream.finish()).toBe("");
    expect(stream.error("again")).toBe("");
  });

  it("starts the response before failing when nothing was pushed", () => {
    const stream = new ChatToResponsesStream({ model: "m", responseId: "resp_15", names: new Map() });
    expect(names(parseSse(stream.error("early")))).toEqual([
      "response.created",
      "response.in_progress",
      "response.failed",
    ]);
  });
});



describe("responsesToChat damaged reasoning payload", () => {
  it("falls back to the summary when a cubiq: payload isn't valid base64", () => {
    const req: ResponsesRequest = {
      input: [
        { type: "reasoning", encrypted_content: "cubiq:%%%not-base64%%%", summary: [{ text: "From the summary." }] },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
      ],
    };
    const { chat } = responsesToChat(req, { model: "m", reasoning: true });
    expect(chat.messages[0]).toMatchObject({ role: "assistant", reasoning_content: "From the summary." });
  });
});
