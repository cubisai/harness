import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Provider, ThreadEvent } from "../src/shared/types";
import { createClaudeDriver } from "../src/main/agents/claude";
import { injectionFor, type InjectionPlan, type InjectionSource } from "../src/main/inject";
import { createGateway } from "../src/main/gateway/route";
import { startToolServer } from "../src/main/mcp-http";
import { closeAfter } from "./helpers";

// The real Claude Code binary on a thread pinned to a chat-completions
// provider: Claude talks Anthropic Messages to the gateway, the gateway talks
// chat-completions to a fake upstream. One tool round trip, with the
// provider's reasoning handed back on the follow-up request.

const KEY = "sk-chat-upstream-key";

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[]; reasoning_content?: string; tool_call_id?: string };

function fakeChatUpstream(file: string) {
  const requests: { auth?: string; body: { model: string; stream?: boolean; tools?: unknown[]; messages: ChatMessage[] } }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as (typeof requests)[number]["body"];
      requests.push({ auth: req.headers.authorization, body });
      // Claude Code may follow a tool result with a system note, so look for the result anywhere.
      const result = body.messages.find((m) => m.role === "tool");
      const chunks: unknown[] =
        result
          ? [{ choices: [{ index: 0, delta: { content: `The file says ${String(result.content).includes("hello-gateway") ? "hello-gateway" : "something else"}.` }, finish_reason: "stop" }] }]
          : body.tools?.length
            ? [
                { choices: [{ index: 0, delta: { reasoning_content: "I should read the file." } }] },
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "Read", arguments: "" } }] } }] },
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: file }) } }] }, finish_reason: "tool_calls" }] },
              ]
            : [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }];
      chunks.push({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } });
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
    });
  });
  return { server, requests };
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

describe("Claude through the translation gateway (real Claude Code, fake chat upstream)", () => {
  it("runs a pinned thread's tool round trip on a chat-completions provider without the key reaching Claude", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cubiq-gw-cwd-"));
    const file = join(cwd, "note.txt");
    writeFileSync(file, "hello-gateway\n");
    const upstream = fakeChatUpstream(file);
    await new Promise<void>((r) => upstream.server.listen(0, "127.0.0.1", r));
    closeAfter(() => void upstream.server.close());

    const inherited = Object.keys(process.env).filter((k) => k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC_"));
    setEnv({
      ...Object.fromEntries(inherited.map((k) => [k, undefined])),
      CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "cubiq-claude-config-")),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });

    const chat: Provider = {
      id: "th",
      label: "TokenHarbor",
      wireProtocol: "openai-chat",
      baseURL: `http://127.0.0.1:${(upstream.server.address() as AddressInfo).port}/v1`,
      secret: { kind: "safeStorage", ciphertext: "opaque" },
      models: [{ id: "flash", modelID: "deepseek-v4-flash", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 128_000, maxOutput: 8_192 }],
    };
    // Claude's own credential stays the subscription: only the thread's model pins the provider.
    const source: InjectionSource = {
      credential: () => ({ kind: "subscription" }),
      providers: () => [chat],
      providerSecret: () => KEY,
      secretEnvNames: () => [],
      get: () => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {} }),
    };
    const server = await startToolServer(() => [], undefined, undefined, undefined, undefined, undefined, createGateway({ providers: () => [chat], secret: () => KEY, secretHeaders: () => ({}) }));
    closeAfter(() => void server.close());

    const plans: InjectionPlan[] = [];
    const driver = createClaudeDriver({
      guardScript: join(__dirname, "missing-guard.py"), // Bash never runs in this turn
      injection: (ctx) => {
        const plan = injectionFor(source, "claude", process.env, { injector: "claude", ...(ctx && { providerId: ctx.providerId, model: ctx.model }), gateway: { url: server.llmUrl!, token: server.llmToken! } });
        plans.push(plan);
        return plan;
      },
    });
    const events: ThreadEvent[] = [];
    let text = "";
    await driver.runTurn({
      threadId: "t",
      cwd,
      prompt: "What does note.txt say?",
      sessionId: null,
      model: "unskilled-th/flash",
      permissionMode: "ask",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: (d) => (text += d),
      onSession: () => {},
      requestPermission: async () => "allow-once",
      requestPlanDecision: async () => ({ keep: "" }),
    });

    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(text).toContain("The file says hello-gateway.");
    // The plan points Claude at the gateway with the gateway's token; the provider key is nowhere in it.
    expect(plans[0]!.model).toBe("deepseek-v4-flash");
    expect(plans[0]!.env.ANTHROPIC_BASE_URL).toBe(`${server.llmUrl}/th`);
    expect(plans[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe(server.llmToken);
    expect(JSON.stringify(plans[0]!.env)).not.toContain(KEY);
    // Upstream: the key added by the gateway, the wire model, the tool result and the reasoning handed back.
    const turn = upstream.requests.filter((r) => r.body.tools?.length);
    expect(turn.length).toBeGreaterThanOrEqual(2);
    expect(upstream.requests.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
    expect(turn[0]!.body.model).toBe("deepseek-v4-flash");
    // Claude Code's environment (sent as a system message inside messages) reaches the model's system prompt.
    expect(turn[0]!.body.messages[0]).toMatchObject({ role: "system" });
    expect(String(turn[0]!.body.messages[0]!.content)).toContain("cubiq-gw-cwd-");
    const followUp = turn.at(-1)!.body.messages;
    const assistant = followUp.find((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(assistant?.reasoning_content).toBe("I should read the file.");
    const result = followUp.find((m) => m.role === "tool");
    expect(result?.tool_call_id).toBe("call_read_1");
    expect(String(result?.content)).toContain("hello-gateway");
  }, 120_000);
});
