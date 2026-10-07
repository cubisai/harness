// The translation gateway's HTTP side: `/llm/<providerId>/…` on the tool
// server. An agent CLI that can't speak a provider's protocol (Claude Code on
// a chat-completions provider) talks to this route instead; it translates, adds
// the provider's key here in main, and streams the answer back translated. The
// key never reaches the agent's env, argv or files.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Provider } from "../../shared/types";
import { buildHeaders, endpointsFor, upstreamMessage, wireIdOf } from "../providers";
import { ENV_REF, headerPlan, resolvedHeaders } from "../inject/headers";
import { ChatToAnthropicStream, anthropicToChat, chatToAnthropicMessage } from "./anthropic-chat";
import { createSseParser } from "./chat-stream";

/** Request bodies past this are refused (413): a long session with images stays well under it. */
export const LLM_BODY_LIMIT = 32 * 1024 * 1024;

export interface GatewayDeps {
  providers(): Provider[];
  /** The provider's key, decrypted; null when none is saved. */
  secret(id: string): string | null;
  /** The provider's secret headers, decrypted (name → value). */
  secretHeaders(id: string): Record<string, string>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Tests only: a smaller body cap than LLM_BODY_LIMIT. */
  bodyLimit?: number;
}

/** `/llm/<providerId>/<rest>` → its parts, or null for any other path. */
export function parseLlmPath(path: string): { providerId: string; rest: string } | null {
  const m = /^\/llm\/([a-z0-9][a-z0-9-]{0,62})(\/.*)?$/.exec(path);
  return m ? { providerId: m[1]!, rest: m[2] ?? "/" } : null;
}

/** Whether a provider is reached through the gateway by this injector (rather than directly, or not at all). */
export function viaGateway(provider: Pick<Provider, "wireProtocol">, injector: string): boolean {
  return injector === "claude" && provider.wireProtocol === "openai-chat";
}

type ReadResult = { ok: true; body: unknown } | { ok: false; status: 400 | 413 };

async function readBody(req: IncomingMessage, limit: number): Promise<ReadResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return { ok: false, status: 413 };
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400 };
  }
}

const ANTHROPIC_ERROR_TYPE: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
};

/**
 * An error in Anthropic's shape. A 404 goes out as 400: Claude Code answers a
 * 404 by retrying without streaming and then blaming "the selected model".
 */
function anthropicError(res: ServerResponse, status: number, message: string): void {
  const out = status === 404 ? 400 : status;
  if (res.headersSent) return void res.end();
  res.writeHead(out, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: ANTHROPIC_ERROR_TYPE[out] ?? "api_error", message } }));
}

/** The upstream's headers: auth and literal headers, `${env:VAR}` and secret ones filled in, unset refs left out. */
function upstreamHeaders(provider: Provider, key: string | null, secretHeaders: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers = { ...buildHeaders(provider, key), ...resolvedHeaders(headerPlan(provider, secretHeaders), env) };
  for (const [name, value] of Object.entries(headers)) if (ENV_REF.test(value.trim())) delete headers[name];
  return headers;
}

let messageCounter = 0;

/**
 * The gateway handler for one `/llm/<providerId>/…` request. Serves Claude
 * Code's connectivity check (`/api/hello`), `POST /v1/messages` (streaming and
 * not) and a rough `count_tokens`.
 */
export function createGateway(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse, providerId: string, rest: string) => Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  return async (req, res, providerId, rest) => {
    if (rest === "/api/hello" || rest === "/") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
    const provider = deps.providers().find((p) => p.id === providerId);
    if (!provider) return anthropicError(res, 400, "This provider no longer exists in CubiQ.");
    if (!viaGateway(provider, "claude")) return anthropicError(res, 400, `${provider.label} speaks ${provider.wireProtocol}; the gateway translates only chat-completions providers.`);

    const read = await readBody(req, deps.bodyLimit ?? LLM_BODY_LIMIT);
    if (!read.ok) return anthropicError(res, read.status, read.status === 413 ? "The request is larger than the gateway accepts (32 MB)." : "The request body isn't JSON.");
    const body = read.body as { model?: unknown; stream?: unknown; messages?: unknown };

    if (rest === "/v1/messages/count_tokens") {
      // Not called by Claude Code today; a bytes/4 estimate keeps it from failing if it ever is.
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body.messages ?? []).length / 4) }));
    }
    if (rest !== "/v1/messages") return anthropicError(res, 400, `The gateway doesn't serve ${rest}.`);

    const wire = typeof body.model === "string" ? body.model : (provider.models[0] ? wireIdOf(provider.models[0], provider.models[0].id) : "");
    const model = provider.models.find((m) => wireIdOf(m, m.id) === wire);
    const chat = anthropicToChat(body as never, {
      model: wire,
      ...(model?.maxOutput ? { maxOutput: model.maxOutput } : {}),
      reasoning: model?.capabilities.reasoning === true,
    });
    const key = deps.secret(provider.id);
    const env = deps.env ?? process.env;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    let upstream: Response;
    try {
      upstream = await doFetch(endpointsFor(provider, wire).generate, {
        method: "POST",
        headers: upstreamHeaders(provider, key, deps.secretHeaders(provider.id), env),
        body: JSON.stringify(chat),
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      return anthropicError(res, 502, `${provider.label} couldn't be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return anthropicError(res, upstream.status, `${provider.label}: ${upstreamMessage(text, key) ?? `HTTP ${upstream.status}.`}`);
    }

    const messageId = `msg_gw_${Date.now().toString(36)}_${(++messageCounter).toString(36)}`;
    if (body.stream !== true) {
      let json: unknown;
      try {
        json = await upstream.json();
      } catch {
        return anthropicError(res, 502, `${provider.label} answered with something that isn't JSON.`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(chatToAnthropicMessage(json, { model: wire, messageId })));
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const stream = new ChatToAnthropicStream({ model: wire, messageId });
    // After an error event the turn is over: nothing else is sent, not even a normal finish.
    let failed = false;
    const parser = createSseParser((data) => {
      if (data === "[DONE]" || failed) return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        return; // a keep-alive or vendor line that isn't a chunk
      }
      const failure = (chunk as { error?: unknown }).error;
      if (failure) {
        failed = true;
        res.write(stream.error(`${provider.label}: ${upstreamMessage(data, key) ?? "the stream failed."}`));
        return;
      }
      const out = stream.push(chunk);
      if (out) res.write(out);
    });
    try {
      const decoder = new TextDecoder();
      const reader = upstream.body?.getReader();
      for (let next = await reader?.read(); next && !next.done; next = await reader!.read()) parser.push(decoder.decode(next.value, { stream: true }));
      parser.end();
      res.end(failed ? undefined : stream.finish());
    } catch (err) {
      if (abort.signal.aborted) return;
      res.end(stream.error(`${provider.label}: the stream broke off (${err instanceof Error ? err.message : String(err)}).`));
    }
  };
}
