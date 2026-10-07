import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialChoice, McpServerEntry, PermissionDecision, PermissionMode, Provider, Settings, ThreadEvent } from "../src/shared/types";
import { authUrlFrom, createAcpDriver, optionFor, pickPermission } from "../src/main/agents/acp/driver";
import { type InjectionSource, injectionFor } from "../src/main/inject";
import { withOpenCodeVariant } from "../src/main/inject/opencode";
import { antigravityAcpCommand, loadAcpAgents, onPath } from "../src/main/agents/registry";
import type { TurnInput } from "../src/main/agents/types";
import { closeAfter, tempDir } from "./helpers";

const MOCK = join(__dirname, "fixtures", "mock-acp-agent.mjs");

// A minimal ACP agent run inline (`-e`), for the tool-payload scenarios the
// shared fixture doesn't cover. The prompt picks the scenario.
const TASK_OUTPUT = `<task id="x" state="completed"><task_result>Found it\nmore</task_result></task>`;
const INLINE_ACP = `
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, authMethods: [] } });
  if (method === "session/new" || method === "session/resume") return send({ id, result: { sessionId: "s-1", configOptions: [] } });
  if (method === "session/close") return send({ id, result: {} });
  if (method === "session/set_config_option") return send({ id, result: { configOptions: [] } });
  if (method === "session/cancel") return;
  if (method === "session/prompt") {
    const sid = params.sessionId;
    const text = params.prompt.map((b) => b.text ?? "").join("") || "write";
    if (text === "write") {
      update(sid, { sessionUpdate: "tool_call", toolCallId: "w1", title: "write", kind: "edit", rawInput: { filePath: "a.txt", content: "hi\\n" }, status: "pending" });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Wrote a.txt" } }] });
    } else if (text === "antigravity-exec") {
      update(sid, { sessionUpdate: "tool_call", toolCallId: "5c51", title: "echo HI", kind: "execute", rawInput: { commandLine: "echo HI" }, status: "pending" });
      // Antigravity sends no content for a command: output and exit code ride on rawOutput.
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "5c51", status: "completed", rawOutput: { commandLine: "echo HI", workingDir: "/x", exitCode: 0, exit_code: 0, combinedOutput: "HI\\n", formatted_output: "HI\\n" } });
    } else if (text === "generic") {
      update(sid, { sessionUpdate: "tool_call", toolCallId: "g1", title: "websearch", kind: "other", rawInput: { query: "cats" }, status: "pending" });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "g1", status: "completed", rawOutput: { output: "results for cats" } });
    } else if (text === "task") {
      update(sid, { sessionUpdate: "tool_call", toolCallId: "a1", title: "task", kind: "think", rawInput: { description: "research", prompt: "find it", subagent_type: "explore" }, status: "pending" });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "a1", status: "completed", rawOutput: { output: ${JSON.stringify(TASK_OUTPUT)} } });
    } else if (text === "todo") {
      update(sid, { sessionUpdate: "tool_call", toolCallId: "p1", title: "todowrite", kind: "other", rawInput: { todos: [
        { content: "one", status: "completed", priority: "high" },
        { content: "two", status: "in_progress" },
        { content: "skip", status: "cancelled" }
      ] }, status: "pending" });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "p1", status: "completed" });
    }
    return send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
  }
  send({ id, error: { code: -32601, message: method } });
});
`;

function inlineDriver() {
  const d = createAcpDriver({ id: "inline", label: "Inline", command: process.execPath, args: ["-e", INLINE_ACP] }, { clientVersion: "test" });
  closeAfter(() => d.dispose?.());
  return d;
}

// An agent that advertises loadSession but fails session/load, echoing each
// session/prompt's blocks as JSON so a test can read the history prefix back.
const INLINE_ACP_LOST = `
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (method === "session/load") return send({ id, error: { code: -32002, message: "session not found: " + params.sessionId } });
  if (method === "session/new") return send({ id, result: { sessionId: "s-lost", configOptions: [] } });
  if (method === "session/cancel") return;
  if (method === "session/prompt") {
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(params.prompt) } });
    return send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
  }
  send({ id, error: { code: -32601, message: method } });
});
`;

function lostDriver() {
  const d = createAcpDriver({ id: "lossy", label: "Lossy", command: process.execPath, args: ["-e", INLINE_ACP_LOST] }, { clientVersion: "test" });
  closeAfter(() => d.dispose?.());
  return d;
}

// An agent that advertises ACP's native session modes (build/plan) and records
// every session/set_mode and session/prompt, so a test can watch the switches.
const MODES_ACP = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const log = (o) => fs.appendFileSync(process.env.MODES_PROBE, JSON.stringify(o) + "\\n");
let currentMode = "build";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true } }, authMethods: [] } });
  if (method === "session/new" || method === "session/resume") return send({ id, result: { sessionId: "s-1", configOptions: [], modes: { currentModeId: currentMode, availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] } } });
  if (method === "session/set_mode") {
    currentMode = params.modeId;
    log({ method, modeId: params.modeId });
    update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: currentMode });
    return send({ id, result: {} });
  }
  if (method === "session/cancel") return;
  if (method === "session/set_config_option") return send({ id, result: { configOptions: [] } });
  if (method === "session/prompt") {
    const text = params.prompt.map((b) => b.text).join("");
    log({ method, prompt: text, mode: currentMode });
    const answer = currentMode === "plan" ? "# Native plan" : "Implemented (build)";
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
    return send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });
  }
  send({ id, error: { code: -32601, message: method } });
});
`;

function modesDriver() {
  const d = createAcpDriver({ id: "modes", label: "Modes", command: process.execPath, args: ["-e", MODES_ACP] }, { clientVersion: "test" });
  closeAfter(() => d.dispose?.());
  return d;
}

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
    requestPlanDecision: async () => ({ keep: "" }),
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
    expect(t.events.map((e) => e.kind)).toEqual(["turn-start", "thinking", "assistant-text", "context-breakdown", "turn-end"]);
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

  it("sends the memory block once, right after the guide, on a new session's first prompt", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", guide: () => "GUIDE", memory: () => "<harness-memory>MEM</harness-memory>" },
    );
    closeAfter(() => d.dispose?.());
    const first = turn("hello", { projectId: "p1" });
    await d.runTurn(first.input);
    const firstText = first.deltas.join("");
    expect(firstText).toContain("<harness-guide>\nGUIDE\n</harness-guide>");
    expect(firstText).toContain("<harness-memory>MEM</harness-memory>");
    expect(firstText.indexOf("<harness-guide>")).toBeLessThan(firstText.indexOf("<harness-memory>"));
    const second = turn("hello", { sessionId: first.sessions[0]!, projectId: "p1" });
    await d.runTurn(second.input);
    expect(second.deltas.join("")).not.toContain("<harness-memory>");
  });

  it("sends no memory block when memory is off", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", guide: () => "GUIDE", memory: () => null },
    );
    closeAfter(() => d.dispose?.());
    const first = turn("hello", { projectId: "p1" });
    await d.runTurn(first.input);
    const firstText = first.deltas.join("");
    expect(firstText).toContain("<harness-guide>\nGUIDE\n</harness-guide>");
    expect(firstText).not.toContain("<harness-memory>");
  });

  it("prices the agent's skills and MCP tools in a fresh session's breakdown", async () => {
    let extCalls = 0;
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      {
        clientVersion: "test",
        extensions: () => {
          extCalls++;
          return { skills: 120, mcp: 900 };
        },
      },
    );
    closeAfter(() => d.dispose?.());
    const t = turn("hello");
    await d.runTurn(t.input);
    expect(extCalls).toBeGreaterThanOrEqual(2);
    const breakdown = t.events.find((e): e is Extract<ThreadEvent, { kind: "context-breakdown" }> => e.kind === "context-breakdown");
    expect(breakdown?.rows).toEqual(expect.arrayContaining([{ label: "Skills", tokens: 120 }, { label: "MCP tools", tokens: 900 }]));
  });

  it("drops the skills and MCP rows when the agent carries none", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", extensions: () => ({ skills: 0, mcp: 0 }) },
    );
    closeAfter(() => d.dispose?.());
    const t = turn("hello");
    await d.runTurn(t.input);
    const breakdown = t.events.find((e): e is Extract<ThreadEvent, { kind: "context-breakdown" }> => e.kind === "context-breakdown");
    const labels = breakdown?.rows.map((r) => r.label) ?? [];
    expect(labels).not.toContain("Skills");
    expect(labels).not.toContain("MCP tools");
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

  it("reports a turn where the model returned nothing, before the turn-end", async () => {
    const d = driver();
    const t = turn("empty", { model: "mock-small" });
    await d.runTurn(t.input);
    const kinds = t.events.map((e) => e.kind);
    const error = t.events.find((e): e is Extract<ThreadEvent, { kind: "error" }> => e.kind === "error");
    expect(error).toBeDefined();
    // The model id names which model came back empty.
    expect(error!.message).toContain("mock-small");
    expect(error!.message).toContain("Mock returned nothing");
    expect(error!.message).toContain("try another model");
    expect(kinds.indexOf("error")).toBeLessThan(kinds.indexOf("turn-end"));
  });

  it("does not report an ordinary reply as empty", async () => {
    const d = driver();
    const t = turn("world");
    await d.runTurn(t.input);
    expect(t.events.some((e) => e.kind === "error")).toBe(false);
  });

  it("carries the reported context window onto the turn-end usage", async () => {
    const d = driver();
    const t = turn("world");
    await d.runTurn(t.input);
    expect(t.events.at(-1)).toMatchObject({
      kind: "turn-end",
      usage: { contextUsed: 1234, contextSize: 100000 },
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

  it("pins a provider per thread: a provider model respawns with it, resumes the session, and lists saved providers' models", async () => {
    const providers: (string | null)[] = [];
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      {
        clientVersion: "test",
        extraModels: () => [
          { id: "unskilled-th/fast", label: "TokenHarbor/Fast" },
          { id: "mock-small", label: "Mock Small (again)" },
        ],
        injection: (ctx) => {
          providers.push(ctx?.providerId ?? null);
          return { env: {}, byok: Boolean(ctx?.providerId) };
        },
      },
    );
    closeAfter(() => d.dispose?.());

    // The mock resumes this session id in a new process, as OpenCode resumes its stored sessions.
    const own = turn("one", { sessionId: "resumable-session", model: "mock-small" });
    await d.runTurn(own.input);
    expect(own.deltas.join("")).toBe("Hello, one (mock-small)");
    // Saved providers' models follow the agent's own; one it already lists isn't repeated.
    expect(d.models().map((m) => m.id)).toEqual(["default", "mock-small", "mock-large", "unskilled-th/fast"]);

    const pinned = turn("two", { sessionId: own.sessions[0]!, model: "unskilled-th/fast" });
    await d.runTurn(pinned.input);
    expect(providers).toEqual([null, "th"]);
    expect(pinned.sessions).toEqual(["resumable-session"]);
    expect(pinned.deltas.join("")).toBe("Hello, two (unskilled-th/fast)");
    expect(pinned.events.filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text)).toEqual(["Mock restarted to switch provider; the conversation continues."]);

    // Same provider: the process stays.
    const again = turn("three", { sessionId: own.sessions[0]!, model: "unskilled-th/fast" });
    await d.runTurn(again.input);
    expect(providers).toEqual([null, "th"]);
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

  it("seeds a new session with a prompt prefix when the stored one can't be reopened", async () => {
    const d = lostDriver();
    const reasons: string[] = [];
    const first = turn("hello", {
      sessionId: "gone",
      onSessionLost: async (reason) => {
        reasons.push(reason);
        return { promptPrefix: "HISTORY" };
      },
    });
    await d.runTurn(first.input);
    expect(reasons).toEqual([expect.stringContaining("session not found")]);
    expect(first.sessions).toEqual(["s-lost"]);
    expect(JSON.parse(first.deltas.join(""))).toEqual([
      { type: "text", text: "HISTORY\n---" },
      { type: "text", text: "hello" },
    ]);
    // The prefix is a first-prompt-only catch-up: the next turn drops it.
    const second = turn("hello", { sessionId: first.sessions[0]!, onSessionLost: async () => null });
    await d.runTurn(second.input);
    expect(JSON.parse(second.deltas.join(""))).toEqual([{ type: "text", text: "hello" }]);
  }, 30_000);

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
    expect(kinds).toEqual(["turn-start", "thinking", "assistant-text", "tool-use", "tool-result", "assistant-text", "context-breakdown", "turn-end"]);
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

  it("suppresses a terminal update under a permission id that never announced a tool_call (Antigravity phantom row)", async () => {
    const d = driver();
    const t = turn("phantom-permission");
    await d.runTurn(t.input);
    // The real call still announces and reports.
    expect(t.events.filter((e) => e.kind === "tool-use")).toEqual([expect.objectContaining({ toolUseId: "s-1:1", name: "Edit" })]);
    const results = t.events.filter((e) => e.kind === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolUseId: "s-1:1", isError: false });
    // The phantom "failed" update under "perm-hash-1" never became a row.
    expect(t.events.some((e) => e.kind === "tool-result" && (e as { toolUseId: string }).toolUseId === "perm-hash-1")).toBe(false);
    expect(t.events.some((e) => e.kind === "tool-use" && (e as { toolUseId: string }).toolUseId === "perm-hash-1")).toBe(false);
  });

  it("signs in on demand when session/new needs auth, relaying the link, and retries once", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK], env: { MOCK_ACP_NEEDS_AUTH: "1" } },
      { clientVersion: "test" },
    );
    closeAfter(() => d.dispose?.());
    const t = turn("needs-auth");
    await d.runTurn(t.input);
    const notices = t.events.filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices.some((n) => n.includes("https://example.com/sign-in?x=1"))).toBe(true);
    // The retried session/new worked and the turn answered normally.
    expect(t.sessions).toEqual(["s-1"]);
    expect(t.deltas.join("")).toContain("Hello, needs-auth");
    expect(t.events.some((e) => e.kind === "error")).toBe(false);
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
    expect(first.deltas.join("")).toBe('[["http","cubiq","http://127.0.0.1:9/mcp?t=thread-1"]]');
    const second = turn("mcp", { sessionId: first.sessions[0]!, tools: [tool] });
    await d.runTurn(second.input);
    expect(second.deltas.join("")).toBe('[["http","cubiq","http://127.0.0.1:9/mcp?t=thread-1"]]');
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

  it("routes the user's MCP servers through the harness router when the agent opts in", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK], capabilities: { mcpRouter: true } },
      {
        clientVersion: "test",
        toolServer: async () => ({ url: "http://127.0.0.1:9/mcp", skillsUrl: "http://127.0.0.1:9/mcp-skills", routedUrl: "http://127.0.0.1:9/mcp-routed", token: "t" }),
        mcpRouting: async () => true,
      },
    );
    closeAfter(() => d.dispose?.());
    const browser = { name: "browser_snapshot", description: "", input: {}, autoAllow: true, run: async () => ({ text: "" }) };
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: [] } };
    const t = turn("mcp", { tools: [browser], projectId: "p1", mcpServers: [docs] });
    await d.runTurn(t.input);
    // The user's server isn't sent; only the harness entry, on /mcp-routed with the project.
    expect(JSON.parse(t.deltas.join(""))).toEqual([["http", "cubiq", "http://127.0.0.1:9/mcp-routed?p=p1&t=thread-1"]]);
  });

  it("sends the user's MCP servers as before when the router decision is no", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK], capabilities: { mcpRouter: true } },
      { clientVersion: "test", toolServer: async () => ({ url: "http://127.0.0.1:9/mcp", token: "t" }), mcpRouting: async () => false },
    );
    closeAfter(() => d.dispose?.());
    const browser = { name: "browser_snapshot", description: "", input: {}, autoAllow: true, run: async () => ({ text: "" }) };
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: [] } };
    const t = turn("mcp", { tools: [browser], projectId: "p1", mcpServers: [docs] });
    await d.runTurn(t.input);
    const sent = JSON.parse(t.deltas.join("")) as [string | null, string, string?][];
    expect(sent.map((m) => m[1])).toEqual(["docs", "cubiq"]);
    expect(sent.find((m) => m[1] === "cubiq")?.[2]).toBe("http://127.0.0.1:9/mcp?p=p1&t=thread-1");
  });

  it("never asks about routing when the agent doesn't declare mcpRouter", async () => {
    let asked = 0;
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      {
        clientVersion: "test",
        toolServer: async () => ({ url: "http://127.0.0.1:9/mcp", routedUrl: "http://127.0.0.1:9/mcp-routed", token: "t" }),
        mcpRouting: async () => {
          asked++;
          return true;
        },
      },
    );
    closeAfter(() => d.dispose?.());
    const browser = { name: "browser_snapshot", description: "", input: {}, autoAllow: true, run: async () => ({ text: "" }) };
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: [] } };
    const t = turn("mcp", { tools: [browser], mcpServers: [docs] });
    await d.runTurn(t.input);
    expect(asked).toBe(0);
    const sent = JSON.parse(t.deltas.join("")) as [string | null, string, string?][];
    expect(sent.map((m) => m[1])).toEqual(["docs", "cubiq"]);
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

describe("ACP plan mode", () => {
  it("switches native session modes around a plan and implements on auto", async () => {
    const probe = join(tempDir(), "modes.jsonl");
    process.env.MODES_PROBE = probe;
    try {
      const plans: string[] = [];
      const t = turn("make a plan", {
        permissionMode: "plan" as PermissionMode,
        requestPlanDecision: async (p) => {
          plans.push(p.plan);
          return "auto";
        },
      });
      await modesDriver().runTurn(t.input);
      expect(plans).toEqual(["# Native plan"]);
      const calls = readFileSync(probe, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; modeId?: string; prompt?: string });
      // In plan, then back to the default mode for the implementing round.
      expect(calls.filter((c) => c.method === "session/set_mode").map((c) => c.modeId)).toEqual(["plan", "build"]);
      const prompts = calls.filter((c) => c.method === "session/prompt");
      expect(prompts.map((c) => c.prompt)).toEqual(["make a plan", "Implement the plan."]);
      // A native mode needs no emulation brief.
      expect(prompts[0]!.prompt).not.toContain("<harness-plan-mode>");
      expect(t.events.filter((e) => e.kind === "turn-start")).toHaveLength(1);
      expect(t.events.filter((e) => e.kind === "turn-end")).toHaveLength(1);
    } finally {
      delete process.env.MODES_PROBE;
    }
  });

  it("prefixes the prompt with the plan brief when the agent has no native mode", async () => {
    const t = turn("make a plan", {
      permissionMode: "plan" as PermissionMode,
      requestPlanDecision: async () => "auto",
    });
    await lostDriver().runTurn(t.input);
    // INLINE_ACP_LOST echoes its prompt blocks as JSON, so the driver's own brief is visible.
    const texts = t.events.filter((e): e is Extract<ThreadEvent, { kind: "assistant-text" }> => e.kind === "assistant-text").map((e) => e.text);
    const firstBlocks = JSON.parse(texts[0]!) as { text: string }[];
    expect(firstBlocks[0]!.text).toContain("<harness-plan-mode>");
    expect(firstBlocks[0]!.text).toContain("make a plan");
    const secondBlocks = JSON.parse(texts[1]!) as { text: string }[];
    expect(secondBlocks[0]!.text).toBe("Implement the plan.");
    expect(t.events.filter((e) => e.kind === "turn-end")).toHaveLength(1);
  });

  it("stops instead of starting another round when the plan card is aborted", async () => {
    const probe = join(tempDir(), "modes.jsonl");
    process.env.MODES_PROBE = probe;
    try {
      let t!: ReturnType<typeof turn>;
      t = turn("make a plan", {
        permissionMode: "plan" as PermissionMode,
        requestPlanDecision: async () => {
          t.controller.abort();
          return { keep: "" };
        },
      });
      await modesDriver().runTurn(t.input);
      const calls = readFileSync(probe, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string });
      // The aborted decision must not send a "Refine the plan." prompt.
      expect(calls.filter((c) => c.method === "session/prompt")).toHaveLength(1);
      expect(t.events.filter((e) => e.kind === "notice" && e.text === "Stopped.")).toHaveLength(1);
      expect(t.events.filter((e) => e.kind === "turn-end")).toHaveLength(1);
    } finally {
      delete process.env.MODES_PROBE;
    }
  });
});

describe("ACP tool payloads", () => {
  it("gives an OpenCode write a diff payload and repeats it on the result", async () => {
    const d = inlineDriver();
    const t = turn("write");
    await d.runTurn(t.input);
    const use = t.events.find((e) => e.kind === "tool-use");
    expect(use).toMatchObject({ kind: "tool-use", toolUseId: "w1", payload: { filePath: "a.txt", diff: [{ path: "a.txt" }] } });
    const result = t.events.find((e) => e.kind === "tool-result");
    expect(result).toMatchObject({ kind: "tool-result", toolUseId: "w1", isError: false });
    const payload = (result as { payload: { diff: { path: string }[] } }).payload;
    expect(payload.diff.map((x) => x.path)).toEqual(["a.txt"]);
    expect((result as { summary: string }).summary).toMatch(/^\+\d+/);
  });

  it("takes an Antigravity command's output and exit code from rawOutput when content is empty", async () => {
    const d = inlineDriver();
    const t = turn("antigravity-exec");
    await d.runTurn(t.input);
    const result = t.events.find((e) => e.kind === "tool-result");
    expect(result).toMatchObject({ kind: "tool-result", toolUseId: "5c51", isError: false, payload: { exitCode: 0, output: "HI\n" } });
    expect((result as { summary: string }).summary.startsWith("HI")).toBe(true);
  });

  it("keeps a generic tool's raw input and its output as payloads", async () => {
    const d = inlineDriver();
    const t = turn("generic");
    await d.runTurn(t.input);
    expect(t.events.find((e) => e.kind === "tool-use")).toMatchObject({ kind: "tool-use", toolUseId: "g1", payload: { query: "cats" } });
    expect(t.events.find((e) => e.kind === "tool-result")).toMatchObject({ kind: "tool-result", toolUseId: "g1", payload: "results for cats" });
  });

  it("names a subagent call Agent and unwraps its task result", async () => {
    const d = inlineDriver();
    const t = turn("task");
    await d.runTurn(t.input);
    const use = t.events.find((e) => e.kind === "tool-use");
    expect(use).toMatchObject({ kind: "tool-use", toolUseId: "a1", name: "Agent", summary: "research · explore" });
    const result = t.events.find((e) => e.kind === "tool-result");
    expect((result as { payload: unknown }).payload).toBe("Found it\nmore");
    expect((result as { summary: string }).summary.startsWith("Found it")).toBe(true);
  });

  it("folds an OpenCode todowrite into one plan event with no tool row", async () => {
    const d = inlineDriver();
    const t = turn("todo");
    await d.runTurn(t.input);
    expect(t.events.filter((e) => e.kind === "plan")).toEqual([
      {
        kind: "plan",
        entries: [
          { content: "one", status: "completed", priority: "high" },
          { content: "two", status: "in_progress" },
        ],
      },
    ]);
    expect(t.events.some((e) => e.kind === "tool-use" || e.kind === "tool-result")).toBe(false);
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
    const { agents, problems } = loadAcpAgents(file, (cmd) => cmd === "opencode");
    expect(agents.map((a) => a.id)).toEqual(["opencode", "qwen"]);
    expect(agents[0]).toMatchObject({ command: "opencode", args: ["acp"] });
    expect(problems).toHaveLength(1);
  });

  it("offers Antigravity over ACP only once opted in: the preset is gated, and an agents.json entry still doesn't replace it", () => {
    const dir = tempDir();
    const file = join(dir, "agents.json");
    const installed = (cmd: string) => cmd === antigravityAcpCommand();
    expect(loadAcpAgents(file, installed, { optedIn: true }).agents.map((a) => a.id)).toEqual(["antigravity"]);
    expect(loadAcpAgents(file, installed).agents).toEqual([]);
    writeFileSync(file, JSON.stringify({ agents: [{ id: "antigravity", label: "Antigravity (old)", command: antigravityAcpCommand(), args: ["--experimental"] }] }));
    expect(loadAcpAgents(file, installed, { optedIn: true }).agents).toEqual([]);
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

  it("names the Antigravity ACP server per platform", () => {
    expect(antigravityAcpCommand("win32")).toBe("agy_acp_server.exe");
    expect(antigravityAcpCommand("darwin")).toBe("agy_acp_server.par");
    expect(antigravityAcpCommand("linux")).toBe("agy_acp_server.par");
  });

  it("finds a Windows command that already names its extension, without doubling PATHEXT", () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // The ACP server's .exe already carries the extension; appending PATHEXT
    // would look for "agy_acp_server.exe.exe" and never find it.
    writeFileSync(join(bin, "agy_acp_server.exe"), "", { mode: 0o644 });
    expect(onPath("agy_acp_server.exe", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(true);
    expect(onPath("missing.exe", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(false);
    // A bare command still gets PATHEXT appended, as before.
    writeFileSync(join(bin, "tool.cmd"), "", { mode: 0o644 });
    expect(onPath("tool", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(true);
  });
});

describe("antigravity sign-in link", () => {
  it("extracts the URL from the server's stderr line, and null otherwise", () => {
    expect(authUrlFrom("Open the following link to authenticate the ACP server: https://example.com/sign-in?x=1")).toBe("https://example.com/sign-in?x=1");
    expect(authUrlFrom("Open the following link to authenticate: https://example.com/x")).toBe("https://example.com/x");
    expect(authUrlFrom("some unrelated log line")).toBeNull();
  });
});

describe("ACP oneShot", () => {
  it("runs a throwaway prompt, returns the agent chunks, and leaves no session behind", async () => {
    const d = driver();
    expect(await d.oneShot!({ prompt: "world", model: null })).toBe("Hello, world (mock-small)");
    // A second call resolves from its own process, on the model it switched to.
    expect(await d.oneShot!({ prompt: "again", model: "mock-large" })).toBe("Hello, again (mock-large)");
    // The throwaway never touched the driver's live sessions: a normal turn starts fresh.
    const t = turn("world");
    await d.runTurn(t.input);
    expect(t.sessions).toEqual(["s-1"]);
  });
});

