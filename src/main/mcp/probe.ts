import type { McpProbeResult } from "../../shared/types";

/** How long a single request may go unanswered before the probe gives up. */
const DEFAULT_TIMEOUT_MS = 8000;

/** Statuses that mean "not this transport", so the probe tries the legacy SSE one. */
const LEGACY_SSE_STATUSES = new Set([400, 404, 405, 406, 415]);

/** The MCP protocol revision this probe speaks. */
const PROTOCOL_VERSION = "2025-06-18";

interface ProbeCtx {
  fetchFn: typeof fetch;
  timeoutMs: number;
}

interface Attempt {
  res: Response;
  /** True when this request's own timeout aborted it. */
  timedOut: () => boolean;
  /** Clears the timeout once the body is no longer needed. */
  done: () => void;
}

function timeoutMessage(ms: number): string {
  return `No answer in ${Math.round(ms / 1000)} seconds.`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** result.serverInfo.name, when an initialize answer carried one. */
function serverNameOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const result = body.result;
  if (!isRecord(result)) return undefined;
  const info = result.serverInfo;
  if (!isRecord(info)) return undefined;
  return typeof info.name === "string" ? info.name : undefined;
}

/** One fetch with its own abort-based timeout, so no request can hang forever. */
async function fetchAttempt(ctx: ProbeCtx, url: string, init: RequestInit): Promise<{ ok: true; attempt: Attempt } | { ok: false; error: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.timeoutMs);
  try {
    const res = await ctx.fetchFn(url, { ...init, signal: controller.signal });
    return { ok: true, attempt: { res, timedOut: () => timedOut, done: () => clearTimeout(timer) } };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: timedOut ? timeoutMessage(ctx.timeoutMs) : messageOf(err) };
  }
}

/** Read an SSE body line by line; cancel the reader as soon as `onLine` asks to stop. */
async function readLines(res: Response, onLine: (line: string) => boolean, timedOut: () => boolean): Promise<"stopped" | "ended" | "timeout"> {
  const reader = res.body?.getReader();
  if (!reader) return "ended";
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "ended";
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (onLine(line)) {
          await reader.cancel().catch(() => undefined);
          return "stopped";
        }
        nl = buffer.indexOf("\n");
      }
    }
  } catch {
    return timedOut() ? "timeout" : "ended";
  }
}

/** The value of an SSE `data:` line, or undefined for every other field. */
function dataOf(line: string): string | undefined {
  return line.startsWith("data:") ? line.slice(5).replace(/^ /, "") : undefined;
}

/** Read the initialize answer from a 200 response: plain JSON, or an SSE stream. */
async function readInitialize(res: Response, timedOut: () => boolean): Promise<{ serverName?: string; timedOut: boolean }> {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/event-stream")) {
    let serverName: string | undefined;
    const outcome = await readLines(
      res,
      (line) => {
        const data = dataOf(line);
        if (data === undefined) return false;
        let body: unknown;
        try {
          body = JSON.parse(data);
        } catch {
          return false;
        }
        // The first line carrying a `result` is the initialize answer.
        if (!isRecord(body) || !("result" in body)) return false;
        serverName = serverNameOf(body) ?? serverName;
        return true;
      },
      timedOut,
    );
    return { serverName, timedOut: outcome === "timeout" };
  }
  try {
    return { serverName: serverNameOf(await res.json()), timedOut: false };
  } catch {
    return { timedOut: false };
  }
}

/** The legacy transport answers the initialize POST with an SSE endpoint event. */
async function readSseEndpoint(res: Response, timedOut: () => boolean): Promise<"stopped" | "ended" | "timeout"> {
  return readLines(res, (line) => line.trim() === "event: endpoint", timedOut);
}

/** Best-effort session teardown: a DELETE bounded to about a second, errors ignored. */
async function cancelSession(ctx: ProbeCtx, url: string, sessionId: string | null, headers: Record<string, string> | undefined): Promise<void> {
  if (!sessionId) return;
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 1000);
  const request = ctx.fetchFn(url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sessionId }, signal: controller.signal }).catch(() => undefined);
  let limit: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    request,
    new Promise<void>((resolve) => {
      limit = setTimeout(resolve, 1000);
    }),
  ]);
  clearTimeout(abort);
  if (limit) clearTimeout(limit);
}

/** Ask a 401/403 response what kind of credential it wants. */
async function authKind(res: Response, url: URL, ctx: ProbeCtx): Promise<Pick<McpProbeResult, "auth" | "resourceMetadata">> {
  const challenge = res.headers.get("www-authenticate") ?? "";
  const declared = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge);
  if (declared?.[1]) return { auth: "oauth", resourceMetadata: declared[1] };

  // RFC 9728: the protected-resource metadata sits beside the path, else at the origin root.
  const metadata = [`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`, `${url.origin}/.well-known/oauth-protected-resource`];
  if (url.pathname === "/" || url.pathname === "") metadata.shift();
  for (const candidate of metadata) {
    const attempt = await fetchAttempt(ctx, candidate, { method: "GET" });
    if (!attempt.ok) continue;
    try {
      if (attempt.attempt.res.status !== 200) continue;
      const body: unknown = await attempt.attempt.res.json();
      const servers = isRecord(body) ? body.authorization_servers : undefined;
      if (Array.isArray(servers) && servers.length > 0) return { auth: "oauth", resourceMetadata: candidate };
    } catch {
      // Not JSON: not a metadata document.
    } finally {
      attempt.attempt.done();
    }
  }
  return { auth: "token" };
}

/**
 * Knock on an MCP URL without saving anything: which transport answers
 * (Streamable HTTP or legacy SSE), whether it needs a sign-in, and its name.
 * Never throws; a failure comes back as `{ ok: false, error }`.
 */
export async function probeMcpUrl(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<McpProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, auth: "none", error: "The URL has to start with http:// or https://." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, auth: "none", error: "The URL has to start with http:// or https://." };
  }

  const ctx: ProbeCtx = { fetchFn: opts.fetchFn ?? fetch, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  const target = parsed.toString();

  try {
    // Streamable HTTP first: one initialize POST tells us the transport and the auth.
    const first = await fetchAttempt(ctx, target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...opts.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cubiq", version: "1.0.0" } },
      }),
    });
    if (!first.ok) return { ok: false, auth: "none", error: first.error };

    const res = first.attempt.res;
    if (res.status === 200) {
      const { serverName, timedOut } = await readInitialize(res, first.attempt.timedOut);
      first.attempt.done();
      if (timedOut) return { ok: false, auth: "none", error: timeoutMessage(ctx.timeoutMs) };
      await cancelSession(ctx, target, res.headers.get("mcp-session-id"), opts.headers);
      return { ok: true, transport: "http", auth: "none", ...(serverName ? { serverName } : {}) };
    }
    if (res.status === 401 || res.status === 403) {
      const kind = await authKind(res, parsed, ctx);
      first.attempt.done();
      return { ok: true, transport: "http", ...kind };
    }
    first.attempt.done();
    if (!LEGACY_SSE_STATUSES.has(res.status)) {
      return { ok: false, auth: "none", error: `The server answered HTTP ${res.status}.` };
    }

    // The newer transport wasn't there: the older SSE transport may be.
    const second = await fetchAttempt(ctx, target, { method: "GET", headers: { accept: "text/event-stream", ...opts.headers } });
    if (!second.ok) return { ok: false, auth: "none", error: second.error };
    const sse = second.attempt.res;
    const sseType = (sse.headers.get("content-type") ?? "").toLowerCase();
    if (sse.status === 200 && sseType.includes("text/event-stream")) {
      const outcome = await readSseEndpoint(sse, second.attempt.timedOut);
      second.attempt.done();
      if (outcome === "stopped") return { ok: true, transport: "sse", auth: "none" };
      return { ok: false, auth: "none", error: "It isn't an MCP server (no answer to initialize, no SSE endpoint)." };
    }
    if (sse.status === 401 || sse.status === 403) {
      const kind = await authKind(sse, parsed, ctx);
      second.attempt.done();
      return { ok: true, transport: "sse", ...kind };
    }
    second.attempt.done();
    return { ok: false, auth: "none", error: `It isn't an MCP server (HTTP ${res.status} to initialize, ${sse.status} to SSE).` };
  } catch (err) {
    return { ok: false, auth: "none", error: messageOf(err) };
  }
}
