// Calling a provider: where to send (route), and one streamed call with the
// retry rule from OpenCode v2's design: retry transient failures and rate
// limits only before any output was seen, never after.

import type { Provider } from "../../../shared/types";
import { createSseParser } from "../../gateway/chat-stream";
import { buildHeaders, endpointsFor, upstreamMessage } from "../../providers";
import { anthropicMessages } from "./protocols/anthropic-messages";
import { openaiChat } from "./protocols/openai-chat";
import { openaiResponses } from "./protocols/openai-responses";
import { isOverflowMessage, type Protocol } from "./protocols/shared";
import type { AssistantPart, FinishReason, HarnessProtocol, LlmEvent, LlmRequest, LlmUsage } from "./types";
import { LlmError } from "./types";

export const PROTOCOLS: Record<HarnessProtocol, Protocol> = {
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages,
};

/** Where one call goes: the URL and every header, key included. Built in main, never logged. */
export interface Route {
  protocol: HarnessProtocol;
  url: string;
  headers: Record<string, string>;
  /** For error messages: "TokenHarbor". */
  label: string;
  /** Masked out of any upstream error text. */
  key: string | null;
}

const ENV_REF = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * The route for a provider on one of its protocols. Literal headers pass through,
 * `${env:VAR}` ones are read from `env` (left out when unset), secret headers win.
 */
export function routeFor(
  provider: Provider,
  protocol: HarnessProtocol,
  wireModel: string,
  key: string | null,
  secretHeaders: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Route {
  const on = { ...provider, wireProtocol: protocol };
  const headers = buildHeaders(on, key);
  for (const [name, value] of Object.entries(headers)) {
    const ref = ENV_REF.exec(value.trim());
    if (!ref) continue;
    const v = env[ref[1]!];
    if (v) headers[name] = v;
    else delete headers[name];
  }
  for (const [name, value] of Object.entries(secretHeaders)) {
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    headers[name] = value;
  }
  headers.accept = "text/event-stream";
  return { protocol, url: endpointsFor(on, wireModel).generate, headers, label: provider.label, key };
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Retries before any output; default 2. */
  retries?: number;
  /** Give up on a stream that sends nothing for this long; default 5 minutes. */
  idleTimeoutMs?: number;
  fetch?: typeof fetch;
  /** Tests: skip real waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const RETRYABLE = new Set(["transient", "rate-limit"]);

/** An HTTP error status and body as an LlmError of the right kind. */
export function httpError(route: Route, status: number, text: string, retryAfter: string | null): LlmError {
  const detail = upstreamMessage(text, route.key) ?? `HTTP ${status}.`;
  const message = `${route.label}: ${detail}`;
  const wait = retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : null;
  if (status === 401 || status === 403) return new LlmError(message, "auth", status);
  if (status === 429) return new LlmError(message, "rate-limit", status, wait);
  if (status === 413 || ((status === 400 || status === 422) && isOverflowMessage(detail))) return new LlmError(message, "overflow", status);
  if (status === 408 || status === 409 || status === 425 || status >= 500) return new LlmError(message, "transient", status, wait);
  return new LlmError(message, "bad-request", status);
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * One model call, streamed as harness events; the last is always `finish`.
 * Throws LlmError (kind "aborted" when the signal fired).
 */
export async function* streamLlm(route: Route, req: LlmRequest, opts: StreamOptions = {}): AsyncGenerator<LlmEvent> {
  const protocol = PROTOCOLS[route.protocol];
  const body = JSON.stringify(protocol.body(req));
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? defaultSleep;
  let emitted = false;

  for (let attempt = 0; ; attempt++) {
    try {
      for await (const event of attemptOnce(route, body, protocol, opts)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (err) {
      const e = toLlmError(err, route, opts.signal);
      if (emitted || attempt >= retries || !RETRYABLE.has(e.kind)) throw e;
      const wait = e.retryAfter !== null ? Math.min(e.retryAfter * 1000, 60_000) : Math.min(1000 * 2 ** attempt, 20_000);
      await sleep(wait, opts.signal);
      if (opts.signal?.aborted) throw new LlmError("Stopped.", "aborted");
    }
  }
}

function toLlmError(err: unknown, route: Route, signal?: AbortSignal): LlmError {
  if (signal?.aborted) return new LlmError("Stopped.", "aborted");
  if (err instanceof LlmError) return err;
  const text = err instanceof Error ? err.message : String(err);
  return new LlmError(`${route.label} couldn't be reached: ${text}`, "transient");
}

async function* attemptOnce(route: Route, body: string, protocol: Protocol, opts: StreamOptions): AsyncGenerator<LlmEvent> {
  const doFetch = opts.fetch ?? fetch;
  const idleMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const local = new AbortController();
  const onAbort = () => local.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let idle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      local.abort();
    }, idleMs);
  };
  try {
    arm();
    let res: Response;
    try {
      res = await doFetch(route.url, { method: "POST", headers: route.headers, body, signal: local.signal });
    } catch (err) {
      if (timedOut) throw new LlmError(`${route.label} didn't answer within ${Math.round(idleMs / 1000)} s.`, "transient");
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw httpError(route, res.status, text, res.headers.get("retry-after"));
    }
    const stepper = protocol.stepper();
    const queue: LlmEvent[] = [];
    // An error event is raised only after the events before it were delivered.
    let failure: unknown = null;
    const parser = createSseParser((data) => {
      if (data === "[DONE]" || failure) return;
      try {
        queue.push(...stepper.push(data));
      } catch (err) {
        failure = err;
      }
    });
    const drain = function* (): Generator<LlmEvent> {
      while (queue.length) yield queue.shift()!;
      if (failure) throw failure;
    };
    const reader = res.body?.getReader();
    if (!reader) throw new LlmError(`${route.label} answered with an empty body.`, "transient");
    const decoder = new TextDecoder();
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        if (timedOut) throw new LlmError(`${route.label} stopped sending for ${Math.round(idleMs / 1000)} s.`, "transient");
        throw err;
      }
      if (next.done) break;
      arm();
      parser.push(decoder.decode(next.value, { stream: true }));
      yield* drain();
    }
    parser.end();
    yield* drain();
    queue.push(...stepper.end());
    yield* drain();
  } finally {
    if (idle) clearTimeout(idle);
    opts.signal?.removeEventListener("abort", onAbort);
    local.abort();
  }
}

export interface LlmResult {
  message: AssistantPart[];
  reason: FinishReason;
  usage: LlmUsage;
  text: string;
}

/** Run a call to the end and return the finished message (titles, summaries, compaction). */
export async function generate(route: Route, req: LlmRequest, opts: StreamOptions = {}): Promise<LlmResult> {
  for await (const e of streamLlm(route, req, opts)) {
    if (e.type === "finish") {
      const text = e.message.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      return { message: e.message, reason: e.reason, usage: e.usage, text };
    }
  }
  throw new LlmError(`${route.label} ended the stream without an answer.`, "transient");
}
