// What every protocol adapter provides, and the small helpers they share.

import type { AssistantPart, FinishReason, LlmEvent, LlmRequest, LlmUsage, ToolCallPart } from "../types";
import { LlmError, emptyUsage } from "../types";

/** Turns one SSE `data` payload at a time into harness events; `end` yields the finish. */
export interface StreamStepper {
  push(data: string): LlmEvent[];
  end(): LlmEvent[];
}

export interface Protocol {
  /** The request body (always streaming). */
  body(req: LlmRequest): Record<string, unknown>;
  stepper(): StreamStepper;
}

/** Parse a tool call's argument text; invalid JSON is kept so the loop can tell the model. */
export function toolCall(id: string, name: string, args: string): ToolCallPart {
  const text = args.trim();
  if (text === "") return { type: "tool-call", id, name, input: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { type: "tool-call", id, name, input: parsed as Record<string, unknown> };
  } catch {
    // fall through
  }
  return { type: "tool-call", id, name, input: {}, invalidInput: text };
}

/** Accumulates text and reasoning in arrival order, merging runs of the same kind. */
export class PartBuilder {
  readonly parts: AssistantPart[] = [];

  text(delta: string): void {
    const last = this.parts.at(-1);
    if (last?.type === "text") last.text += delta;
    else this.parts.push({ type: "text", text: delta });
  }

  reasoning(delta: string): void {
    const last = this.parts.at(-1);
    if (last?.type === "reasoning" && !last.replay) last.text += delta;
    else this.parts.push({ type: "reasoning", text: delta });
  }

  push(part: AssistantPart): void {
    this.parts.push(part);
  }

  /** The finished message: empty text parts dropped. */
  done(): AssistantPart[] {
    return this.parts.filter((p) => !(p.type === "text" && p.text === ""));
  }
}

export function finishEvent(reason: FinishReason, message: AssistantPart[], usage: LlmUsage): LlmEvent {
  return { type: "finish", reason, message, usage };
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** JSON.parse that yields null instead of throwing (keep-alives and vendor noise). */
export function parseJson(data: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(data) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** An error event inside a 200 stream, as an LlmError of the right kind. */
export function streamError(message: string, code?: unknown): LlmError {
  const c = typeof code === "string" ? code : "";
  if (/overloaded|server_error|internal|timeout|unavailable/i.test(c)) return new LlmError(message, "transient");
  if (/rate_limit/i.test(c)) return new LlmError(message, "rate-limit");
  if (/context_length|too_long|context_window/i.test(c) || isOverflowMessage(message)) return new LlmError(message, "overflow");
  return new LlmError(message, "other");
}

const OVERFLOW_RE =
  /context[ _-]?length|context window|maximum context|prompt is too long|input is too long|too many (input )?tokens|exceeds? the (model'?s? )?(maximum )?context|reduce the length|max_prompt_tokens/i;

export function isOverflowMessage(message: string): boolean {
  return OVERFLOW_RE.test(message);
}

export { emptyUsage };

/** `data:` URL for an image part. */
export const dataUrl = (mediaType: string, data: string): string => `data:${mediaType};base64,${data}`;
