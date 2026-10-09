// OpenAI Responses, stateless: `store: false`, the whole history sent each
// call, and reasoning items kept encrypted (`include: reasoning.encrypted_content`)
// so a reasoning model keeps its chain across a tool loop.

import type { FinishReason, LlmEvent, LlmMessage, LlmRequest, LlmUsage } from "../types";
import { emptyUsage } from "../types";
import { PartBuilder, dataUrl, finishEvent, num, parseJson, streamError, toolCall, type Protocol, type StreamStepper } from "./shared";

function lower(m: LlmMessage): unknown[] {
  if (m.role === "user") {
    return [
      {
        role: "user",
        content: m.content.map((p) => (p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: dataUrl(p.mediaType, p.data) })),
      },
    ];
  }
  if (m.role === "assistant") {
    const out: unknown[] = [];
    for (const p of m.content) {
      if (p.type === "reasoning") {
        if (p.replay?.protocol === "openai-responses") out.push(p.replay.data);
      } else if (p.type === "text") {
        if (p.text) out.push({ role: "assistant", content: [{ type: "output_text", text: p.text }] });
      } else {
        out.push({ type: "function_call", call_id: p.id, name: p.name, arguments: p.invalidInput ?? JSON.stringify(p.input) });
      }
    }
    return out;
  }
  const out: unknown[] = m.results.map((r) => ({ type: "function_call_output", call_id: r.callId, output: r.isError ? `Error: ${r.text}` : r.text }));
  const images = m.results.filter((r) => r.imagePng);
  if (images.length) {
    out.push({
      role: "user",
      content: [{ type: "input_text", text: `Images from ${images.map((r) => r.name).join(", ")}:` }, ...images.map((r) => ({ type: "input_image", image_url: dataUrl("image/png", r.imagePng!) }))],
    });
  }
  return out;
}

function body(req: LlmRequest): Record<string, unknown> {
  const instructions = req.system.filter(Boolean).join("\n\n");
  return {
    model: req.model,
    ...(instructions ? { instructions } : {}),
    input: req.messages.flatMap(lower),
    stream: true,
    store: false,
    // Responses makes function tools strict by default, which our optional arguments can't meet.
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
    ...(req.maxTokens ? { max_output_tokens: req.maxTokens } : {}),
    ...(req.reasoning ? { reasoning: { ...(req.effort ? { effort: req.effort } : {}), summary: "auto" }, include: ["reasoning.encrypted_content"] } : {}),
    ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
  };
}

function usageOf(u: Record<string, unknown> | undefined): LlmUsage {
  if (!u) return emptyUsage();
  const input = num(u.input_tokens) ?? 0;
  const cached = num((u.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  return {
    inputTokens: Math.max(0, input - (cached ?? 0)),
    outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    reasoningTokens: num((u.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens),
  };
}

function stepper(): StreamStepper {
  const parts = new PartBuilder();
  /** item id → the function call it streams arguments for. */
  const pending = new Map<string, { callId: string; name: string }>();
  let usage: LlmUsage = emptyUsage();
  let reason: FinishReason = "stop";
  let calls = 0;
  /** Delta text, used only when the server never sends the finished message item. */
  let deltaText = "";
  let sawMessage = false;

  return {
    push(data) {
      const e = parseJson(data);
      if (!e) return [];
      const type = e.type as string | undefined;
      const events: LlmEvent[] = [];
      switch (type) {
        case "response.output_text.delta":
          if (typeof e.delta === "string" && e.delta) {
            deltaText += e.delta;
            events.push({ type: "text-delta", text: e.delta });
          }
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (typeof e.delta === "string" && e.delta) events.push({ type: "reasoning-delta", text: e.delta });
          break;
        case "response.output_item.added": {
          const item = e.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call" && typeof item.id === "string") pending.set(item.id, { callId: String(item.call_id ?? item.id), name: String(item.name ?? "") });
          break;
        }
        case "response.function_call_arguments.delta": {
          const call = pending.get(String(e.item_id));
          if (call && typeof e.delta === "string" && e.delta) events.push({ type: "tool-input-delta", id: call.callId, name: call.name, delta: e.delta });
          break;
        }
        case "response.output_item.done": {
          // The finished item is the source of truth for the message, whatever the deltas said.
          const item = e.item as Record<string, unknown> | undefined;
          if (!item) break;
          if (item.type === "message") {
            sawMessage = true;
            for (const c of (item.content as Record<string, unknown>[] | undefined) ?? []) {
              if (c.type === "output_text" && typeof c.text === "string") parts.text(c.text);
              else if (c.type === "refusal" && typeof c.refusal === "string") {
                parts.text(c.refusal);
                reason = "refusal";
              }
            }
          } else if (item.type === "reasoning") {
            const summary = ((item.summary as Record<string, unknown>[] | undefined) ?? []).map((s) => (typeof s.text === "string" ? s.text : "")).join("\n\n");
            const content = ((item.content as Record<string, unknown>[] | undefined) ?? []).map((s) => (typeof s.text === "string" ? s.text : "")).join("");
            const { status: _status, ...replay } = item;
            parts.push({ type: "reasoning", text: summary || content, replay: { protocol: "openai-responses", data: replay } });
          } else if (item.type === "function_call") {
            calls += 1;
            parts.push(toolCall(String(item.call_id ?? item.id), String(item.name ?? ""), typeof item.arguments === "string" ? item.arguments : ""));
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const response = e.response as Record<string, unknown> | undefined;
          usage = usageOf(response?.usage as Record<string, unknown> | undefined);
          events.push({ type: "usage", usage });
          const why = (response?.incomplete_details as Record<string, unknown> | undefined)?.reason;
          if (type === "response.incomplete") reason = why === "content_filter" ? "refusal" : "length";
          break;
        }
        case "response.failed": {
          const err = (e.response as Record<string, unknown> | undefined)?.error as Record<string, unknown> | undefined;
          throw streamError(typeof err?.message === "string" ? err.message : "The response failed.", err?.code);
        }
        case "error":
          throw streamError(typeof e.message === "string" ? e.message : "The provider's stream reported an error.", e.code);
      }
      return events;
    },
    end() {
      // A server that only sent deltas (no output_item.done) still yields its text.
      if (!sawMessage && deltaText) parts.text(deltaText);
      const message = parts.done();
      return [finishEvent(calls > 0 && reason === "stop" ? "tool-calls" : reason, message, usage)];
    },
  };
}

export const openaiResponses: Protocol = { body, stepper };
