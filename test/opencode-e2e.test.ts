import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Provider, ThreadEvent } from "../src/shared/types";
import { DEFAULT_MODEL, createAcpDriver } from "../src/main/agents/acp/driver";
import { ACP_PRESETS, onPath } from "../src/main/agents/registry";
import { type InjectionSource, injectionFor } from "../src/main/inject";
import { opencodeVersion } from "../src/main/inject/opencode";
import { closeAfter, tempDir } from "./helpers";

// The real `opencode acp` against a fake OpenAI-compatible chat endpoint, so
// the whole BYOK path runs without an account: the config travels in
// OPENCODE_CONFIG_CONTENT, the key in its own env var, and no file is written.
const KEY = "test-opencode-key";

/**
 * A fake chat-completions endpoint that answers one SSE PONG and records the
 * Authorization header and request model for every POST it sees.
 */
function startFakeChat(): Promise<{ server: Server; url: string; authorizations: (string | undefined)[]; models: string[] }> {
  const authorizations: (string | undefined)[] = [];
  const models: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      let parsed: { model?: string };
      try {
        parsed = JSON.parse(body) as { model?: string };
      } catch {
        return void res.writeHead(400).end();
      }
      authorizations.push(req.headers.authorization);
      if (typeof parsed.model === "string") models.push(parsed.model);
      const model = parsed.model ?? "unknown";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "PONG" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, authorizations, models }));
  });
}

function provider(baseURL: string): Provider {
  return {
    id: "gw",
    label: "GW",
    wireProtocol: "openai-chat",
    baseURL,
    secret: { kind: "safeStorage", ciphertext: "x" },
    headers: { "X-A": "1" },
    models: [
      { id: "picked", modelID: "vendor/wire-1", name: "Picked", capabilities: { tools: true, vision: true, reasoning: false }, contextWindow: 128_000, maxOutput: 8_192 },
    ],
  };
}

/** A fake settings surface for one BYOK provider. */
function source(p: Provider): InjectionSource {
  return {
    credential: () => ({ kind: "byok", providerId: p.id }),
    providers: () => [p],
    providerSecret: () => KEY,
    secretEnvNames: () => [],
    get: () => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: false, editor: null, providerInjection: {} }),
  };
}

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe.skipIf(!onPath("opencode"))("OpenCode BYOK end to end (real acp, fake model)", () => {
  it("runs a turn through OPENCODE_CONFIG_CONTENT without writing a config file", async () => {
    // Never touch the user's real ~/.config/opencode and friends.
    const xdgConfig = tempDir();
    const previous = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE,
      OPENCODE_DISABLE_MODELS_FETCH: process.env.OPENCODE_DISABLE_MODELS_FETCH,
    };
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_DATA_HOME = tempDir();
    process.env.XDG_CACHE_HOME = tempDir();
    process.env.XDG_STATE_HOME = tempDir();
    process.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    closeAfter(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const fake = await startFakeChat();
    closeAfter(() => void fake.server.close());

    const preset = ACP_PRESETS.find((p) => p.id === "opencode")!;
    const injected = source(provider(fake.url));
    const driver = createAcpDriver(preset, {
      clientVersion: "test",
      injection: () => injectionFor(injected, "opencode", process.env, { injector: "opencode", opencodeVersion: () => opencodeVersion(preset.command) }),
    });
    closeAfter(() => driver.dispose?.());

    const events: ThreadEvent[] = [];
    const deltas: string[] = [];
    await driver.runTurn({
      threadId: "t",
      cwd: tempDir(),
      prompt: "Reply with exactly PONG.",
      sessionId: null,
      model: DEFAULT_MODEL,
      permissionMode: "ask",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: (t) => deltas.push(t),
      onSession: () => {},
      requestPermission: async () => "deny",
    });

    expect(events.find((e) => e.kind === "error")).toBeUndefined();
    const text = [deltas.join(""), ...events.filter((e) => e.kind === "assistant-text").map((e) => (e as { text: string }).text)].join("");
    expect(text).toContain("PONG");
    expect(fake.authorizations.length).toBeGreaterThan(0);
    expect(fake.authorizations.every((auth) => auth === `Bearer ${KEY}`)).toBe(true);
    expect(fake.models).toContain("vendor/wire-1");

    driver.dispose?.();
    expect(walk(xdgConfig).filter((f) => /opencode\.jsonc?$/.test(f))).toEqual([]);
  }, 120_000);
});
