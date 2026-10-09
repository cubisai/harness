// Anthropic Messages, on api.anthropic.com or any host that speaks it. Thinking
// blocks go back unchanged (signature and all) so a tool loop keeps its chain;
// `cache: "auto"` marks up to three breakpoints: last tool, last system part,
// and the newest user message, so every round-trip of one turn reuses the prefix.

import type { Effort, FinishReason, LlmEvent, LlmMessage, LlmRequest, LlmUsage, ReasoningPart } from "../types";
import { emptyUsage } from "../types";
import { PartBuilder, finishEvent, num, parseJson, streamError, toolCall, type Protocol, type StreamStepper } from "./shared";

const DEFAULT_MAX_TOKENS = 16_000;

/** Thinking budgets for models that still take one (pre-4.6 Claude, other vendors' Messages endpoints). */
const BUDGET: Record<Effort, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16_384, xhigh: 24_576, max: 32_000 };

/** Claude 4.6 and later think adaptively and take `output_config.effort`; budget_tokens is rejected there. */
export function adaptiveThinking(model: string): boolean {
  const m = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/i.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] !== undefined && m[2].length <= 2 ? Number(m[2]) : 0;
  return major > 4 || (major === 4 && minor >= 6);
}

type Block = Record<string, unknown>;
const EPHEMERAL = { type: "ephemeral" };

function lower(m: LlmMessage): { role: "user" | "assistant"; content: Block[] } | null {
  if (m.role === "user") {
    return {
      role: "user",
      content: m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } })),
    };
  }
  if (m.role === "assistant") {
    const content: Block[] = [];
    for (const p of m.content) {
      if (p.type === "reasoning") {
        // Only this protocol's own blocks, verbatim; thinking without a signature can't be replayed.
        if (p.replay?.protocol === "anthropic-messages") content.push(p.replay.data);
      } else if (p.type === "text") {
        if (p.text) content.push({ type: "text", text: p.text });
      } else {
        content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input });
      }
    }
    return content.length ? { role: "assistant", content } : null;
  }
  return {
    role: "user",
    content: m.results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.callId,
      content: [{ type: "text", text: r.text || "(no output)" }, ...(r.imagePng ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: r.imagePng } }] : [])],
      ...(r.isError ? { is_error: true } : {}),
    })),
  };
}

function body(req: LlmRequest): Record<string, unknown> {
  const cache = req.cache !== "none";
  const system: Block[] = req.system.filter(Boolean).map((text) => ({ type: "text", text }));
  const messages = req.messages.map(lower).filter((m): m is NonNullable<typeof m> => m !== null);
  const tools: Block[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (cache) {
    const lastTool = tools.at(-1);
    if (lastTool) tools[tools.length - 1] = { ...lastTool, cache_control: EPHEMERAL };
    const lastSystem = system.at(-1);
    if (lastSystem) system[system.length - 1] = { ...lastSystem, cache_control: EPHEMERAL };
    const lastUser = messages.findLast((m) => m.role === "user");
    const block = lastUser?.content.at(-1);
    if (lastUser && block) lastUser.content[lastUser.content.length - 1] = { ...block, cache_control: EPHEMERAL };
  }

  let maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  const extra: Record<string, unknown> = {};
  if (req.reasoning) {
    if (adaptiveThinking(req.model)) {
      extra.thinking = { type: "adaptive", display: "summarized" };
      if (req.effort) extra.output_config = { effort: req.effort === "minimal" ? "low" : req.effort };
    } else if (req.effort) {
      const budget = BUDGET[req.effort];
      maxTokens = Math.max(maxTokens, budget + 4096);
      extra.thinking = { type: "enabled", budget_tokens: budget };
    }
  }
  return {
    model: req.model,
    max_tokens: maxTokens,
    ...(system.length ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    stream: true,
    ...extra,
  };
}

function stopReason(raw: string | null, hasCalls: boolean): FinishReason {
  switch (raw) {
    case "tool_use":
      return "tool-calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    case "end_turn":
    case "stop_sequence":
    case null:
      return hasCalls ? "tool-calls" : "stop";
    default:
      return "other";
  }
}

type Open =
  | { kind: "text" }
  | { kind: "thinking"; text: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool"; id: string; name: string; args: string };

function stepper(): StreamStepper {
  const parts = new PartBuilder();
  const open = new Map<number, Open>();
  const usage: LlmUsage = emptyUsage();
  let reason: string | null = null;
  let calls = 0;

  return {
    push(data) {
      const e = parseJson(data);
      if (!e) return [];
      const events: LlmEvent[] = [];
      switch (e.type) {
        case "message_start": {
          const u = (e.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
          usage.inputTokens = num(u?.input_tokens) ?? 0;
          usage.cacheReadTokens = num(u?.cache_read_input_tokens);
          usage.cacheWriteTokens = num(u?.cache_creation_input_tokens);
          usage.outputTokens = num(u?.output_tokens) ?? 0;
          events.push({ type: "usage", usage: { ...usage } });
          break;
        }
        case "content_block_start": {
          const index = num(e.index) ?? 0;
          const b = e.content_block as Record<string, unknown> | undefined;
          if (b?.type === "text") {
            open.set(index, { kind: "text" });
            if (typeof b.text === "string" && b.text) {
              parts.text(b.text);
              events.push({ type: "text-delta", text: b.text });
            }
          } else if (b?.type === "thinking") open.set(index, { kind: "thinking", text: typeof b.thinking === "string" ? b.thinking : "", signature: typeof b.signature === "string" ? b.signature : "" });
          else if (b?.type === "redacted_thinking") open.set(index, { kind: "redacted", data: String(b.data ?? "") });
          else if (b?.type === "tool_use") open.set(index, { kind: "tool", id: String(b.id ?? `toolu_${index}`), name: String(b.name ?? ""), args: "" });
          break;
        }
        case "content_block_delta": {
          const block = open.get(num(e.index) ?? 0);
          const d = e.delta as Record<string, unknown> | undefined;
          if (!block || !d) break;
          if (d.type === "text_delta" && typeof d.text === "string" && block.kind === "text") {
            parts.text(d.text);
            events.push({ type: "text-delta", text: d.text });
          } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && block.kind === "thinking") {
            block.text += d.thinking;
            events.push({ type: "reasoning-delta", text: d.thinking });
          } else if (d.type === "signature_delta" && typeof d.signature === "string" && block.kind === "thinking") {
            block.signature += d.signature;
          } else if (d.type === "input_json_delta" && typeof d.partial_json === "string" && block.kind === "tool") {
            block.args += d.partial_json;
            if (d.partial_json) events.push({ type: "tool-input-delta", id: block.id, name: block.name, delta: d.partial_json });
          }
          break;
        }
        case "content_block_stop": {
          const index = num(e.index) ?? 0;
          const block = open.get(index);
          open.delete(index);
          if (!block) break;
          if (block.kind === "thinking") {
            const part: ReasoningPart = { type: "reasoning", text: block.text };
            if (block.signature) part.replay = { protocol: "anthropic-messages", data: { type: "thinking", thinking: block.text, signature: block.signature } };
            parts.push(part);
          } else if (block.kind === "redacted") {
            parts.push({ type: "reasoning", text: "", replay: { protocol: "anthropic-messages", data: { type: "redacted_thinking", data: block.data } } });
          } else if (block.kind === "tool") {
            calls += 1;
            parts.push(toolCall(block.id, block.name, block.args));
          }
          break;
        }
        case "message_delta": {
          const d = e.delta as Record<string, unknown> | undefined;
          if (typeof d?.stop_reason === "string") reason = d.stop_reason;
          const u = e.usage as Record<string, unknown> | undefined;
          if (u) {
            usage.outputTokens = num(u.output_tokens) ?? usage.outputTokens;
            // Some hosts report input only here.
            if (num(u.input_tokens) !== null && usage.inputTokens === 0) usage.inputTokens = num(u.input_tokens)!;
            if (num(u.cache_read_input_tokens) !== null) usage.cacheReadTokens = num(u.cache_read_input_tokens);
            if (num(u.cache_creation_input_tokens) !== null) usage.cacheWriteTokens = num(u.cache_creation_input_tokens);
            events.push({ type: "usage", usage: { ...usage } });
          }
          break;
        }
        case "error": {
          const err = e.error as Record<string, unknown> | undefined;
          throw streamError(typeof err?.message === "string" ? err.message : "The provider's stream reported an error.", err?.type);
        }
      }
      return events;
    },
    end() {
      return [finishEvent(stopReason(reason, calls > 0), parts.done(), { ...usage })];
    },
  };
}

export const anthropicMessages: Protocol = { body, stepper };
