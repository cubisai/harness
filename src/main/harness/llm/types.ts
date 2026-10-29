// CubiQ's own LLM language: one request, message and event shape for every
// provider. Each wire protocol (protocols/*) lowers a request into its body and
// steps its stream back into these events; nothing above llm/ sees a vendor shape.

/** The wire protocols the harness speaks; Gemini comes later. */
export type HarnessProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";

/** Thinking depth, as the model family names it; adapters map it to their own knobs. */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type UserPart = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string };

/**
 * Reasoning the model produced. `text` is what it showed (may be empty); `replay`
 * is whatever the provider needs back verbatim on the next call of the same tool
 * loop (Anthropic's signature or redacted data, Responses' encrypted item).
 */
export interface ReasoningPart {
  type: "reasoning";
  text: string;
  replay?: { protocol: HarnessProtocol; data: Record<string, unknown> };
}

export interface ToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  /** Parsed arguments; `{}` when the model sent none. */
  input: Record<string, unknown>;
  /** Set when the arguments weren't valid JSON: the raw text, so the loop can tell the model. */
  invalidInput?: string;
}

export type AssistantPart = { type: "text"; text: string } | ReasoningPart | ToolCallPart;

export interface ToolResult {
  callId: string;
  name: string;
  text: string;
  isError?: boolean;
  imagePng?: string; // base64
}

export type LlmMessage =
  | { role: "user"; content: UserPart[] }
  | { role: "assistant"; content: AssistantPart[] }
  /** One message per batch of results, in the order the calls were made. */
  | { role: "tool"; results: ToolResult[] };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  /** The id sent on the wire. */
  model: string;
  /** System prompt parts, most stable first: the cache boundary goes after the last one. */
  system: string[];
  messages: LlmMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  /** Omitted = the model's default. Only sent to models that reason. */
  effort?: Effort | null;
  reasoning?: boolean;
  /** "auto" (default) marks the stable prefix on protocols with explicit caching. */
  cache?: "auto" | "none";
  /** A stable id per session, for providers that route caches by key (OpenAI prompt_cache_key). */
  cacheKey?: string;
}

/** Token counts, uncached input separate from cache reads and writes. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export type FinishReason = "stop" | "tool-calls" | "length" | "refusal" | "other";

export type LlmEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-input-delta"; id: string; name: string; delta: string }
  | { type: "usage"; usage: LlmUsage }
  /** The turn's whole assistant message, once the stream ended. */
  | { type: "finish"; reason: FinishReason; message: AssistantPart[]; usage: LlmUsage };

/** Why a call failed, so the loop can react: compact on overflow, stop on auth, retry on transient. */
export type LlmErrorKind = "overflow" | "auth" | "rate-limit" | "transient" | "bad-request" | "aborted" | "other";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    readonly status: number | null = null,
    /** Seconds the provider asked to wait (retry-after), when it said. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export const emptyUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
