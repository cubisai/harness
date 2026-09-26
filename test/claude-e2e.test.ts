import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Provider, ThreadEvent } from "../src/shared/types";
import { createClaudeDriver } from "../src/main/agents/claude";
import type { LimitsPatch } from "../src/main/agents/limits";
import { injectionFor, type InjectionSource } from "../src/main/inject";
import { ensurePlugin } from "../src/main/skills/plugin";
import { catalog, closeAfter } from "./helpers";

// The real Claude Code binary (the Agent SDK's platform package) against a
// fake Messages API, so a whole turn runs without an account. The fake sends
// the unified rate-limit headers a claude.ai plan gets. With an API key, as
// here, Claude Code reports no plan limits (they don't apply), so the meter
// stays hidden; how a claude.ai login's rate_limit_event reads is covered
// in limits.test.ts, from the event this fake produced under such a login.
function fakeAnthropic() {
  const requests: string[] = [];
  const toolNames: string[][] = [];
  const headers: { authorization?: string; "x-api-key"?: string }[] = [];
  const bodies: { system: unknown; messages: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url?.split("?")[0]}`);
      if (!req.url?.startsWith("/v1/messages")) return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
      headers.push({ authorization: req.headers.authorization, "x-api-key": req.headers["x-api-key"] as string | undefined });
      const { model, stream, tools, system, messages } = JSON.parse(body) as { model: string; stream?: boolean; tools?: { name: string }[]; system?: unknown; messages?: unknown };
      if (stream) toolNames.push((tools ?? []).map((t) => t.name));
      if (stream) bodies.push({ system, messages });
      const usage = { input_tokens: 10, output_tokens: 3 };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ id: "m0", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage }));
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "anthropic-ratelimit-unified-status": "allowed_warning",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-reset": "1790000000",
        "anthropic-ratelimit-unified-5h-utilization": "0.84",
        "anthropic-ratelimit-unified-5h-reset": "1790000000",
        "anthropic-ratelimit-unified-5h-surpassed-threshold": "0.8",
        "anthropic-ratelimit-unified-7d-utilization": "0.41",
        "anthropic-ratelimit-unified-7d-reset": "1790500000",
      });
      const ev = (e: object) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`;
      res.end(
        ev({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }) +
          ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
          ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello." } }) +
          ev({ type: "content_block_stop", index: 0 }) +
          ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
          ev({ type: "message_stop" }),
      );
    });
  });
  return { server, requests, toolNames, headers, bodies };
}

function setEnv(vars: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  closeAfter(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("Claude end to end (real Claude Code, fake API)", () => {
  it("runs a turn, and an API-key session reports no plan limits", async () => {
    const { server, requests, toolNames } = fakeAnthropic();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closeAfter(() => void server.close());
    // The driver's agent inherits process.env: drop any Claude Code session
    // this runs inside (it would make the fake look like a claude.ai login),
    // and use a scratch config dir to keep the user's settings out.
    const inherited = Object.keys(process.env).filter((k) => k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC_"));
    setEnv({
      ...Object.fromEntries(inherited.map((k) => [k, undefined])),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ANTHROPIC_API_KEY: "sk-ant-test",
      CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "unskilled-claude-config-")),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });

    const limits: LimitsPatch[] = [];
    const pluginRoot = mkdtempSync(join(tmpdir(), "unskilled-plugin-"));
    const driver = createClaudeDriver({
      pluginDir: () => ensurePlugin(catalog(), join(pluginRoot, "skilled-plugin")),
      guardScript: join(__dirname, "missing-guard.py"), // Bash never runs in this turn
      onLimits: (p) => limits.push(p),
    });
    const events: ThreadEvent[] = [];
    let text = "";
    await driver.runTurn({
      threadId: "t",
      cwd: mkdtempSync(join(tmpdir(), "unskilled-claude-cwd-")),
      prompt: "hi",
      sessionId: null,
      model: "claude-sonnet-5",
      permissionMode: "ask",
      signal: new AbortController().signal,
      tools: [],
      // A user MCP server (mcp.json): its tool has to reach the model.
      mcpServers: [{ name: "docs", enabled: true, spec: { type: "stdio", command: process.execPath, args: [join(__dirname, "fixtures", "mock-mcp-stdio.mjs")] } }],
      onEvent: (e) => events.push(e),
      onTextDelta: (d) => (text += d),
      onSession: () => {},
      requestPermission: async () => "deny",
    });

    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(text).toBe("Hello.");
    expect(events.find((e) => e.kind === "assistant-text")).toMatchObject({ text: "Hello." });
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", outputTokens: 3 });
    expect(limits).toEqual([]);
    expect(toolNames.flat()).toContain("mcp__docs__whoami");
    // The turn's model calls, and nothing that asks for usage or limits.
    expect(requests).toContain("POST /v1/messages");
    expect(requests.filter((r) => /usage|rate.?limit|quota/i.test(r))).toEqual([]);
  }, 90_000);

  // T6.8: a handoff reaches Claude as one message; the system prompt stays the
  // preset (no custom string, no checkpoint), so tools and caching are untouched.
  it("sends a handoff checkpoint in the messages, once, and never in the system prompt", async () => {
    const { server, bodies } = fakeAnthropic();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closeAfter(() => void server.close());
    const inherited = Object.keys(process.env).filter((k) => k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC_"));
    setEnv({
      ...Object.fromEntries(inherited.map((k) => [k, undefined])),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ANTHROPIC_API_KEY: "sk-ant-test",
      CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "unskilled-claude-config-")),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const pluginRoot = mkdtempSync(join(tmpdir(), "unskilled-plugin-"));
    const driver = createClaudeDriver({
      pluginDir: () => ensurePlugin(catalog(), join(pluginRoot, "skilled-plugin")),
      guardScript: join(__dirname, "missing-guard.py"),
    });
    const checkpoint = ["# Handoff from codex (gpt-x)", "", "## Goal", "CHECKPOINT-MARKER-7 fix the login bug"].join("\n");
    await driver.runTurn({
      threadId: "t",
      cwd: mkdtempSync(join(tmpdir(), "unskilled-claude-cwd-")),
      prompt: checkpoint,
      sessionId: null,
      model: "claude-sonnet-5",
      permissionMode: "ask",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: () => {},
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async () => "deny",
    });
    expect(bodies.length).toBeGreaterThan(0);
    const turn = bodies.find((b) => JSON.stringify(b.messages).includes("CHECKPOINT-MARKER-7"))!;
    expect(turn).toBeDefined();
    expect(JSON.stringify(turn.system ?? "")).not.toContain("CHECKPOINT-MARKER-7");
    expect(JSON.stringify(turn.messages).split("CHECKPOINT-MARKER-7").length - 1).toBe(1);
  }, 90_000);

  // A whole turn driven by a plan instead of process.env: nothing in our own
  // environment points at the fake, so only the injected base URL and bearer
  // token can get the request there.
  it("runs a turn through an injected BYOK gateway provider", async () => {
    const { server, headers } = fakeAnthropic();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closeAfter(() => void server.close());
    const key = "test-gateway-token";
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // No ANTHROPIC_* anywhere: the plan is the only thing that can reach the fake.
    const inherited = Object.keys(process.env).filter((k) => k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC_"));
    setEnv({
      ...Object.fromEntries(inherited.map((k) => [k, undefined])),
      CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "unskilled-claude-config-")),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });

    const gateway: Provider = {
      id: "gw",
      label: "Gateway",
      wireProtocol: "anthropic-messages",
      baseURL,
      secret: { kind: "safeStorage", ciphertext: "opaque" },
      models: [{ id: "sonnet", modelID: "claude-sonnet-5", capabilities: { tools: true, vision: true, reasoning: false }, contextWindow: 200_000, maxOutput: 8_192 }],
    };
    const planSource: InjectionSource = {
      credential: () => ({ kind: "byok", providerId: "gw" }),
      providers: () => [gateway],
      providerSecret: () => key,
      secretEnvNames: () => [],
      get: () => ({
        theme: "system",
        defaultAgent: null,
        defaultPermissionMode: "ask",
        autoUpdate: true,
        editor: null,
        providerInjection: {},
      }),
    };

    const pluginRoot = mkdtempSync(join(tmpdir(), "unskilled-plugin-"));
    const driver = createClaudeDriver({
      pluginDir: () => ensurePlugin(catalog(), join(pluginRoot, "skilled-plugin")),
      guardScript: join(__dirname, "missing-guard.py"), // Bash never runs in this turn
      injection: () => injectionFor(planSource, "claude", process.env, { injector: "claude" }),
    });
    const events: ThreadEvent[] = [];
    let text = "";
    await driver.runTurn({
      threadId: "t",
      cwd: mkdtempSync(join(tmpdir(), "unskilled-claude-cwd-")),
      prompt: "hi",
      sessionId: null,
      model: "sonnet",
      permissionMode: "ask",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: (d) => (text += d),
      onSession: () => {},
      requestPermission: async () => "deny",
    });

    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(text).toBe("Hello.");
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h.authorization === `Bearer ${key}`)).toBe(true);
    expect(headers.every((h) => h["x-api-key"] === undefined)).toBe(true);
  }, 90_000);
});
