/**
 * Pure translation between the OpenAI Responses API (what the Codex CLI sends)
 * and OpenAI chat-completions, in both directions, streaming. No I/O, no
 * network; only shaping values.
 */

import type { ChatContentPart, ChatMessage, ChatRequest, ChatTool, ChatToolCall } from "./anthropic-chat";

/** Flattened upstream function name -> the Codex tool it stands for. */
export type ToolNames = Map<string, { name: string; namespace?: string }>;

/** A content part inside a Responses input message or tool output. */
export interface ResponsesContentPart {
  type: string;
  text?: string;
  image_url?: string;
  [key: string]: unknown;
}

/** One item in the Responses `input` array. Loose: unknown kinds are dropped. */
export interface ResponsesInputItem {
  type: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  call_id?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  input?: unknown;
  output?: string | ResponsesContentPart[];
  summary?: { text?: string }[];
  encrypted_content?: string;
  [key: string]: unknown;
}

/** A function tool offered by the Responses API. */
export interface ResponsesFunctionTool {
  type: string;
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A Responses tool: a plain function, a namespace of functions, or something we drop. */
export interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  tools?: ResponsesFunctionTool[];
  [key: string]: unknown;
}

/** An OpenAI Responses API request, loosely typed. */
export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: { effort?: string; summary?: string };
  stream?: boolean;
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

/** First argument that is a non-empty string. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Decode `cubiq:` reasoning text: base64 UTF-8 bytes back to a string. */
function decodeReasoning(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode reasoning text as base64 UTF-8 bytes (the `cubiq:` payload). */
function encodeReasoning(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** FNV-1a 32-bit hash, used to shorten a flattened name past 64 chars. */
function hashName(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Flatten `namespace + name` into a top-level function name, hashing past 64 chars. */
function flattenToolName(namespace: string | undefined, name: string): string {
  if (!namespace) return name;
  const flat = `${namespace}__${name}`;
  return flat.length > 64 ? `${flat.slice(0, 55)}_${hashName(flat)}` : flat;
}

/** Text of a message's content: a string, or its text parts joined with nothing. */
function messageText(content: string | ResponsesContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "input_text" || part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Map a user message's content; `undefined` means the message is empty and is
 * dropped entirely.
 */
function userContent(
  content: string | ResponsesContentPart[] | undefined,
): string | ChatContentPart[] | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;

  const parts: ChatContentPart[] = [];
  for (const part of content) {
    if (part.type === "input_text") {
      parts.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
    }
  }
  if (parts.length === 0) return undefined;
  const only = parts[0];
  if (parts.length === 1 && only?.type === "text") {
    const text = only.text ?? "";
    return text.length > 0 ? text : undefined;
  }
  return parts;
}

/** Reasoning text of a reasoning item: cubiq payload, else summary, else content. */
function reasoningText(item: ResponsesInputItem): string {
  const encrypted = item.encrypted_content;
  if (typeof encrypted === "string" && encrypted.startsWith("cubiq:")) {
    try {
      return decodeReasoning(encrypted.slice("cubiq:".length));
    } catch {
      // A damaged payload: fall back to the summary rather than fail the request.
    }
  }
  if (Array.isArray(item.summary)) {
    const summary = item.summary.map((part) => part?.text ?? "").join("\n\n");
    if (summary.length > 0) return summary;
  }
  if (Array.isArray(item.content)) {
    const content = item.content.map((part) => part?.text ?? "").join("\n\n");
    if (content.length > 0) return content;
  }
  return "";
}

/** A tool output's text and any image parts it carries. */
function toolOutput(output: string | ResponsesContentPart[] | undefined): {
  text: string;
  images: ChatContentPart[];
} {
  if (typeof output === "string") return { text: output, images: [] };
  if (!Array.isArray(output)) return { text: "", images: [] };
  const texts: string[] = [];
  const images: ChatContentPart[] = [];
  for (const part of output) {
    if (part.type === "input_text") texts.push(part.text ?? "");
    else if (part.type === "input_image" && typeof part.image_url === "string") {
      images.push({ type: "image_url", image_url: { url: part.image_url } });
    }
  }
  return { text: texts.join("\n"), images };
}

/** Convert Responses tools, flattening namespaces and dropping everything else. */
function convertTools(tools: ResponsesTool[] | undefined, names: ToolNames): ChatTool[] {
  const out: ChatTool[] = [];
  for (const tool of tools ?? []) {
    if (tool.type === "function") {
      const name = tool.name ?? "";
      const fn: ChatTool["function"] = { name, parameters: tool.parameters ?? { type: "object", properties: {} } };
      if (tool.description !== undefined) fn.description = tool.description;
      out.push({ type: "function", function: fn });
      names.set(name, { name });
      continue;
    }
    if (tool.type === "namespace") {
      const namespace = tool.name ?? "";
      for (const inner of tool.tools ?? []) {
        if (inner.type !== "function") continue;
        const flat = flattenToolName(namespace, inner.name);
        const fn: ChatTool["function"] = {
          name: flat,
          parameters: inner.parameters ?? { type: "object", properties: {} },
        };
        if (inner.description !== undefined) fn.description = inner.description;
        out.push({ type: "function", function: fn });
        names.set(flat, { name: inner.name, namespace });
      }
    }
  }
  return out;
}

/** Map a Responses tool_choice onto its chat-completions equivalent. */
function mapToolChoice(choice: unknown): ChatRequest["tool_choice"] {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (typeof choice === "object" && choice !== null && (choice as { type?: unknown }).type === "function") {
    const name = (choice as { name?: unknown }).name;
    if (typeof name === "string") return { type: "function", function: { name } };
  }
  return undefined;
}

/** Map a Responses reasoning effort onto chat-completions' reasoning_effort. */
function mapEffort(effort: string): "low" | "medium" | "high" | undefined {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "high";
  return undefined;
}
/** Translate an OpenAI Responses request into an OpenAI chat-completions request. */
export function responsesToChat(
  req: ResponsesRequest,
  opts: { model: string; maxOutput?: number; reasoning: boolean },
): { chat: ChatRequest; names: ToolNames } {
  const messages: ChatMessage[] = [];
  const names: ToolNames = new Map();

  let systemMsg: ChatMessage | undefined;
  if (typeof req.instructions === "string" && req.instructions.length > 0) {
    systemMsg = { role: "system", content: req.instructions };
    messages.push(systemMsg);
  }

  /** Whether a non-system message has been emitted yet. */
  let sawNonSystem = false;

  const appendSystem = (text: string): void => {
    if (!systemMsg) {
      systemMsg = { role: "system", content: "" };
      messages.push(systemMsg);
    }
    const existing = typeof systemMsg.content === "string" ? systemMsg.content : "";
    systemMsg.content = existing.length > 0 ? `${existing}\n\n${text}` : text;
  };

  let pendingAssistant: ChatMessage | null = null;
  let pendingReasoning: string | null = null;

  const startAssistant = (content: string | null): ChatMessage => {
    const message: ChatMessage = { role: "assistant", content };
    if (pendingReasoning !== null) {
      message.reasoning_content = pendingReasoning;
      pendingReasoning = null;
    }
    pendingAssistant = message;
    return message;
  };

  const flushAssistant = (): void => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
    // Reasoning with no assistant output following it is dropped.
    pendingReasoning = null;
  };

  const handleItem = (item: ResponsesInputItem): void => {
    switch (item.type) {
      case "message": {
        if (item.role === "system" || item.role === "developer") {
          const text = messageText(item.content);
          if (text.length === 0) return;
          if (!sawNonSystem) {
            appendSystem(text);
          } else {
            flushAssistant();
            messages.push({ role: "user", content: `<system>\n${text}\n</system>` });
          }
          return;
        }
        if (item.role === "user") {
          flushAssistant();
          const content = userContent(item.content);
          if (content === undefined) return;
          messages.push({ role: "user", content });
          sawNonSystem = true;
          return;
        }
        if (item.role === "assistant") {
          if (pendingAssistant) flushAssistant();
          const text = messageText(item.content);
          startAssistant(text.length > 0 ? text : null);
          sawNonSystem = true;
          return;
        }
        return;
      }
      case "reasoning": {
        const text = reasoningText(item);
        if (text.length > 0) pendingReasoning = text;
        return;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = flattenToolName(item.namespace, item.name ?? "");
        const args = item.arguments ?? JSON.stringify({ input: item.input });
        const call: ChatToolCall = { id: item.call_id ?? "", type: "function", function: { name, arguments: args } };
        const target = pendingAssistant ?? startAssistant(null);
        if (!target.tool_calls) target.tool_calls = [];
        target.tool_calls.push(call);
        sawNonSystem = true;
        return;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        flushAssistant();
        const { text, images } = toolOutput(item.output);
        messages.push({ role: "tool", tool_call_id: item.call_id ?? "", content: text });
        if (images.length > 0) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: `Image(s) from tool result ${item.call_id ?? ""}:` }, ...images],
          });
        }
        sawNonSystem = true;
        return;
      }
      default:
        // web_search_call, local_shell_call, item_reference, compaction, … are dropped.
        return;
    }
  };

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
    sawNonSystem = true;
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (typeof item === "object" && item !== null) handleItem(item);
    }
  }
  flushAssistant();

  const chat: ChatRequest = { model: opts.model, messages, stream: req.stream === true };
  if (chat.stream) chat.stream_options = { include_usage: true };

  if (typeof req.max_output_tokens === "number") {
    chat.max_tokens =
      opts.maxOutput !== undefined ? Math.min(req.max_output_tokens, opts.maxOutput) : req.max_output_tokens;
  }
  if (typeof req.temperature === "number") chat.temperature = req.temperature;
  if (typeof req.top_p === "number") chat.top_p = req.top_p;

  const tools = convertTools(req.tools, names);
  if (tools.length > 0) {
    chat.tools = tools;
    const choice = mapToolChoice(req.tool_choice);
    if (choice !== undefined) chat.tool_choice = choice;
    if (typeof req.parallel_tool_calls === "boolean") chat.parallel_tool_calls = req.parallel_tool_calls;
  }

  const effort = req.reasoning?.effort;
  if (opts.reasoning && typeof effort === "string") {
    const mapped = mapEffort(effort);
    if (mapped !== undefined) chat.reasoning_effort = mapped;
  }

  return { chat, names };
}

/**
 * Stateful translator from OpenAI chat-completion chunks into Responses SSE
 * events. `push` per chunk, then `finish` once when the upstream ends.
 */
export class ChatToResponsesStream {
  private readonly model: string;
  private readonly responseId: string;
  private readonly names: ToolNames;
  private readonly createdAt: number;
  private sequence = 0;
  private started = false;
  private finished = false;
  private failed = false;
  private openKind: "reasoning" | "message" | null = null;
  private openIndex = -1;
  private openId = "";
  private openText = "";
  private nextIndex = 0;
  private readonly calls = new Map<number, { id?: string; name?: string; args: string }>();
  private readonly output: Record<string, unknown>[] = [];
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedTokens = 0;
  private reasoningTokens = 0;
  private finishReason: string | null = null;

  constructor(opts: { model: string; responseId: string; names: ToolNames; createdAt?: number }) {
    this.model = opts.model;
    this.responseId = opts.responseId;
    this.names = opts.names;
    this.createdAt = opts.createdAt ?? 0;
  }

  /** Feed one parsed chat.completion.chunk; returns the SSE text to send. */
  push(chunk: unknown): string {
    if (this.finished || this.failed) return "";
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
    if (!delta || typeof delta !== "object") return out;

    const reasoning = firstString(delta.reasoning_content, delta.reasoning);
    if (reasoning) {
      out += this.openItem("reasoning");
      this.openText += reasoning;
      out += this.emit("response.reasoning_summary_text.delta", {
        item_id: this.openId,
        output_index: this.openIndex,
        summary_index: 0,
        delta: reasoning,
      });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      out += this.openItem("message");
      this.openText += delta.content;
      out += this.emit("response.output_text.delta", {
        item_id: this.openId,
        output_index: this.openIndex,
        content_index: 0,
        delta: delta.content,
      });
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

    return out;
  }

  /** Close the response; returns the closing SSE text. Idempotent. */
  finish(): string {
    if (this.finished || this.failed) return "";
    this.finished = true;

    let out = this.startIfNeeded();
    out += this.closeItem();

    const indexes = [...this.calls.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const call = this.calls.get(index);
      if (!call) continue;
      const outputIndex = this.nextIndex++;
      const itemId = `fc_${this.responseId}_${outputIndex}`;
      const upstream = call.name ?? "";
      const mapped = this.names.get(upstream);
      const args = call.args.length > 0 ? call.args : "{}";
      const item: Record<string, unknown> = {
        type: "function_call",
        id: itemId,
        call_id: call.id ?? `call_${this.responseId}_${index}`,
        name: mapped ? mapped.name : upstream,
        arguments: args,
        status: "completed",
      };
      if (mapped?.namespace !== undefined) item.namespace = mapped.namespace;
      out += this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, arguments: "", status: "in_progress" },
      });
      out += this.emit("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: outputIndex,
        arguments: args,
      });
      out += this.emit("response.output_item.done", { output_index: outputIndex, item });
      this.output.push(item);
    }

    const usage = {
      input_tokens: this.promptTokens,
      input_tokens_details: { cached_tokens: this.cachedTokens },
      output_tokens: this.completionTokens,
      output_tokens_details: { reasoning_tokens: this.reasoningTokens },
      total_tokens: this.promptTokens + this.completionTokens,
    };
    if (this.finishReason === "length") {
      out += this.emit("response.incomplete", {
        response: this.response("incomplete", { incomplete_details: { reason: "max_output_tokens" }, usage }),
      });
    } else if (this.finishReason === "content_filter") {
      out += this.emit("response.incomplete", {
        response: this.response("incomplete", { incomplete_details: { reason: "content_filter" }, usage }),
      });
    } else {
      out += this.emit("response.completed", { response: this.response("completed", { usage }) });
    }
    return out;
  }

  /** Render a response.failed event; after this push/finish return "". */
  error(message: string): string {
    if (this.failed) return "";
    this.failed = true;
    const out = this.startIfNeeded();
    return out + this.emit("response.failed", {
      response: this.response("failed", { error: { code: "server_error", message } }),
    });
  }

  /** Emit response.created and response.in_progress exactly once. */
  private startIfNeeded(): string {
    if (this.started) return "";
    this.started = true;
    let out = this.emit("response.created", { response: this.response("in_progress") });
    out += this.emit("response.in_progress", { response: this.response("in_progress") });
    return out;
  }

  /** Open a reasoning or message item, closing whichever kind is open. */
  private openItem(kind: "reasoning" | "message"): string {
    if (this.openKind === kind) return "";
    let out = this.closeItem();
    const index = this.nextIndex++;
    this.openKind = kind;
    this.openIndex = index;
    this.openText = "";
    if (kind === "reasoning") {
      this.openId = `rs_${this.responseId}_${index}`;
      out += this.emit("response.output_item.added", {
        output_index: index,
        item: { type: "reasoning", id: this.openId, summary: [] },
      });
      out += this.emit("response.reasoning_summary_part.added", {
        item_id: this.openId,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    } else {
      this.openId = `msg_${this.responseId}_${index}`;
      out += this.emit("response.output_item.added", {
        output_index: index,
        item: { type: "message", id: this.openId, role: "assistant", status: "in_progress", content: [] },
      });
      out += this.emit("response.content_part.added", {
        item_id: this.openId,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    return out;
  }

  /** Close the open item and record it as completed output. */
  private closeItem(): string {
    if (this.openKind === null) return "";
    const kind = this.openKind;
    const index = this.openIndex;
    const id = this.openId;
    const text = this.openText;
    this.openKind = null;

    let out = "";
    if (kind === "reasoning") {
      out += this.emit("response.reasoning_summary_text.done", {
        item_id: id,
        output_index: index,
        summary_index: 0,
        text,
      });
      out += this.emit("response.reasoning_summary_part.done", {
        item_id: id,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text },
      });
      const item = {
        type: "reasoning",
        id,
        summary: [{ type: "summary_text", text }],
        encrypted_content: `cubiq:${encodeReasoning(text)}`,
      };
      out += this.emit("response.output_item.done", { output_index: index, item });
      this.output.push(item);
    } else {
      out += this.emit("response.output_text.done", { item_id: id, output_index: index, content_index: 0, text });
      out += this.emit("response.content_part.done", {
        item_id: id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      });
      const item = {
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      out += this.emit("response.output_item.done", { output_index: index, item });
      this.output.push(item);
    }
    return out;
  }

  /** The response object shared by created/in_progress/final events. */
  private response(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      model: this.model,
      status,
      output: [...this.output],
      ...extra,
    };
  }

  /** Render one SSE event with its `type` and increasing `sequence_number`. */
  private emit(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...data })}\n\n`;
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
