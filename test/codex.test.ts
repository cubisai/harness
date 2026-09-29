import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionDecision, ThreadEvent } from "../src/shared/types";
import { z } from "zod";
import { codexAuthStamp, codexDecision, codexPolicy, codexToolConfig, createCodexDriver, toolFor, turnEndFromUsage } from "../src/main/agents/codex";
import type { LimitsPatch } from "../src/main/agents/limits";
import type { HarnessTool, SeedRequest, TurnInput } from "../src/main/agents/types";
import { Store } from "../src/main/db";
import { injectWithLedger } from "../src/main/handoff";
import { startToolServer } from "../src/main/mcp-http";
import { closeAfter, tempDir } from "./helpers";

const MOCK = join(__dirname, "fixtures", "mock-codex-app-server.mjs");
const GUARD = join(__dirname, "fixtures", "fake-guard.py");

/**
 * A one-off app-server that records the thread/start params the driver sends,
 * so the guide's developerInstructions can be read back. The shared mock can't
 * report it, and editing a fixture is outside this change's file list.
 */
const PROBE_SERVER = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { userAgent: "probe" } });
  if (method === "model/list") return send({ id, result: { data: [] } });
  if (method === "thread/start" || method === "thread/resume") {
    fs.writeFileSync(process.env.GUIDE_PROBE, JSON.stringify({ method, params }));
    return send({ id, result: { thread: { id: "probe-thread" } } });
  }
  if (method === "turn/start") {
    const turn = { id: "turn-1", status: "inProgress", error: null, durationMs: null };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    send({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: "completed", durationMs: 1 } } });
    return;
  }
  send({ id, result: {} });
});
`;

/** Records the turn/start params and reports reasoning efforts on model/list. */
const EFFORT_PROBE = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { userAgent: "probe" } });
  if (method === "model/list") return send({ id, result: { data: [{ id: "gpt-5", displayName: "GPT-5", hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }, { reasoningEffort: "high", description: "High" }],
    defaultReasoningEffort: "high" }] } });
  if (method === "thread/start" || method === "thread/resume") return send({ id, result: { thread: { id: "probe-thread" } } });
  if (method === "turn/start") {
    fs.writeFileSync(process.env.EFFORT_PROBE, JSON.stringify(params));
    const turn = { id: "turn-1", status: "inProgress", error: null, durationMs: null };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    send({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: "completed", durationMs: 1 } } });
    return;
  }
  send({ id, result: {} });
});
`;

/** Records turn/start params, presents a plan item in plan mode, and completes each turn. */
const PLAN_PROBE = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const notify = (method, params) => send({ method, params });
const log = (o) => fs.appendFileSync(process.env.PLAN_PROBE, JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { userAgent: "probe" } });
  if (method === "initialized") return;
  if (method === "model/list") return send({ id, result: { data: [{ id: "gpt-listed", displayName: "Listed", hidden: false }] } });
  if (method === "thread/start" || method === "thread/resume") return send({ id, result: { thread: { id: "probe-thread" }, model: "gpt-thread" } });
  if (method === "turn/start") {
    log({ method, prompt: params.input.map((i) => i.text).join(""), params });
    const turn = { id: "turn-1", status: "inProgress", error: null, durationMs: null };
    send({ id, result: { turn } });
    notify("turn/started", { threadId: params.threadId, turn });
    const planning = params.collaborationMode?.mode === "plan";
    const text = planning ? "# The plan" : "Implemented.";
    if (planning) notify("item/completed", { threadId: params.threadId, turnId: turn.id, item: { type: "plan", id: "p1", text: "# The plan" } });
    notify("item/agentMessage/delta", { threadId: params.threadId, turnId: turn.id, itemId: "m1", delta: text });
    notify("item/completed", { threadId: params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "m1", text } });
    notify("thread/tokenUsage/updated", { threadId: params.threadId, turnId: turn.id, tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 }, modelContextWindow: null } });
    notify("turn/completed", { threadId: params.threadId, turn: { ...turn, status: "completed", durationMs: 1 } });
    return;
  }
  if (method === "turn/interrupt") return send({ id, result: {} });
  send({ id, result: {} });
});
`;

/** Rejects thread/resume and logs every request, for the session-loss path. */
const LOST_PROBE = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const log = (o) => fs.appendFileSync(process.env.LOST_PROBE, JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { userAgent: "probe" } });
  if (method === "model/list") return send({ id, result: { data: [] } });
  if (method === "thread/resume") {
    log({ method, threadId: params.threadId });
    return send({ id, error: { code: -32600, message: "no rollout found for thread id " + params.threadId } });
  }
  if (method === "thread/start") {
    log({ method });
    return send({ id, result: { thread: { id: "new-thread" } } });
  }
  if (method === "thread/inject_items") {
    log({ method, threadId: params.threadId, items: params.items });
    return send({ id, result: {} });
  }
  if (method === "turn/start") {
    log({ method, threadId: params.threadId });
    const turn = { id: "turn-1", status: "inProgress", error: null, durationMs: null };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    send({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: "completed", durationMs: 1 } } });
    return;
  }
  send({ id, result: {} });
});
`;

/** Records spawn/exit order across app-server processes, for the login-change restart. */
const ORDER_PROBE = `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const log = (e) => fs.appendFileSync(process.env.ORDER_PROBE, JSON.stringify(e) + "\\n");
log({ e: "spawn", pid: process.pid });
let logged = false;
const bye = () => {
  if (!logged) {
    logged = true;
    log({ e: "exit", pid: process.pid });
  }
  process.exit(0);
};
process.once("exit", bye);
process.once("SIGTERM", bye);
process.once("SIGINT", bye);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === "initialize") return send({ id, result: { userAgent: "probe" } });
  if (method === "model/list") return send({ id, result: { data: [] } });
  if (method === "thread/start" || method === "thread/resume") return send({ id, result: { thread: { id: "probe-thread" } } });
  if (method === "turn/start") {
    const turn = { id: "turn-1", status: "inProgress", error: null, durationMs: null };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn } });
    send({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: "completed", durationMs: 1 } } });
    return;
  }
  send({ id, result: {} });
});
`;

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
    requestPlanDecision: async () => ({ keep: "" }),
    ...over,
  };
  return { input, events, deltas, sessions, asked, controller };
}

describe("Codex login changes", () => {
  it("starts a fresh app-server when the login changed, and keeps the running one otherwise", async () => {
    const home = tempDir();
    const auth = join(home, "auth.json");
    writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct-1", access_token: "a" } }));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const d = driver();
      const first = turn("hi");
      await d.runTurn(first.input);
      const same = turn("hi");
      await d.runTurn(same.input);
      // Same process: the mock numbers threads on, so the second is thread-2.
      expect([first.sessions[0], same.sessions[0]]).toEqual(["thread-1", "thread-2"]);
      // A token refresh rewrote the file, but the login is the same: the running app-server stays.
      writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct-1", access_token: "b" }, last_refresh: "2026-01-01T00:00:00Z" }));
      const refreshed = turn("hi");
      await d.runTurn(refreshed.input);
      expect(refreshed.sessions[0]).toBe("thread-3");
      // A different account is a new login: a fresh process starts numbering again.
      writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct-2", access_token: "c" } }));
      const after = turn("hi");
      await d.runTurn(after.input);
      expect(after.sessions[0]).toBe("thread-1");
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  }, 30_000);

  it("waits for the replaced app-server to exit before spawning its successor", async () => {
    const probe = join(tempDir(), "order.jsonl");
    const home = tempDir();
    const auth = join(home, "auth.json");
    writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct-1", access_token: "a" } }));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    process.env.ORDER_PROBE = probe;
    try {
      const d = createCodexDriver({ command: process.execPath, args: ["-e", ORDER_PROBE], clientVersion: "test" });
      closeAfter(() => d.dispose?.());
      await d.runTurn(turn("one").input);
      writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct-2", access_token: "b" } }));
      await d.runTurn(turn("two").input);
      const entries = readFileSync(probe, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { e: string; pid: number });
      const spawns = entries.filter((x) => x.e === "spawn").map((x) => x.pid);
      expect(spawns).toHaveLength(2);
      const exitIndex = entries.findIndex((x) => x.e === "exit" && x.pid === spawns[0]);
      const successorIndex = entries.findIndex((x) => x.e === "spawn" && x.pid === spawns[1]);
      expect(exitIndex).toBeGreaterThanOrEqual(0);
      expect(exitIndex).toBeLessThan(successorIndex);
    } finally {
      delete process.env.ORDER_PROBE;
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  }, 30_000);

  it("stamps the login's identity, not the file time", () => {
    const home = tempDir();
    const auth = join(home, "auth.json");
    const env = { CODEX_HOME: home };
    const write = (body: object) => writeFileSync(auth, JSON.stringify(body));
    write({ auth_mode: "chatgpt", tokens: { account_id: "acct-1", access_token: "a" }, last_refresh: "2026-01-01T00:00:00Z" });
    const first = codexAuthStamp(env);
    write({ auth_mode: "chatgpt", tokens: { account_id: "acct-1", access_token: "b" }, last_refresh: "2026-02-02T00:00:00Z" });
    expect(codexAuthStamp(env)).toBe(first);
    write({ auth_mode: "apikey", OPENAI_API_KEY: "sk-secret", tokens: { account_id: "acct-2", access_token: "c" } });
    expect(codexAuthStamp(env)).not.toBe(first);
    expect(codexAuthStamp({ CODEX_HOME: tempDir() })).toBeNull();
  });
});

describe("Codex driver", () => {
  it("runs a turn: reasoning, streamed reply, usage", async () => {
    const d = driver();
    const t = turn("there");
    await d.runTurn(t.input);
    expect(t.sessions).toEqual(["thread-1"]);
    expect(t.deltas.join("")).toBe("Hi, there");
    expect(t.events.map((e) => e.kind)).toEqual(["turn-start", "thinking", "assistant-text", "context-breakdown", "turn-end"]);
    expect(t.events.at(-1)).toMatchObject({ inputTokens: 900, outputTokens: 12, durationMs: 42 });
    expect(d.models().map((m) => m.id)).toEqual(["default", "gpt-mock"]);
  });

  it("loads models at startup without a turn", async () => {
    const d = driver();
    expect(d.models().map((m) => m.id)).toEqual(["default"]);
    await d.refreshModels!();
    expect(d.models().map((m) => m.id)).toEqual(["default", "gpt-mock"]);
  });

  it("maps reasoning efforts and sends effort plus an auto summary on turn/start", async () => {
    const probe = join(tempDir(), "effort.json");
    process.env.EFFORT_PROBE = probe;
    const d = createCodexDriver({ command: process.execPath, args: ["-e", EFFORT_PROBE], clientVersion: "test" });
    closeAfter(() => d.dispose?.());
    try {
      await d.refreshModels!();
      expect(d.models().find((m) => m.id === "gpt-5")).toMatchObject({ efforts: ["low", "high"], defaultEffort: "high" });
      await d.runTurn(turn("hi", { model: "gpt-5", effort: "high" }).input);
      const sent = JSON.parse(readFileSync(probe, "utf8")) as { effort?: string; summary?: string };
      expect(sent.effort).toBe("high");
      expect(sent.summary).toBe("auto");
    } finally {
      delete process.env.EFFORT_PROBE;
    }
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

  it("sends the harness guide as developer instructions on thread/start", async () => {
    const probe = join(tempDir(), "thread-start.json");
    process.env.GUIDE_PROBE = probe;
    const d = createCodexDriver({ command: process.execPath, args: ["-e", PROBE_SERVER], clientVersion: "test", guide: () => "GUIDE" });
    closeAfter(() => d.dispose?.());
    try {
      await d.runTurn(turn("hi").input);
    } finally {
      delete process.env.GUIDE_PROBE;
    }
    const sent = JSON.parse(readFileSync(probe, "utf8")) as { method: string; params: { developerInstructions?: string } };
    expect(sent.method).toBe("thread/start");
    expect(sent.params.developerInstructions).toBe("GUIDE");
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

describe("Codex plan mode", () => {
  function planDriver() {
    const d = createCodexDriver({ command: process.execPath, args: ["-e", PLAN_PROBE], clientVersion: "test" });
    closeAfter(() => d.dispose?.());
    return d;
  }

  it("runs a native plan turn, then implements on auto with the thread's own model", async () => {
    const probe = join(tempDir(), "plan.jsonl");
    process.env.PLAN_PROBE = probe;
    try {
      const plans: string[] = [];
      const t = turn("make a plan", {
        permissionMode: "plan",
        requestPlanDecision: async (p) => {
          plans.push(p.plan);
          return "auto";
        },
      });
      await planDriver().runTurn(t.input);
      expect(plans).toEqual(["# The plan"]);
      const starts = readFileSync(probe, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; prompt: string; params: Record<string, unknown> });
      expect(starts).toHaveLength(2);
      // The collaboration mode names the model the thread actually runs, not the default alias.
      expect(starts[0]!.params.collaborationMode).toEqual({
        mode: "plan",
        settings: { model: "gpt-thread", reasoning_effort: null, developer_instructions: null },
      });
      expect(starts[0]!.params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
      // The implementing round leaves plan mode and widens the read-only thread back to writes.
      expect(starts[1]!.params.collaborationMode).toEqual({
        mode: "default",
        settings: { model: "gpt-thread", reasoning_effort: null, developer_instructions: null },
      });
      expect(starts[1]!.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
      expect(starts[1]!.prompt).toBe("Implement the plan.");
      // The plan item is a proposal, not assistant prose; the final turn-end lands once.
      expect(t.events.filter((e) => e.kind === "assistant-text").map((e) => (e as { text: string }).text)).toEqual(["# The plan", "Implemented."]);
      expect(t.events.filter((e) => e.kind === "turn-end")).toHaveLength(1);
    } finally {
      delete process.env.PLAN_PROBE;
    }
  });

  it("sends kept feedback as another native plan turn", async () => {
    const probe = join(tempDir(), "plan.jsonl");
    process.env.PLAN_PROBE = probe;
    try {
      let n = 0;
      const t = turn("make a plan", {
        permissionMode: "plan",
        requestPlanDecision: async () => {
          n++;
          return n === 1 ? { keep: "Add tests" } : "auto";
        },
      });
      await planDriver().runTurn(t.input);
      const starts = readFileSync(probe, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; prompt: string; params: { collaborationMode?: { mode: string } } });
      expect(starts.map((s) => s.prompt)).toEqual(["make a plan", "Add tests", "Implement the plan."]);
      // A keep stays in plan mode; only the accepted round leaves it.
      expect(starts[1]!.params.collaborationMode?.mode).toBe("plan");
      expect(starts[2]!.params.collaborationMode?.mode).toBe("default");
    } finally {
      delete process.env.PLAN_PROBE;
    }
  });
});

describe("Codex session loss", () => {
  function lostDriver() {
    const d = createCodexDriver({ command: process.execPath, args: ["-e", LOST_PROBE], clientVersion: "test" });
    closeAfter(() => d.dispose?.());
    return d;
  }

  it("calls onSessionLost, starts a new thread, and injects the seed before the turn", async () => {
    const probe = join(tempDir(), "lost.jsonl");
    process.env.LOST_PROBE = probe;
    try {
      const reasons: string[] = [];
      const t = turn("hi", {
        sessionId: "gone",
        onSessionLost: async (reason) => {
          reasons.push(reason);
          return { inject: (_sessionId, send) => send([{ type: "message", role: "user", content: "handoff" }]) };
        },
      });
      await lostDriver().runTurn(t.input);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/no rollout found/);
      expect(t.sessions).toEqual(["new-thread"]);
      const calls = readFileSync(probe, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; threadId?: string; items?: unknown[] });
      const methods = calls.map((c) => c.method);
      expect(methods).toContain("thread/start");
      expect(calls.find((c) => c.method === "thread/inject_items")).toMatchObject({
        threadId: "new-thread",
        items: [{ type: "message", role: "user", content: "handoff" }],
      });
      expect(methods.indexOf("thread/inject_items")).toBeLessThan(methods.indexOf("turn/start"));
    } finally {
      delete process.env.LOST_PROBE;
    }
  }, 30_000);

  it("notices with the agent's reason when onSessionLost is absent", async () => {
    const probe = join(tempDir(), "lost.jsonl");
    process.env.LOST_PROBE = probe;
    try {
      const t = turn("hi", { sessionId: "gone" });
      await lostDriver().runTurn(t.input);
      const notice = t.events.find((e) => e.kind === "notice") as { text: string } | undefined;
      expect(notice?.text).toMatch(/no rollout found/);
      expect(t.sessions).toEqual(["new-thread"]);
    } finally {
      delete process.env.LOST_PROBE;
    }
  }, 30_000);
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

  it("puts the raw context input and the window on the usage", () => {
    const e = turnEndFromUsage(
      { inputTokens: 9000, cachedInputTokens: 8000, outputTokens: 12, netNewInputTokens: 750, cacheWriteInputTokens: 100, reasoningOutputTokens: 3 },
      42,
      1000000,
    );
    expect(e).toMatchObject({ kind: "turn-end", inputTokens: 750 });
    if (e.kind !== "turn-end") return;
    // contextUsed is the RAW input (cached included), not the net-new 750.
    expect(e.usage).toMatchObject({ contextUsed: 9000, contextSize: 1000000 });
  });

  it("reports unavailable usage when none was seen", () => {
    const e = turnEndFromUsage(undefined, 7);
    expect(e).toMatchObject({ kind: "turn-end", inputTokens: 0, outputTokens: 0, durationMs: 7 });
    if (e.kind !== "turn-end") return;
    expect(e.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, provenance: "unavailable", contextUsed: null, contextSize: null });
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
      { kind: "tool-use", toolUseId: "t1", name: "browser_eval", summary: '{"expression":"1+1"}', payload: { expression: "1+1" } },
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

describe("toolFor payloads", () => {
  it("carries an MCP call's arguments and a web search's query", () => {
    expect(toolFor({ type: "mcpToolCall", id: "m1", server: "cubiq", tool: "browser_eval", status: "inProgress", arguments: { expression: "1+1" } })).toMatchObject({
      payload: { expression: "1+1" },
    });
    expect(toolFor({ type: "mcpToolCall", id: "m2", server: "docs", tool: "whoami", status: "inProgress", arguments: {} })).not.toHaveProperty("payload");
    expect(toolFor({ type: "webSearch", id: "w1", query: "cats" })).toMatchObject({ name: "Search", payload: { query: "cats" } });
    expect(toolFor({ type: "webSearch", id: "w2" })).not.toHaveProperty("payload");
  });
});

describe("codexToolConfig", () => {
  it("auto-approves safe tools and prompts for the rest only in Ask mode", () => {
    const safe = { name: "browser_snapshot", autoAllow: true } as HarnessTool;
    const risky = { name: "browser_eval", autoAllow: false } as HarnessTool;
    const server = { url: "http://127.0.0.1:1/mcp", token: "tok" };
    expect(codexToolConfig(server, [safe, risky], "ask")).toEqual({
      mcp_servers: {
        cubiq: {
          url: server.url,
          http_headers: { Authorization: "Bearer tok" },
          default_tools_approval_mode: "approve",
          tools: { browser_eval: { approval_mode: "prompt" } },
        },
      },
    });
    expect((codexToolConfig(server, [safe, risky], "full")!.mcp_servers as Record<string, { tools: object }>).cubiq!.tools).toEqual({});
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
