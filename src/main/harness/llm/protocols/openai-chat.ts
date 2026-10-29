// OpenAI chat completions, as nearly every OpenAI-compatible host serves it
// (TokenHarbor, OpenRouter, DeepSeek, Groq, local servers). Reasoning arrives
// as `reasoning_content` (DeepSeek, Qwen) or `reasoning` (OpenRouter) and is
// sent back as `reasoning_content`, which DeepSeek needs inside a tool loop.

import type { FinishReason, LlmEvent, LlmMessage, LlmRequest, LlmUsage } from "../types";
import { emptyUsage } from "../types";
import { PartBuilder, dataUrl, finishEvent, num, parseJson, streamError, toolCall, type Protocol, type StreamStepper } from "./shared";

function messages(req: LlmRequest): unknown[] {
  const out: unknown[] = [];
  const system = req.system.filter(Boolean).join("\n\n");
  if (system) out.push({ role: "system", content: system });
  for (const m of req.messages) out.push(...lower(m));
  return out;
}

function lower(m: LlmMessage): unknown[] {
  if (m.role === "user") {
    if (m.content.every((p) => p.type === "text")) return [{ role: "user", content: m.content.map((p) => (p as { text: string }).text).join("\n\n") }];
    return [
      {
        role: "user",
        content: m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: dataUrl(p.mediaType, p.data) } })),
      },
    ];
  }
  if (m.role === "assistant") {
    const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    const reasoning = m.content.flatMap((p) => (p.type === "reasoning" ? [p.text] : [])).join("");
    const calls = m.content.flatMap((p) => (p.type === "tool-call" ? [{ id: p.id, type: "function", function: { name: p.name, arguments: p.invalidInput ?? JSON.stringify(p.input) } }] : []));
    return [
      {
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
    ];
  }
  // Tool messages carry text only; images follow in one user message.
  const out: unknown[] = m.results.map((r) => ({ role: "tool", tool_call_id: r.callId, content: r.isError ? `Error: ${r.text}` : r.text }));
  const images = m.results.filter((r) => r.imagePng);
  if (images.length) {
    out.push({
      role: "user",
      content: [{ type: "text", text: `Images from ${images.map((r) => r.name).join(", ")}:` }, ...images.map((r) => ({ type: "image_url", image_url: { url: dataUrl("image/png", r.imagePng!) } }))],
    });
  }
  return out;
}

function body(req: LlmRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: messages(req),
    stream: true,
    stream_options: { include_usage: true },
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.reasoning && req.effort ? { reasoning_effort: req.effort } : {}),
  };
}

function finishReason(raw: string | null, hasCalls: boolean): FinishReason {
  if (hasCalls) return "tool-calls";
  if (raw === "length") return "length";
  if (raw === "content_filter") return "refusal";
  if (raw === "stop" || raw === null) return "stop";
  return raw === "tool_calls" || raw === "function_call" ? "tool-calls" : "other";
}

function stepper(): StreamStepper {
  const parts = new PartBuilder();
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let usage: LlmUsage = emptyUsage();
  let reason: string | null = null;

  const step = (chunk: Record<string, unknown>): LlmEvent[] => {
    const err = chunk.error as { message?: unknown; code?: unknown; type?: unknown } | undefined;
    if (err) throw streamError(typeof err.message === "string" ? err.message : "The provider's stream reported an error.", err.code ?? err.type);
    const events: LlmEvent[] = [];
    const u = chunk.usage as Record<string, unknown> | undefined | null;
    if (u) {
      const prompt = num(u.prompt_tokens) ?? 0;
      const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
      const cached = num(details?.cached_tokens) ?? num(u.prompt_cache_hit_tokens);
      const out = u.completion_tokens_details as Record<string, unknown> | undefined;
      usage = {
        inputTokens: Math.max(0, prompt - (cached ?? 0)),
        outputTokens: num(u.completion_tokens) ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: null,
        reasoningTokens: num(out?.reasoning_tokens),
      };
      events.push({ type: "usage", usage });
    }
    const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
    if (!choice) return events;
    if (typeof choice.finish_reason === "string") reason = choice.finish_reason;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return events;
    const thought = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (thought) {
      parts.reasoning(thought);
      events.push({ type: "reasoning-delta", text: thought });
    }
    if (typeof delta.content === "string" && delta.content) {
      parts.text(delta.content);
      events.push({ type: "text-delta", text: delta.content });
    }
    for (const f of (delta.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
      const index = num(f.index) ?? 0;
      const fn = f.function as { name?: unknown; arguments?: unknown } | undefined;
      const entry = calls.get(index) ?? { id: "", name: "", args: "" };
      if (typeof f.id === "string" && f.id) entry.id = f.id;
      if (typeof fn?.name === "string" && fn.name) entry.name = fn.name;
      if (typeof fn?.arguments === "string") {
        entry.args += fn.arguments;
        if (fn.arguments) events.push({ type: "tool-input-delta", id: entry.id || `call_${index}`, name: entry.name, delta: fn.arguments });
      }
      calls.set(index, entry);
    }
    return events;
  };

  return {
    push(data) {
      // Some servers put several chunks in one event, one per line.
      const out: LlmEvent[] = [];
      for (const line of data.includes("\n") ? data.split("\n") : [data]) {
        const chunk = parseJson(line);
        if (chunk) out.push(...step(chunk));
      }
      return out;
    },
    end() {
      const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
      for (const [index, c] of ordered) parts.push(toolCall(c.id || `call_${index}`, c.name, c.args));
      return [finishEvent(finishReason(reason, ordered.length > 0), parts.done(), usage)];
    },
  };
}

export const openaiChat: Protocol = { body, stepper };
