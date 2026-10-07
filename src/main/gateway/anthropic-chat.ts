/**
 * Pure translation between the Anthropic Messages API (what Claude Code sends)
 * and OpenAI chat-completions. No I/O, no network; only shaping values.
 */

/** A block inside a message's `content` array. Loose: unknown kinds are dropped. */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | AnthropicContentBlock[];
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

/** A user/assistant message. */
export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
}

/** A `{type:"text", text}` block used in the system prompt. */
export interface AnthropicTextBlock {
  type: string;
  text: string;
  [key: string]: unknown;
}

/** A tool declaration offered to the model. */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

/** How the caller wants tool use constrained. */
export interface AnthropicToolChoice {
  type: string;
  name?: string;
  disable_parallel_tool_use?: boolean;
  [key: string]: unknown;
}

/** An Anthropic Messages API request, loosely typed. */
export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: { type?: string };
  output_config?: { effort?: string };
  [key: string]: unknown;
}

/** An OpenAI chat-completions content part. */
export interface ChatContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  [key: string]: unknown;
}

/** An OpenAI chat-completions tool call. */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** An OpenAI chat-completions message. */
export interface ChatMessage {
  role: string;
  content?: string | ChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  reasoning_content?: string;
  [key: string]: unknown;
}

/** An OpenAI chat-completions tool declaration. */
export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** An OpenAI chat-completions request, loosely typed. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  tools?: ChatTool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  reasoning_effort?: string;
  [key: string]: unknown;
}

interface ChatDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: ChatToolCallDelta[];
  [key: string]: unknown;
}

interface ChatToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  [key: string]: unknown;
}

interface ChatChoice {
  delta?: ChatDelta;
  message?: ChatMessage;
  finish_reason?: string | null;
  [key: string]: unknown;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  [key: string]: unknown;
}

interface ChatChunk {
  choices?: ChatChoice[];
  usage?: ChatUsage;
  [key: string]: unknown;
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: ChatUsage;
  [key: string]: unknown;
}

/** Render one Anthropic SSE event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** First argument that is a non-empty string. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Map an OpenAI finish_reason to an Anthropic stop_reason. */
function mapStopReason(raw: string | null | undefined, hasTools: boolean): string {
  let mapped: string;
  switch (raw) {
    case "stop":
      mapped = "end_turn";
      break;
    case "length":
      mapped = "max_tokens";
      break;
    case "tool_calls":
    case "function_call":
      mapped = "tool_use";
      break;
    case "content_filter":
      mapped = "refusal";
      break;
    default:
      mapped = hasTools ? "tool_use" : "end_turn";
  }
  if (hasTools && mapped === "end_turn") mapped = "tool_use";
  return mapped;
}

/** Build an Anthropic usage payload; input excludes cached tokens. */
function usagePayload(promptTokens: number, completionTokens: number, cachedTokens: number): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    input_tokens: Math.max(promptTokens - cachedTokens, 0),
    output_tokens: completionTokens,
  };
  if (cachedTokens > 0) usage.cache_read_input_tokens = cachedTokens;
  return usage;
}

/** Flatten the system prompt (string or text blocks) into one string. */
function systemToText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block) => (typeof block.text === "string" ? block.text : "")).join("\n\n");
}

/** Resolve an image block's `source` into a URL usable by OpenAI. */
function imageUrl(block: AnthropicContentBlock): string | undefined {
  const source = block.source;
  if (!source) return undefined;
  if (source.type === "base64" && source.media_type && source.data) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return undefined;
}

/** Text content of a tool_result block, prefixed when it is an error. */
function toolResultText(block: AnthropicContentBlock): string {
  const inner = block.content;
  let text: string;
  if (typeof inner === "string") {
    text = inner;
  } else if (Array.isArray(inner)) {
    text = inner
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  } else {
    text = "";
  }
  return block.is_error ? `Error: ${text}` : text;
}

/** Image parts nested inside a tool_result's content. */
function toolResultImages(block: AnthropicContentBlock): ChatContentPart[] {
  const inner = block.content;
  if (!Array.isArray(inner)) return [];
  const parts: ChatContentPart[] = [];
  for (const part of inner) {
    if (part.type !== "image") continue;
    const url = imageUrl(part);
    if (url) parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

/** Map one user message, emitting tool results before its remaining content. */
function appendUserMessage(content: string | AnthropicContentBlock[] | undefined, out: ChatMessage[]): void {
  if (typeof content === "string") {
    out.push({ role: "user", content });
    return;
  }
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type !== "tool_result") continue;
    out.push({ role: "tool", tool_call_id: block.tool_use_id ?? "", content: toolResultText(block) });
  }
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const images = toolResultImages(block);
    if (images.length === 0) continue;
    out.push({
      role: "user",
      content: [{ type: "text", text: `Image(s) from tool result ${block.tool_use_id ?? ""}:` }, ...images],
    });
  }

  const parts: ChatContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "image") {
      const url = imageUrl(block);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (parts.length === 0) return;
  const only = parts[0];
  if (parts.length === 1 && only?.type === "text") {
    out.push({ role: "user", content: only.text ?? "" });
  } else {
    out.push({ role: "user", content: parts });
  }
}

/** Map one assistant message: text, thinking and tool_use blocks. */
function mapAssistantMessage(content: string | AnthropicContentBlock[] | undefined): ChatMessage | undefined {
  if (typeof content === "string") return { role: "assistant", content };
  if (!Array.isArray(content)) return undefined;

  let text = "";
  let reasoning = "";
  const toolCalls: ChatToolCall[] = [];
  for (const block of content) {
    if (block.type === "text") {
      text += block.text ?? "";
    } else if (block.type === "thinking") {
      reasoning += block.thinking ?? "";
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: ChatMessage = { role: "assistant", content: text.length > 0 ? text : null };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

/** Convert Anthropic tool declarations, dropping server-side tools. */
function convertTools(tools: AnthropicTool[] | undefined): ChatTool[] {
  const out: ChatTool[] = [];
  for (const tool of tools ?? []) {
    if (tool.type !== undefined && tool.type !== "custom") continue;
    const fn: ChatTool["function"] = { name: tool.name, parameters: tool.input_schema ?? {} };
    if (tool.description !== undefined) fn.description = tool.description;
    out.push({ type: "function", function: fn });
  }
  return out;
}

/** Map Anthropic tool_choice onto its OpenAI equivalent. */
function mapToolChoice(choice: AnthropicToolChoice | undefined): ChatRequest["tool_choice"] {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name ?? "" } };
    default:
      return undefined;
  }
}

/** Map Anthropic's effort label onto OpenAI's reasoning_effort. */
function mapEffort(effort: unknown): "low" | "medium" | "high" {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "xhigh" || effort === "max") return "high";
  return "medium";
}

/** Translate an Anthropic Messages request into an OpenAI chat-completions request. */
export function anthropicToChat(
  req: AnthropicRequest,
  opts: { model: string; maxOutput?: number; reasoning: boolean },
): ChatRequest {
  const messages: ChatMessage[] = [];

  const system = systemToText(req.system);
  if (system.length > 0) messages.push({ role: "system", content: system });

  for (const message of req.messages ?? []) {
    if (message.role === "user") {
      appendUserMessage(message.content, messages);
    } else if (message.role === "assistant") {
      const mapped = mapAssistantMessage(message.content);
      if (mapped) messages.push(mapped);
    }
  }

  const chat: ChatRequest = { model: opts.model, messages, stream: req.stream === true };
  if (chat.stream) chat.stream_options = { include_usage: true };

  if (req.max_tokens !== undefined) {
    chat.max_tokens = opts.maxOutput !== undefined ? Math.min(req.max_tokens, opts.maxOutput) : req.max_tokens;
  }
  if (req.temperature !== undefined) chat.temperature = req.temperature;
  if (req.top_p !== undefined) chat.top_p = req.top_p;
  if (req.stop_sequences !== undefined) chat.stop = req.stop_sequences;

  const tools = convertTools(req.tools);
  if (tools.length > 0) {
    chat.tools = tools;
    const choice = mapToolChoice(req.tool_choice);
    if (choice !== undefined) chat.tool_choice = choice;
    if (req.tool_choice?.disable_parallel_tool_use === true) chat.parallel_tool_calls = false;
  }

  const thinking = req.thinking?.type;
  if (opts.reasoning && (thinking === "enabled" || thinking === "adaptive")) {
    chat.reasoning_effort = mapEffort(req.output_config?.effort);
  }

  return chat;
}

/**
 * Stateful translator from OpenAI chat-completion chunks into Anthropic SSE
 * events. `push` per chunk, then `finish` once when the upstream ends.
 */
export class ChatToAnthropicStream {
  private readonly model: string;
  private readonly messageId: string;
  private started = false;
  private finished = false;
  private open: "thinking" | "text" | null = null;
  private openIndex = -1;
  private nextIndex = 0;
  private readonly calls = new Map<number, { id?: string; name?: string; args: string }>();
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedTokens = 0;
  private reasoningTokens = 0;
  private finishReason: string | null = null;

  constructor(opts: { model: string; messageId: string }) {
    this.model = opts.model;
    this.messageId = opts.messageId;
  }

  /** Feed one parsed chat.completion.chunk; returns the SSE text to send. */
  push(chunk: unknown): string {
    if (this.finished) return "";
    if (typeof chunk !== "object" || chunk === null) return "";
    const parsed = chunk as ChatChunk;

    let out = this.startIfNeeded();
    if (parsed.usage) this.captureUsage(parsed.usage);

    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (!choice) return out;

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (delta && typeof delta === "object") {
      const reasoning = firstString(delta.reasoning_content, delta.reasoning);
      if (reasoning) {
        out += this.openBlock("thinking");
        out += this.blockDelta({ type: "thinking_delta", thinking: reasoning });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        out += this.openBlock("text");
        out += this.blockDelta({ type: "text_delta", text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          if (typeof fragment !== "object" || fragment === null) continue;
          const index = typeof fragment.index === "number" ? fragment.index : 0;
          const entry = this.calls.get(index) ?? { args: "" };
          if (typeof fragment.id === "string" && fragment.id.length > 0) entry.id = fragment.id;
          if (typeof fragment.function?.name === "string" && fragment.function.name.length > 0) {
            entry.name = fragment.function.name;
          }
          if (typeof fragment.function?.arguments === "string") entry.args += fragment.function.arguments;
          this.calls.set(index, entry);
        }
      }
    }
    return out;
  }

  /** Close the response; returns the closing SSE text. Idempotent. */
  finish(): string {
    if (this.finished) return "";
    this.finished = true;

    let out = this.startIfNeeded();
    out += this.closeOpen();

    const indexes = [...this.calls.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const call = this.calls.get(index);
      if (!call) continue;
      const blockIndex = this.nextIndex++;
      out += sse("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: call.id ?? `call_${this.messageId}_${index}`,
          name: call.name ?? "",
          input: {},
        },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: call.args.length > 0 ? call.args : "{}" },
      });
      out += sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
    }

    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapStopReason(this.finishReason, indexes.length > 0), stop_sequence: null },
      usage: usagePayload(this.promptTokens, this.completionTokens, this.cachedTokens),
    });
    out += sse("message_stop", { type: "message_stop" });
    return out;
  }

  /** Render an Anthropic error event for the client. */
  error(message: string): string {
    return sse("error", { type: "error", error: { type: "api_error", message } });
  }

  /** Emit message_start exactly once. */
  private startIfNeeded(): string {
    if (this.started) return "";
    this.started = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  /** Open a block, closing whatever kind was open first. */
  private openBlock(kind: "thinking" | "text"): string {
    if (this.open === kind) return "";
    let out = this.closeOpen();
    const index = this.nextIndex++;
    this.open = kind;
    this.openIndex = index;
    const content_block =
      kind === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" };
    out += sse("content_block_start", { type: "content_block_start", index, content_block });
    return out;
  }

  /** Close the open block, adding a signature delta for thinking blocks. */
  private closeOpen(): string {
    if (this.open === null) return "";
    const index = this.openIndex;
    const kind = this.open;
    this.open = null;
    let out = "";
    if (kind === "thinking") {
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "cubiq-gateway" },
      });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index });
    return out;
  }

  /** A content_block_delta for the currently open block. */
  private blockDelta(delta: Record<string, unknown>): string {
    return sse("content_block_delta", { type: "content_block_delta", index: this.openIndex, delta });
  }

  /** Remember the latest usage numbers across chunks. */
  private captureUsage(usage: ChatUsage): void {
    if (typeof usage.prompt_tokens === "number") this.promptTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") this.completionTokens = usage.completion_tokens;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
    if (typeof cached === "number") this.cachedTokens = cached;
    if (typeof usage.completion_tokens_details?.reasoning_tokens === "number") {
      this.reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
    }
  }
}

/** Parse a tool call's arguments, falling back to an empty object. */
function parseToolArguments(args: string | undefined): unknown {
  if (args === undefined) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Translate a non-streaming chat.completion into an Anthropic message. */
export function chatToAnthropicMessage(resp: unknown, opts: { model: string; messageId: string }): object {
  const parsed = (typeof resp === "object" && resp !== null ? resp : {}) as ChatResponse;
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const message: ChatMessage = choice?.message ?? ({} as ChatMessage);

  const content: Record<string, unknown>[] = [];
  const reasoning = firstString(message.reasoning_content, message.reasoning);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "cubiq-gateway" });
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id ?? "",
      name: call.function?.name ?? "",
      input: parseToolArguments(call.function?.arguments),
    });
  }

  const usage = parsed.usage ?? {};
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;

  return {
    id: opts.messageId,
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason ?? null, toolCalls.length > 0),
    stop_sequence: null,
    usage: usagePayload(prompt, completion, cached),
  };
}
