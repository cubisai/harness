import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Provider, ThreadEvent } from "../src/shared/types";
import { createCodexDriver, type CodexPin } from "../src/main/agents/codex";
import { onPath } from "../src/main/agents/registry";
import { GATEWAY_TOKEN_VAR, createGateway } from "../src/main/gateway/route";
import { startToolServer } from "../src/main/mcp-http";
import { closeAfter } from "./helpers";

// The real `codex app-server` on a thread pinned to a chat-completions
// provider: Codex speaks Responses to the gateway, the gateway speaks
// chat-completions to a fake upstream. One shell-tool round trip, with the
// provider's reasoning handed back on the follow-up request.
const codex = process.env.UNSKILLED_CODEX_BIN ?? (onPath("codex") ? "codex" : null);
const KEY = "sk-chat-upstream-key";

type ChatMessage = { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string } }[]; reasoning_content?: string; tool_call_id?: string };

function fakeChatUpstream() {
  const requests: { auth?: string; body: { model: string; tools?: { function: { name: string } }[]; messages: ChatMessage[] } }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as (typeof requests)[number]["body"];
      requests.push({ auth: req.headers.authorization, body });
      const last = body.messages.at(-1);
      const shell = body.tools?.find((t) => t.function.name === "exec_command");
      const chunks: unknown[] =
        last?.role === "tool"
          ? [{ choices: [{ index: 0, delta: { content: String(last.content).includes("gw-marker") ? "The command printed gw-marker." : "No marker." }, finish_reason: "stop" }] }]
          : shell
            ? [
                { choices: [{ index: 0, delta: { reasoning_content: "I should run the command." } }] },
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_sh_1", type: "function", function: { name: "exec_command", arguments: "" } }] } }] },
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ cmd: "echo gw-marker" }) } }] }, finish_reason: "tool_calls" }] },
              ]
            : [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }];
      chunks.push({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 20 } } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
    });
  });
  return { server, requests };
}

describe.skipIf(!codex)("Codex through the translation gateway (real codex app-server, fake chat upstream)", () => {
  it("runs a pinned thread's shell round trip on a chat-completions provider without the key reaching Codex", async () => {
    const upstream = fakeChatUpstream();
    await new Promise<void>((r) => upstream.server.listen(0, "127.0.0.1", r));
    closeAfter(() => void upstream.server.close());

    const home = mkdtempSync(join(tmpdir(), "cubiq-gw-codex-home-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    closeAfter(() => (previousHome === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = previousHome)));

    const chat: Provider = {
      id: "th",
      label: "TokenHarbor",
      wireProtocol: "openai-chat",
      baseURL: `http://127.0.0.1:${(upstream.server.address() as AddressInfo).port}/v1`,
      secret: { kind: "safeStorage", ciphertext: "opaque" },
      models: [{ id: "flash", modelID: "deepseek-v4-flash", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 128_000, maxOutput: 8_192 }],
    };
    const server = await startToolServer(() => [], undefined, undefined, undefined, undefined, undefined, createGateway({ providers: () => [chat], secret: () => KEY, secretHeaders: () => ({}) }));
    closeAfter(() => void server.close());

    const pins: string[] = [];
    let spawnEnv: Record<string, string> = {};
    const driver = createCodexDriver({
      command: codex!,
      args: ["app-server"],
      clientVersion: "test",
      pin: async (model): Promise<CodexPin> => {
        pins.push(model);
        return { model: "deepseek-v4-flash", modelProvider: "unskilled-th", provider: { name: "TokenHarbor", base_url: `${server.llmUrl}/th/v1`, env_key: GATEWAY_TOKEN_VAR, wire_api: "responses" }, contextWindow: 128_000 };
      },
      gatewayEnv: async () => (spawnEnv = { [GATEWAY_TOKEN_VAR]: server.llmToken! }),
    });
    closeAfter(() => driver.dispose?.());

    const cwd = mkdtempSync(join(tmpdir(), "cubiq-gw-codex-cwd-"));
    const events: ThreadEvent[] = [];
    let text = "";
    await driver.runTurn({
      threadId: "t",
      cwd,
      prompt: "Run echo gw-marker and tell me what it printed.",
      sessionId: null,
      model: "unskilled-th/flash",
      permissionMode: "full",
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
    expect(text).toContain("The command printed gw-marker.");
    expect(pins).toEqual(["unskilled-th/flash"]);
    expect(JSON.stringify(spawnEnv)).not.toContain(KEY);
    // Upstream: the key added by the gateway, the wire model, the shell result and the reasoning handed back.
    expect(upstream.requests.length).toBeGreaterThanOrEqual(2);
    expect(upstream.requests.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
    expect(upstream.requests[0]!.body.model).toBe("deepseek-v4-flash");
    const followUp = upstream.requests.at(-1)!.body.messages;
    const assistant = followUp.find((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_sh_1");
    expect(assistant?.reasoning_content).toBe("I should run the command.");
    const result = followUp.find((m) => m.role === "tool");
    expect(result?.tool_call_id).toBe("call_sh_1");
    expect(String(result?.content)).toContain("gw-marker");
  }, 120_000);
});
