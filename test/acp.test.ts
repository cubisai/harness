import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionMode, ThreadEvent } from "../src/shared/types";
import { createAcpDriver, optionFor, pickPermission } from "../src/main/agents/acp/driver";
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

  it("attaches the harness's tool server when tools exist, even mid-conversation", async () => {
    const d = createAcpDriver(
      { id: "mock", label: "Mock", command: process.execPath, args: [MOCK] },
      { clientVersion: "test", toolServer: async () => ({ url: "http://127.0.0.1:9/mcp", token: "t" }) },
    );
    closeAfter(() => d.dispose?.());
    const before = turn("mcp");
    await d.runTurn(before.input);
    expect(before.deltas.join("")).toBe("[]");
    const tool = { name: "browser_snapshot", description: "", input: {}, autoAllow: true, run: async () => ({ text: "" }) };
    const after = turn("mcp", { sessionId: before.sessions[0]!, tools: [tool] });
    await d.runTurn(after.input);
    expect(after.deltas.join("")).toBe('[["http","unskilled","http://127.0.0.1:9/mcp"]]');
  });

  it("passes the user's MCP servers, and reopens the session when they change", async () => {
    const d = driver();
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: ["--stdio"] } };
    const remote = { name: "remote", enabled: true, spec: { type: "http" as const, url: "https://mcp.example.com/mcp" } };
    const first = turn("mcp", { mcpServers: [docs] });
    await d.runTurn(first.input);
    // stdio servers have no type field in ACP.
    expect(first.deltas.join("")).toBe('[[null,"docs",null]]');
    const second = turn("mcp", { sessionId: first.sessions[0]!, mcpServers: [docs, remote] });
    await d.runTurn(second.input);
    expect(second.deltas.join("")).toBe('[[null,"docs",null],["http","remote","https://mcp.example.com/mcp"]]');
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

  it("starts Antigravity through agy-acp, and lets agents.json replace a preset", () => {
    const dir = tempDir();
    const file = join(dir, "agents.json");
    expect(loadAcpAgents(file, (cmd) => cmd === "agy-acp").agents).toEqual([
      expect.objectContaining({ id: "antigravity", command: "agy-acp", args: [] }),
    ]);
    writeFileSync(file, JSON.stringify({ agents: [{ id: "antigravity", label: "Antigravity (old)", command: "agy-acp", args: ["--experimental"] }] }));
    expect(loadAcpAgents(file, (cmd) => cmd === "agy-acp").agents).toEqual([
      expect.objectContaining({ label: "Antigravity (old)", args: ["--experimental"] }),
    ]);
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
