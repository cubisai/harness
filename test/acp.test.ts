import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialChoice, McpServerEntry, PermissionDecision, PermissionMode, Provider, Settings, ThreadEvent } from "../src/shared/types";
import { createAcpDriver, optionFor, pickPermission } from "../src/main/agents/acp/driver";
import { type InjectionSource, injectionFor } from "../src/main/inject";
import { withOpenCodeVariant } from "../src/main/inject/opencode";
import { loadAcpAgents, onPath } from "../src/main/agents/registry";
import type { TurnInput } from "../src/main/agents/types";
import { closeAfter, tempDir } from "./helpers";

const MOCK = join(__dirname, "fixtures", "mock-acp-agent.mjs");

/** Fail rather than hang if a turn never settles. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function driver() {
  const d = createAcpDriver({ id: "mock", label: "Mock", command: process.execPath, args: [MOCK] }, { clientVersion: "test" });
  closeAfter(() => d.dispose?.());
  return d;
}

function turn(prompt: string, over: Partial<TurnInput> = {}) {
  const events: ThreadEvent[] = [];
  const deltas: string[] = [];
  const sessions: string[] = [];
  const asked: string[] = [];
  const controller = new AbortController();
  const input: TurnInput = {
    threadId: "thread-1",
    // Not a per-test temp dir: Windows can't delete a directory that a
    // still-exiting agent process has as its working directory.
    cwd: tmpdir(),
    prompt,
    sessionId: null,
    model: "default",
    permissionMode: "ask" as PermissionMode,
    signal: controller.signal,
    tools: [],
    mcpServers: [],
    onEvent: (e) => events.push(e),
    onTextDelta: (t) => deltas.push(t),
    onSession: (s) => sessions.push(s),
    requestPermission: async (r) => {
      asked.push(r.summary);
      return "allow-once" as PermissionDecision;
    },
    ...over,
  };
  return { input, events, deltas, sessions, asked, controller };
}

describe("ACP driver", () => {
  it("streams a reply and reports the turn", async () => {
    const d = driver();
    const t = turn("world");
    await d.runTurn(t.input);
    expect(t.sessions).toEqual(["s-1"]);
    expect(t.deltas.join("")).toBe("Hello, world (mock-small)");
    expect(t.events.map((e) => e.kind)).toEqual(["turn-start", "thinking", "assistant-text", "turn-end"]);
    expect(t.events[0]).toMatchObject({ kind: "turn-start", agent: "mock", model: "default" });
    expect(t.events.at(-1)).toMatchObject({ kind: "turn-end", costUsd: 0.01, inputTokens: 1200, outputTokens: 34 });
    expect(t.events.at(-1)).toMatchObject({ usage: { provenance: "reported", inputTokens: 1200, cacheReadTokens: null } });
  });

  it("sends the harness guide once, ahead of a new session's first prompt", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", guide: () => "GUIDE" },
    );
    closeAfter(() => d.dispose?.());
    const first = turn("hello");
    await d.runTurn(first.input);
    expect(first.deltas.join("")).toContain("<harness-guide>\nGUIDE\n</harness-guide>");
    const second = turn("hello", { sessionId: first.sessions[0]! });
    await d.runTurn(second.input);
    expect(second.deltas.join("")).not.toContain("<harness-guide>");
  });

  it("ignores context-window usage when the prompt response has no usage", async () => {
    const d = driver();
    const t = turn("nousage");
    await d.runTurn(t.input);
    // The fixture still emits usage_update used: 1234; that must not become input.
    expect(t.events.at(-1)).toMatchObject({
      kind: "turn-end",
      inputTokens: 0,
      outputTokens: 0,
      usage: { provenance: "unavailable", cacheReadTokens: null },
    });
  });

  it("maps an ACP plan update", async () => {
    const d = driver();
    const t = turn("plan");
    await d.runTurn(t.input);
    expect(t.events.find((e) => e.kind === "plan")).toMatchObject({
      kind: "plan",
      entries: [
        { content: "Read the code", priority: "high", status: "completed" },
        { content: "Write the fix", priority: "medium", status: "pending" },
      ],
    });
  });

  it("loads models at startup without a turn", async () => {
    const d = driver();
    expect(d.models().map((m) => m.id)).toEqual(["default"]);
    await d.refreshModels!();
    expect(d.models().map((m) => m.id)).toEqual(["default", "mock-small", "mock-large"]);
  });

  it("keeps the agent and session between turns, and switches models", async () => {
    const d = driver();
    const first = turn("one");
    await d.runTurn(first.input);
    expect(d.models().map((m) => m.id)).toEqual(["default", "mock-small", "mock-large"]);
    const second = turn("two", { sessionId: first.sessions[0]!, model: "mock-large" });
    await d.runTurn(second.input);
    expect(second.sessions).toEqual(["s-1"]);
    expect(second.deltas.join("")).toBe("Hello, two (mock-large)");
  });

  it("sets the thought level before a prompt only when the effort differs", async () => {
    const d = createAcpDriver({ id: "mock", label: "Mock", command: process.execPath, args: [MOCK], env: { MOCK_ACP_EFFORT: "1" } }, { clientVersion: "test" });
    closeAfter(() => d.dispose?.());
    const first = turn("effort", { effort: "high" });
    await d.runTurn(first.input);
    expect(first.deltas.join("")).toBe("sets=1");
    // The one thought list is exposed on every model of the agent.
    expect(d.models().find((m) => m.id === "mock-small")?.efforts).toEqual(["low", "medium", "high"]);
    // Already high: no second set_config_option.
    const second = turn("effort", { sessionId: first.sessions[0]!, effort: "high" });
    await d.runTurn(second.input);
    expect(second.deltas.join("")).toBe("sets=1");
  });

  it("ignores effort when the agent has no thought-level option", async () => {
    const d = driver();
    const t = turn("hello", { effort: "high" });
    await d.runTurn(t.input);
    expect(t.deltas.join("")).toBe("Hello, hello (mock-small)");
  });

  it("exposes per-model variants as efforts, and spawns with the picked one", async () => {
    const spawns: (string | null)[] = [];
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK], env: { MOCK_ACP_OPENCODE: "1" }, effortVia: "opencode-variants" },
      {
        clientVersion: "test",
        variants: async () => ({ "mock-small": ["low", "medium", "high"], "mock-large": ["low", "high"] }),
        injection: (ctx) => {
          spawns.push(ctx?.effort ? JSON.stringify(ctx.effort) : null);
          return ctx?.effort ? withOpenCodeVariant(undefined, ctx.effort, {}) : { env: {}, byok: false };
        },
      },
    );
    closeAfter(() => d.dispose?.());

    const first = turn("config", { model: "mock-small", effort: "high" });
    await d.runTurn(first.input);
    // The process was spawned with agent.build carrying the picked variant.
    expect(JSON.parse(first.deltas.join(""))).toEqual({ build: { model: "mock-small", variant: "high" } });
    expect(spawns).toHaveLength(1);
    // Every variant model carries its own levels; the default option takes the current model's.
    expect(d.models()).toEqual([
      { id: "default", label: "Agent default", efforts: ["low", "medium", "high"] },
      { id: "mock-small", label: "Mock Small", efforts: ["low", "medium", "high"] },
      { id: "mock-large", label: "Mock Large", efforts: ["low", "high"] },
    ]);
  });

  it("respawns on a changed variant, resumes the session, and says so once", async () => {
    let spawns = 0;
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK], env: { MOCK_ACP_OPENCODE: "1" }, effortVia: "opencode-variants" },
      {
        clientVersion: "test",
        variants: async () => ({ "mock-small": ["low", "medium", "high"] }),
        injection: (ctx) => {
          spawns++;
          return ctx?.effort ? withOpenCodeVariant(undefined, ctx.effort, {}) : { env: {}, byok: false };
        },
      },
    );
    closeAfter(() => d.dispose?.());

    const high = turn("config", { model: "mock-small", effort: "high" });
    await d.runTurn(high.input);
    expect(JSON.parse(high.deltas.join(""))).toEqual({ build: { model: "mock-small", variant: "high" } });

    const low = turn("config", { sessionId: high.sessions[0]!, model: "mock-small", effort: "low" });
    await d.runTurn(low.input);
    expect(spawns).toBe(2);
    // The session is resumed, not restarted.
    expect(low.sessions).toEqual(["s-1"]);
    expect(JSON.parse(low.deltas.join(""))).toEqual({ build: { model: "mock-small", variant: "low" } });
    const notices = low.events.filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices).toEqual(["OpenCode restarted to apply reasoning effort low; the conversation continues."]);

    // A null effort goes back to no variant; the notice isn't repeated.
    const off = turn("config", { sessionId: high.sessions[0]!, model: "mock-small", effort: null });
    await d.runTurn(off.input);
    expect(spawns).toBe(3);
    expect(off.deltas.join("")).toBe("none");
    expect(off.events.filter((e) => e.kind === "notice")).toEqual([]);
  });

  it("changes nothing for an effort the model doesn't list", async () => {
    let spawns = 0;
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK], env: { MOCK_ACP_OPENCODE: "1" }, effortVia: "opencode-variants" },
      {
        clientVersion: "test",
        variants: async () => ({ "mock-small": ["low", "medium", "high"] }),
        injection: (ctx) => {
          spawns++;
          return ctx?.effort ? withOpenCodeVariant(undefined, ctx.effort, {}) : { env: {}, byok: false };
        },
      },
    );
    closeAfter(() => d.dispose?.());

    const first = turn("config", { model: "mock-small" });
    await d.runTurn(first.input);
    expect(first.deltas.join("")).toBe("none");

    const second = turn("config", { sessionId: first.sessions[0]!, model: "mock-small", effort: "max" });
    await d.runTurn(second.input);
    expect(spawns).toBe(1);
    expect(second.deltas.join("")).toBe("none");
    expect(second.events.filter((e) => e.kind === "notice")).toEqual([]);
  });

  it("resumes a stored session in a new agent process", async () => {
    const d = driver();
    const t = turn("again", { sessionId: "resumable-session" });
    await d.runTurn(t.input);
    expect(t.sessions).toEqual(["resumable-session"]);
    expect(t.events.some((e) => e.kind === "notice")).toBe(false);
  });

  it("starts fresh, and says so, when the session can't be resumed", async () => {
    const d = driver();
    const t = turn("hi", { sessionId: "gone" });
    await d.runTurn(t.input);
    expect(t.sessions).toEqual(["s-1"]);
    expect(t.events[0]).toMatchObject({ kind: "notice" });
  });

  it("waits for arguments that arrive on a later update before announcing a tool call (OpenCode)", async () => {
    const d = driver();
    const t = turn("late-input", { permissionMode: "full" as PermissionMode });
    await d.runTurn(t.input);
    const uses = t.events.filter((e) => e.kind === "tool-use");
    expect(uses).toEqual([
      expect.objectContaining({ toolUseId: "l1", name: "Run", summary: "npm test", payload: { command: "npm test" } }),
      expect.objectContaining({ toolUseId: "l2", name: "browser_open", summary: "https://example.com" }),
    ]);
    // Each row is announced before its result.
    const order = t.events.filter((e) => e.kind === "tool-use" || e.kind === "tool-result").map((e) => `${e.kind}:${(e as { toolUseId: string }).toolUseId}`);
    expect(order).toEqual(["tool-use:l1", "tool-result:l1", "tool-use:l2", "tool-result:l2"]);
  });

  it("routes tool permission to the user in Ask mode", async () => {
    const d = driver();
    const t = turn("tool");
    await d.runTurn(t.input);
    expect(t.asked).toEqual(["npm test"]);
    const kinds = t.events.map((e) => e.kind);
    expect(kinds).toEqual(["turn-start", "thinking", "assistant-text", "tool-use", "tool-result", "assistant-text", "turn-end"]);
    expect(t.events[4]).toMatchObject({ kind: "tool-result", isError: false, summary: "3 passed (yes)" });
  });

  it("denies when the user denies, and runs without asking in Full mode", async () => {
    const d = driver();
    const denied = turn("tool", { requestPermission: async () => "deny" });
    await d.runTurn(denied.input);
    expect(denied.events.find((e) => e.kind === "tool-result")).toMatchObject({ isError: true });

    const full = turn("tool", { permissionMode: "full", threadId: "thread-2" });
    await d.runTurn(full.input);
    expect(full.asked).toEqual([]);
    expect(full.events.find((e) => e.kind === "tool-result")).toMatchObject({ isError: false });
  });

  it("vetoes a guarded command with the guardrail notice, without asking, in Full mode", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", guardScript: join(__dirname, "fixtures", "fake-guard.py") },
    );
    closeAfter(() => d.dispose?.());
    const t = turn("exec:git push --force", { permissionMode: "full" });
    await d.runTurn(t.input);
    expect(t.deltas.join("")).toBe("rejected:reject_once");
    expect(t.asked).toEqual([]);
    const guardNotices = t.events.filter((e) => e.kind === "notice" && /Blocked by git guardrails/.test((e as { text: string }).text));
    expect(guardNotices).toHaveLength(1);
  });

  it("lets an allowed command run in Full mode with a guard script", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", guardScript: join(__dirname, "fixtures", "fake-guard.py") },
    );
    closeAfter(() => d.dispose?.());
    const t = turn("exec:ls", { permissionMode: "full" });
    await d.runTurn(t.input);
    expect(t.deltas.join("")).toBe("ran");
    expect(t.events.filter((e) => e.kind === "notice" && /Blocked by git guardrails/.test((e as { text: string }).text))).toEqual([]);
  });

  it("attaches the harness's tool server from the first turn, with no reload later", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", toolServer: async () => ({ url: "http://127.0.0.1:9/mcp", token: "t" }) },
    );
    closeAfter(() => d.dispose?.());
    const tool = { name: "browser_snapshot", description: "", input: {}, autoAllow: true, run: async () => ({ text: "" }) };
    const first = turn("mcp", { tools: [tool] });
    await d.runTurn(first.input);
    expect(first.deltas.join("")).toBe('[["http","unskilled","http://127.0.0.1:9/mcp"]]');
    const second = turn("mcp", { sessionId: first.sessions[0]!, tools: [tool] });
    await d.runTurn(second.input);
    expect(second.deltas.join("")).toBe('[["http","unskilled","http://127.0.0.1:9/mcp"]]');
    expect(second.events.some((e) => e.kind === "notice" && (e as { text: string }).text.includes("reopened"))).toBe(false);
  });

  it("passes the user's MCP servers, and reopens the session when they change", async () => {
    const d = driver();
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: ["--stdio"] } };
    const remote = { name: "remote", enabled: true, spec: { type: "http" as const, url: "https://mcp.example.com/mcp" } };
    const lint = { name: "lint", enabled: true, spec: { type: "stdio" as const, command: "lint-mcp", args: [] } };
    let firstRebuilds = 0;
    const first = turn("mcp", { mcpServers: [docs], onSessionRebuilt: () => { firstRebuilds++; } });
    await d.runTurn(first.input);
    // stdio servers have no type field in ACP.
    expect(first.deltas.join("")).toBe('[[null,"docs",null]]');
    expect(firstRebuilds).toBe(0);
    // Two edits between turns still cost one reopen: the list is compared only at the next turn.
    const edited: McpServerEntry[] = [docs];
    edited.push(remote);
    edited.push(lint);
    let secondRebuilds = 0;
    const second = turn("mcp", { sessionId: first.sessions[0]!, mcpServers: edited, onSessionRebuilt: () => { secondRebuilds++; } });
    await d.runTurn(second.input);
    expect(secondRebuilds).toBe(1);
    expect(second.deltas.join("")).toBe('[[null,"docs",null],["http","remote","https://mcp.example.com/mcp"],[null,"lint",null]]');
    const notices = second.events.filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices.filter((t) => t.includes("reopened"))).toHaveLength(1);
  });

  it("names the HTTP servers an agent without MCP-over-HTTP can't take, once", async () => {
    const d = createAcpDriver({ id: "mock", label: "Mock", command: process.execPath, args: [MOCK], env: { MOCK_ACP_NO_HTTP: "1" } }, { clientVersion: "test" });
    closeAfter(() => d.dispose?.());
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: [] } };
    const remote = { name: "remote", enabled: true, spec: { type: "http" as const, url: "https://mcp.example.com/mcp" } };
    const first = turn("mcp", { mcpServers: [docs, remote] });
    await d.runTurn(first.input);
    // The stdio server still arrives; the HTTP one is dropped, and said so.
    expect(first.deltas.join("")).toBe('[[null,"docs",null]]');
    const notices = first.events.filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices.filter((t) => t.includes("remote") && /MCP over HTTP/.test(t))).toHaveLength(1);
    const second = turn("mcp", { sessionId: first.sessions[0]!, mcpServers: [docs, remote] });
    await d.runTurn(second.input);
    expect(second.events.filter((e) => e.kind === "notice" && (e as { text: string }).text.includes("remote"))).toEqual([]);
  });

  it("says the session was reopened when the MCP servers change", async () => {
    const d = driver();
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: [] } };
    const remote = { name: "remote", enabled: true, spec: { type: "http" as const, url: "https://mcp.example.com/mcp" } };
    const first = turn("mcp", { mcpServers: [docs] });
    await d.runTurn(first.input);
    expect(first.events.filter((e) => e.kind === "notice")).toEqual([]);
    const second = turn("mcp", { sessionId: first.sessions[0]!, mcpServers: [docs, remote] });
    await d.runTurn(second.input);
    const notices = second.events.filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/remote/);
    expect(notices[0]).toMatch(/reopened/);
  });

  it("cancels a running turn", async () => {
    const d = driver();
    const t = turn("slow");
    const running = d.runTurn(t.input);
    await new Promise((r) => setTimeout(r, 150));
    t.controller.abort();
    await running;
    expect(t.events.some((e) => e.kind === "notice" && e.text === "Stopped.")).toBe(true);
  });

  it("streams thought chunks, keyed before the terminal thinking event", async () => {
    const d = driver();
    const log: { kind: string; [key: string]: unknown }[] = [];
    const reasoning: { itemId: string; text: string; opaque: boolean }[] = [];
    const t = turn("reason", {
      onEvent: (e) => log.push(e as { kind: string }),
      onReasoningDelta: (r) => {
        reasoning.push(r);
        log.push({ kind: "cb-reasoning", ...r });
      },
    });
    await d.runTurn(t.input);

    expect(reasoning.map((r) => r.text)).toEqual(["wait", "let me think", "aha"]);
    expect(reasoning.map((r) => r.opaque)).toEqual([false, false, false]);
    const thinkingIndex = log.findIndex((e) => e.kind === "thinking");
    const lastDeltaIndex = log.reduce((last, e, i) => (e.kind === "cb-reasoning" ? i : last), -1);
    expect(thinkingIndex).toBeGreaterThan(lastDeltaIndex);
    expect(log[thinkingIndex]).toMatchObject({ kind: "thinking", itemId: reasoning[0]!.itemId });
  });

  it("surfaces intermediate tool output before the terminal result", async () => {
    const d = driver();
    const log: { kind: string; [key: string]: unknown }[] = [];
    const toolOutputs: { toolUseId: string; text: string }[] = [];
    const t = turn("tool", {
      onEvent: (e) => log.push(e as { kind: string }),
      onToolOutputDelta: (o) => {
        toolOutputs.push(o);
        log.push({ kind: "cb-tool-output", ...o });
      },
    });
    await d.runTurn(t.input);

    expect(toolOutputs).toContainEqual({ toolUseId: "t1", text: "running" });
    const outputIndex = log.findIndex((e) => e.kind === "cb-tool-output" && e.toolUseId === "t1");
    const resultIndex = log.findIndex((e) => e.kind === "tool-result" && e.toolUseId === "t1");
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(outputIndex);
  });

  it("flushes streamed text before the Stopped notice when cancelled", async () => {
    const d = driver();
    const log: { kind: string; [key: string]: unknown }[] = [];
    const deltas: string[] = [];
    const t = turn("slow", {
      onEvent: (e) => log.push(e as { kind: string }),
      onTextDelta: (text) => {
        deltas.push(text);
        log.push({ kind: "cb-text", text });
      },
    });
    const running = d.runTurn(t.input);
    // Abort only once something has streamed: a fixed sleep races a slow agent start under load.
    for (let i = 0; i < 200 && deltas.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    t.controller.abort();
    await running;

    const assistant = log.find((e) => e.kind === "assistant-text");
    expect(assistant).toBeDefined();
    const text = String(assistant?.text ?? "");
    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) expect(text).toContain(delta);
    const assistantIndex = log.findIndex((e) => e.kind === "assistant-text");
    const stoppedIndex = log.findIndex((e) => e.kind === "notice" && e.text === "Stopped.");
    expect(stoppedIndex).toBeGreaterThan(assistantIndex);
  });

  it("stops when aborted before startup finishes", async () => {
    const d = driver();
    const t = turn("world");
    t.controller.abort();
    await withTimeout(d.runTurn(t.input), 5000);
    expect(t.events.some((e) => e.kind === "notice" && e.text === "Stopped.")).toBe(true);
    expect(t.events.some((e) => e.kind === "turn-start")).toBe(false);
  });

  it("reports an agent that can't start", async () => {
    const d = createAcpDriver({ id: "x", label: "Nope", command: "definitely-not-a-real-agent-binary", args: [] }, { clientVersion: "t" });
    const t = turn("hi");
    await d.runTurn(t.input);
    expect(t.events[0]).toMatchObject({ kind: "error" });
    expect((t.events[0] as { message: string }).message).toMatch(/Nope failed to start/);
  });
});

describe("permission mapping", () => {
  it("asks, allows edits, or allows everything by mode", () => {
    expect(pickPermission("ask", "edit")).toBe("ask");
    expect(pickPermission("auto-edit", "edit")).toBe("allow");
    expect(pickPermission("auto-edit", "execute")).toBe("ask");
    expect(pickPermission("full", "execute")).toBe("allow");
  });

  it("maps decisions onto the agent's options", () => {
    const opts = [
      { optionId: "a", name: "", kind: "allow_once" as const },
      { optionId: "r", name: "", kind: "reject_once" as const },
    ];
    expect(optionFor(opts, "allow-once")).toBe("a");
    expect(optionFor(opts, "allow-always")).toBe("a"); // falls back
    expect(optionFor(opts, "deny")).toBe("r");
  });
});

describe("ACP driver credential injection", () => {
  const KEY = "test-acp-key";

  function source(choice: CredentialChoice, secretEnvNames: string[] = []): InjectionSource {
    const provider: Provider = {
      id: "test-gateway",
      label: "Test Gateway",
      wireProtocol: "openai-chat",
      baseURL: "https://gateway.example.test",
      secret: { kind: "safeStorage", ciphertext: "x" },
      models: [],
    };
    return {
      credential: () => choice,
      providers: () => [provider],
      providerSecret: () => KEY,
      secretEnvNames: () => secretEnvNames,
      get: (): Settings => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {} }),
    };
  }

  function injectedDriver(src: InjectionSource) {
    const d = createAcpDriver(
      { id: "custom-mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", injection: () => injectionFor(src, "custom-mock", process.env, { agentLabel: "Mock" }) },
    );
    closeAfter(() => d.dispose?.());
    return d;
  }

  it("spawns a BYOK ACP agent with the key, and shows its guess notice once", async () => {
    const d = injectedDriver(source({ kind: "byok", providerId: "test-gateway" }));
    const first = turn("env:OPENAI_API_KEY");
    await d.runTurn(first.input);
    expect(first.deltas.join("")).toContain("OPENAI_API_KEY=present");
    const second = turn("env:OPENAI_API_KEY");
    await d.runTurn(second.input);
    expect(second.deltas.join("")).toContain("OPENAI_API_KEY=present");
    const notices = [...first.events, ...second.events].filter(
      (e): e is { kind: "notice"; text: string } => e.kind === "notice" && /may not reach it/.test(e.text),
    );
    expect(notices).toHaveLength(1);
  });

  it("keeps a planted key out of a subscription ACP agent", async () => {
    const d = injectedDriver(source({ kind: "subscription" }, ["OPENAI_API_KEY"]));
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "planted";
    try {
      const t = turn("env:OPENAI_API_KEY");
      await d.runTurn(t.input);
      expect(t.deltas.join("")).toContain("OPENAI_API_KEY=absent");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe("agent registry", () => {
  it("offers installed presets plus agents.json entries", () => {
    const dir = tempDir();
    const file = join(dir, "agents.json");
    writeFileSync(file, JSON.stringify({ agents: [{ id: "qwen", label: "Qwen Code", command: "qwen", args: ["--acp"] }, { id: "bad" }] }));
    const { agents, problems } = loadAcpAgents(file, (cmd) => cmd === "dsh" || cmd === "opencode");
    expect(agents.map((a) => a.id)).toEqual(["deepseek", "opencode", "qwen"]);
    expect(agents[0]).toMatchObject({ skillsDirEnv: "DSH_BUNDLED_SKILL_DIR" });
    expect(agents[1]).toMatchObject({ command: "opencode", args: ["acp"] });
    expect(problems).toHaveLength(1);
  });

  it("no longer starts Antigravity over ACP: its own CLI driver (agents/agy.ts) wins, even over an agents.json entry", () => {
    const dir = tempDir();
    const file = join(dir, "agents.json");
    expect(loadAcpAgents(file, (cmd) => cmd === "agy-acp" || cmd === "agy", { optedIn: true }).agents).toEqual([]);
    writeFileSync(file, JSON.stringify({ agents: [{ id: "antigravity", label: "Antigravity (old)", command: "agy-acp", args: ["--experimental"] }] }));
    expect(loadAcpAgents(file, (cmd) => cmd === "agy-acp", { optedIn: true }).agents).toEqual([]);
  });

  it("finds commands on PATH", () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const name = process.platform === "win32" ? "fake-agent.cmd" : "fake-agent";
    writeFileSync(join(bin, name), "", { mode: 0o755 });
    expect(onPath("fake-agent", { PATH: bin, PATHEXT: ".CMD" })).toBe(true);
    expect(onPath("missing-agent", { PATH: bin, PATHEXT: ".CMD" })).toBe(false);
  });
});
