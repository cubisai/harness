import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionDecision, ThreadEvent } from "../src/shared/types";
import { z } from "zod";
import { codexDecision, codexPolicy, codexToolConfig, createCodexDriver, turnEndFromUsage } from "../src/main/agents/codex";
import type { LimitsPatch } from "../src/main/agents/limits";
import type { HarnessTool, SeedRequest, TurnInput } from "../src/main/agents/types";
import { Store } from "../src/main/db";
import { injectWithLedger } from "../src/main/handoff";
import { startToolServer } from "../src/main/mcp-http";
import { closeAfter, tempDir } from "./helpers";

const MOCK = join(__dirname, "fixtures", "mock-codex-app-server.mjs");
const GUARD = join(__dirname, "fixtures", "fake-guard.py");

function driver() {
  const d = createCodexDriver({ command: process.execPath, args: [MOCK], clientVersion: "test", skillsDir: () => "/skills/here" });
  closeAfter(() => d.dispose?.());
  return d;
}

function guardedDriver() {
  const d = createCodexDriver({ command: process.execPath, args: [MOCK], clientVersion: "test", guardScript: GUARD });
  closeAfter(() => d.dispose?.());
  return d;
}

/** Poll until `fn` is true (a guard check from a completed item settles out of band). */
async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
}

function turn(prompt: string, over: Partial<TurnInput> = {}) {
  const events: ThreadEvent[] = [];
  const deltas: string[] = [];
  const sessions: string[] = [];
  const asked: string[] = [];
  const controller = new AbortController();
  const input: TurnInput = {
    threadId: "t",
    cwd: tmpdir(),
    prompt,
    sessionId: null,
    model: "default",
    permissionMode: "ask",
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

describe("Codex driver", () => {
  it("runs a turn: reasoning, streamed reply, usage", async () => {
    const d = driver();
    const t = turn("there");
    await d.runTurn(t.input);
    expect(t.sessions).toEqual(["thread-1"]);
    expect(t.deltas.join("")).toBe("Hi, there");
    expect(t.events.map((e) => e.kind)).toEqual(["turn-start", "thinking", "assistant-text", "turn-end"]);
    expect(t.events.at(-1)).toMatchObject({ inputTokens: 900, outputTokens: 12, durationMs: 42 });
    expect(d.models().map((m) => m.id)).toEqual(["default", "gpt-mock"]);
  });

  it("loads models at startup without a turn", async () => {
    const d = driver();
    expect(d.models().map((m) => m.id)).toEqual(["default"]);
    await d.refreshModels!();
    expect(d.models().map((m) => m.id)).toEqual(["default", "gpt-mock"]);
  });

  it("passes on the rate limits Codex reports during a turn", async () => {
    const reports: LimitsPatch[] = [];
    const d = createCodexDriver({ command: process.execPath, args: [MOCK], clientVersion: "test", onLimits: (p) => reports.push(p) });
    closeAfter(() => d.dispose?.());
    await d.runTurn(turn("there").input);
    expect(reports).toEqual([{ windows: [{ id: "codex:primary", label: "5-hour", usedPercent: 37, resetsAt: 1_790_000_000_000 }], plan: "plus" }]);
  });

  it("registers skilled's skills as an extra skills root", async () => {
    const d = driver();
    const t = turn("roots");
    await d.runTurn(t.input);
    expect(t.events[1]).toMatchObject({ kind: "assistant-text", text: '["/skills/here"]' });
  });

  it("says the thread was reopened when the MCP servers change", async () => {
    const d = driver();
    const docs = { name: "docs", enabled: true, spec: { type: "stdio" as const, command: "docs-mcp", args: [] } };
    const remote = { name: "remote", enabled: true, spec: { type: "http" as const, url: "https://mcp.example.com/mcp" } };
    const first = turn("a", { mcpServers: [docs] });
    await d.runTurn(first.input);
    const second = turn("b", { sessionId: first.sessions[0]!, mcpServers: [docs, remote] });
    await d.runTurn(second.input);
    const notices = second.events.filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/remote/);
    expect(notices[0]).toMatch(/reopened/);
  });

  it("resumes a known thread and starts fresh for an unknown one", async () => {
    const d = driver();
    const known = turn("a", { sessionId: "known-thread" });
    await d.runTurn(known.input);
    expect(known.sessions).toEqual(["known-thread"]);
    const unknown = turn("b", { sessionId: "gone" });
    await d.runTurn(unknown.input);
    expect(unknown.events[0]).toMatchObject({ kind: "notice" });
    expect(unknown.sessions[0]).toMatch(/^thread-/);
  });

  it("asks before running a command and reports its output", async () => {
    const d = driver();
    const t = turn("tool");
    await d.runTurn(t.input);
    expect(t.asked).toEqual(["npm test"]);
    expect(t.events.slice(1, 3)).toEqual([
      { kind: "tool-use", toolUseId: "c1", name: "Run", summary: "npm test", payload: { command: "npm test" } },
      { kind: "tool-result", toolUseId: "c1", isError: false, summary: "3 passed (accept)", payload: { exitCode: 0, output: "3 passed (accept)" } },
    ]);
  });

  it("declines a guarded command without asking, and notices", async () => {
    const d = guardedDriver();
    const t = turn("tool:git push --force");
    await d.runTurn(t.input);
    expect(t.asked).toEqual([]);
    const guardNotices = t.events.filter((e) => e.kind === "notice" && /Blocked by git guardrails/.test((e as { text: string }).text));
    expect(guardNotices).toHaveLength(1);
    expect(t.events.find((e) => e.kind === "tool-result")).toMatchObject({ isError: true, summary: "Failed" });
  });

  it("still asks for a command the guard allows", async () => {
    const d = guardedDriver();
    const t = turn("tool:npm test");
    await d.runTurn(t.input);
    expect(t.asked).toEqual(["npm test"]);
  });

  it("auto-approves file changes in Auto-edit mode without asking", async () => {
    const d = guardedDriver();
    const t = turn("file", { permissionMode: "auto-edit" });
    await d.runTurn(t.input);
    expect(t.asked).toEqual([]);
    expect(t.events.find((e) => e.kind === "tool-result")).toMatchObject({ isError: false });
  });

  it("still asks for a file change in Ask mode", async () => {
    const d = guardedDriver();
    const t = turn("file");
    await d.runTurn(t.input);
    expect(t.asked).toEqual(["edit a.txt"]);
  });

  it("warns about a blocked command that ran in Full mode", async () => {
    const d = guardedDriver();
    const t = turn("run:git push --force", { permissionMode: "full" });
    await d.runTurn(t.input);
    await waitFor(() => t.events.some((e) => e.kind === "notice" && /Guardrail warning/.test((e as { text: string }).text)));
    expect(t.events.find((e) => e.kind === "notice" && /Guardrail warning/.test((e as { text: string }).text))).toBeDefined();
  });

  it("interrupts a running turn", async () => {
    const d = driver();
    const t = turn("slow");
    const running = d.runTurn(t.input);
    await new Promise((r) => setTimeout(r, 200));
    t.controller.abort();
    await running;
    expect(t.events.some((e) => e.kind === "notice" && e.text === "Stopped.")).toBe(true);
  });

  it("streams reasoning, summaries, and tool output, keyed by item id", async () => {
    const d = driver();
    const log: { kind: string; [key: string]: unknown }[] = [];
    const reasoning: { itemId: string; text: string; opaque: boolean }[] = [];
    const summaries: { itemId: string; index: number; text: string }[] = [];
    const toolOutputs: { toolUseId: string; text: string }[] = [];
    const t = turn("reason", {
      onEvent: (e) => log.push(e as { kind: string }),
      onReasoningDelta: (r) => {
        reasoning.push(r);
        log.push({ kind: "cb-reasoning", ...r });
      },
      onReasoningSummary: (s) => {
        summaries.push(s);
        log.push({ kind: "cb-summary", ...s });
      },
      onToolOutputDelta: (o) => {
        toolOutputs.push(o);
        log.push({ kind: "cb-tool-output", ...o });
      },
    });
    await d.runTurn(t.input);

    expect(reasoning).toEqual([
      { itemId: "r1", text: "Let me ", opaque: false },
      { itemId: "r1", text: "see.", opaque: false },
    ]);
    expect(summaries).toEqual([
      { itemId: "r1", index: 0, text: "Looking" },
      { itemId: "r1", index: 1, text: "Checking" },
    ]);
    expect(toolOutputs).toContainEqual({ toolUseId: "c2", text: "a.txt\n" });
    expect(log.find((e) => e.kind === "thinking")).toMatchObject({ kind: "thinking", itemId: "r1", text: "Looking\n\nChecking" });
    expect(log.find((e) => e.kind === "assistant-text")).toMatchObject({ kind: "assistant-text", itemId: "m2" });
    const outputIndex = log.findIndex((e) => e.kind === "cb-tool-output" && e.toolUseId === "c2");
    const resultIndex = log.findIndex((e) => e.kind === "tool-result" && e.toolUseId === "c2");
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(outputIndex);
  });

  it("flushes streamed text before the Stopped notice when interrupted", async () => {
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
    // Abort only once something has streamed: a fixed sleep races a slow start under load.
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

  it("starts with turn-start before any content event", async () => {
    const d = driver();
    const t = turn("there");
    await d.runTurn(t.input);
    expect(t.events[0]).toMatchObject({ kind: "turn-start", turnId: "turn-1", agent: "codex", model: "default" });
    const content = t.events.findIndex((e) => e.kind === "assistant-text" || e.kind === "thinking" || e.kind === "tool-use");
    expect(content).toBeGreaterThan(0);
  });

  it("maps turn/plan/updated to a plan event", async () => {
    const d = driver();
    const t = turn("plan");
    await d.runTurn(t.input);
    expect(t.events.find((e) => e.kind === "plan")).toEqual({
      kind: "plan",
      entries: [
        { content: "Read code", status: "completed" },
        { content: "Fix bug", status: "in_progress" },
        { content: "Test", status: "pending" },
      ],
    });
  });

  it("emits exactly one compaction for a contextCompaction item", async () => {
    const d = driver();
    const t = turn("compact");
    await d.runTurn(t.input);
    expect(t.events.filter((e) => e.kind === "compaction")).toEqual([
      { kind: "compaction", trigger: "auto", preTokens: null, postTokens: null },
    ]);
  });

  it("reports cached tokens as cache reads and net-new input", async () => {
    const d = driver();
    const t = turn("cached");
    await d.runTurn(t.input);
    const end = t.events.at(-1);
    expect(end).toMatchObject({ kind: "turn-end", inputTokens: 1000, outputTokens: 12 });
    expect(end?.kind === "turn-end" ? end.usage?.cacheReadTokens : undefined).toBe(8000);
  });
});

describe("Codex seeding", () => {
  it("seeds through the ledger, resumes without re-sending, and never starts a turn", async () => {
    const d = driver();
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const items = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "handoff" }] },
      { type: "function_call", call_id: "call-9", name: "Bash", arguments: "{}" },
      { type: "function_call_output", call_id: "call-9", output: "3 passed" },
    ];
    let sessionId: string | null = null;
    const sessions: string[] = [];
    const seedReq = (): SeedRequest => ({
      threadId: "t",
      sessionId,
      cwd: tmpdir(),
      model: "default",
      permissionMode: "ask",
      tools: [],
      mcpServers: [],
      items,
      onSession: (s) => sessions.push(s),
      inject: (sid, send) =>
        injectWithLedger(store, { threadId: "t", provider: "codex", sessionId: sid, checkpointId: "cp-1" }, items, "codex/inject_items", send),
    });

    const first = await d.seed!(seedReq());
    expect(first).toMatchObject({ mode: "seeded", sent: 3 });
    expect(sessions).toHaveLength(1);
    sessionId = first.sessionId!;

    // Same target session: the ledger skips everything already injected.
    const second = await d.seed!(seedReq());
    expect(second).toMatchObject({ mode: "seeded", sent: 0 });

    // Events are collected only by turn(), which runs after both seeds: the
    // seeds opened and injected without starting a turn.
    const t = turn("injects", { sessionId });
    await d.runTurn(t.input);
    expect(t.events.find((e) => e.kind === "assistant-text")).toMatchObject({ text: "injects=1 ids=call-9" });
  });
});

describe("turnEndFromUsage", () => {
  it("prefers netNewInputTokens over the subtraction", () => {
    const e = turnEndFromUsage(
      { inputTokens: 9000, cachedInputTokens: 8000, outputTokens: 12, netNewInputTokens: 750, cacheWriteInputTokens: 100, reasoningOutputTokens: 3 },
      42,
    );
    expect(e).toMatchObject({ kind: "turn-end", inputTokens: 750, outputTokens: 12, durationMs: 42, costUsd: null });
    if (e.kind !== "turn-end") return;
    expect(e.usage).toMatchObject({ inputTokens: 750, cacheReadTokens: 8000, cacheWriteTokens: 100, reasoningTokens: 3, provenance: "reported" });
  });

  it("reports unavailable usage when none was seen", () => {
    const e = turnEndFromUsage(undefined, 7);
    expect(e).toMatchObject({ kind: "turn-end", inputTokens: 0, outputTokens: 0, durationMs: 7 });
    if (e.kind !== "turn-end") return;
    expect(e.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, provenance: "unavailable" });
  });
});

describe("Codex policy mapping", () => {
  it("maps permission modes and decisions", () => {
    // Pinned by spikes (spec/open-questions.md): codex 0.157 still honours "untrusted" and it is the only
    // policy that asks before every command; the request's sandbox spelling is kebab-case (camelCase is rejected).
    expect(codexPolicy("ask")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(codexPolicy("ask").approvalPolicy).not.toBe("on-request");
    for (const mode of ["ask", "auto-edit", "full"] as const) expect(["read-only", "workspace-write", "danger-full-access"]).toContain(codexPolicy(mode).sandbox);
    expect(codexPolicy("auto-edit")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(codexPolicy("full")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(codexDecision("allow-always")).toBe("acceptForSession");
    expect(codexDecision("deny")).toBe("decline");
  });
});

describe("Codex with the harness's tools", () => {
  const evalTool: HarnessTool = {
    name: "browser_eval",
    description: "Evaluate JS",
    input: { expression: z.string() },
    autoAllow: false,
    run: async (a) => ({ text: `evaluated ${(a as { expression: string }).expression}` }),
  };

  async function withServer() {
    const server = await startToolServer(() => [evalTool]);
    closeAfter(() => void server.close());
    const d = createCodexDriver({ command: process.execPath, args: [MOCK], clientVersion: "test", toolServer: async () => server });
    closeAfter(() => d.dispose?.());
    return d;
  }

  it("attaches the tool server, asks in Ask mode, and runs the tool", async () => {
    const d = await withServer();
    const t = turn("browser", { tools: [evalTool] });
    await d.runTurn(t.input);
    expect(t.asked).toEqual(["expression: 1+1"]);
    expect(t.events.slice(1, 3)).toEqual([
      { kind: "tool-use", toolUseId: "t1", name: "browser_eval", summary: '{"expression":"1+1"}' },
      {
        kind: "tool-result",
        toolUseId: "t1",
        isError: false,
        summary: "evaluated 1+1",
        payload: { content: [{ type: "text", text: "evaluated 1+1" }] },
      },
    ]);
  });

  it("doesn't ask outside Ask mode, and reports a declined call", async () => {
    const d = await withServer();
    const auto = turn("browser", { tools: [evalTool], permissionMode: "auto-edit" });
    await d.runTurn(auto.input);
    expect(auto.asked).toEqual([]);
    const denied = turn("browser", { tools: [evalTool], requestPermission: async () => "deny" });
    await d.runTurn(denied.input);
    expect(denied.events[2]).toMatchObject({ kind: "tool-result", isError: true, summary: "user rejected MCP tool call" });
  });

  it("offers the tools from the first turn and never reloads the thread", async () => {
    const d = await withServer();
    const first = turn("browser", { tools: [evalTool], permissionMode: "full" });
    await d.runTurn(first.input);
    expect(first.events.filter((e) => e.kind !== "notice")[2]).toMatchObject({ kind: "tool-result", summary: "evaluated 1+1" });
    const second = turn("browser", { sessionId: first.sessions[0]!, tools: [evalTool], permissionMode: "full" });
    await d.runTurn(second.input);
    // The tool set never changes, so the thread stays loaded: no notice, no unsubscribe.
    expect(second.sessions).toEqual(first.sessions);
    expect(second.events.filter((e) => e.kind === "notice")).toEqual([]);
    expect(second.events.filter((e) => e.kind !== "notice")[2]).toMatchObject({ kind: "tool-result", summary: "evaluated 1+1" });
    const probe = turn("unsubs", { sessionId: first.sessions[0]!, tools: [evalTool], permissionMode: "full" });
    await d.runTurn(probe.input);
    expect(probe.events.find((e) => e.kind === "assistant-text")).toMatchObject({ text: "0" });
  });
});

describe("codexToolConfig", () => {
  it("auto-approves safe tools and prompts for the rest only in Ask mode", () => {
    const safe = { name: "browser_snapshot", autoAllow: true } as HarnessTool;
    const risky = { name: "browser_eval", autoAllow: false } as HarnessTool;
    const server = { url: "http://127.0.0.1:1/mcp", token: "tok" };
    expect(codexToolConfig(server, [safe, risky], "ask")).toEqual({
      mcp_servers: {
        unskilled: {
          url: server.url,
          http_headers: { Authorization: "Bearer tok" },
          default_tools_approval_mode: "approve",
          tools: { browser_eval: { approval_mode: "prompt" } },
        },
      },
    });
    expect((codexToolConfig(server, [safe, risky], "full")!.mcp_servers as Record<string, { tools: object }>).unskilled!.tools).toEqual({});
  });

  it("adds the user's servers, and is empty with nothing to attach", () => {
    expect(codexToolConfig(null, [], "ask")).toBeUndefined();
    expect(
      codexToolConfig(null, [], "ask", [
        { name: "docs", enabled: true, spec: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" } } },
        { name: "remote", enabled: true, spec: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } } },
      ]),
    ).toEqual({
      mcp_servers: {
        docs: { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" } },
        remote: { url: "https://mcp.example.com/mcp", http_headers: { Authorization: "Bearer x" } },
      },
    });
  });
});
