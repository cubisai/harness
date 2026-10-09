import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PermissionMode, Provider, ThreadEvent } from "../src/shared/types";
import type { HarnessTool, TurnInput } from "../src/main/agents/types";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver, providerAgentId, type ProviderDriverDeps } from "../src/main/harness/driver";
import { ProviderAgents } from "../src/main/harness/register";
import { SessionStore, repairHistory } from "../src/main/harness/session";
import { PRUNED_MARKER } from "../src/main/harness/context/prune";
import type { Route } from "../src/main/harness/llm/client";
import { LlmError, emptyUsage, type AssistantPart, type LlmEvent, type LlmMessage, type LlmRequest } from "../src/main/harness/llm/types";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "harness-driver-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: "th",
  label: "TokenHarbor",
  wireProtocol: "openai-chat",
  baseURL: "https://tokenharbor.ai/v1",
  secret: { kind: "safeStorage", ciphertext: "x" },
  models: [{ id: "deepseek-v4", name: "DeepSeek V4", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 128_000, maxOutput: 8_000, cost: { input: 1, output: 2 } }],
  ...over,
});

const SUMMARY_ANSWER = "## Objective\nx";

function scripted(...answers: AssistantPart[][]) {
  const requests: LlmRequest[] = [];
  let n = 0;
  const stream = async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
    requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
    // A request with no tools is the compaction summariser.
    if (req.tools.length === 0) {
      yield { type: "finish", reason: "stop", message: [{ type: "text", text: SUMMARY_ANSWER }], usage: { ...emptyUsage(), inputTokens: 50, outputTokens: 10 } };
      return;
    }
    const message = answers[Math.min(n++, answers.length - 1)]!;
    yield { type: "finish", reason: message.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", message, usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 100 } };
  };
  return { stream, requests };
}

/** A session with two user turns and big tool results, long enough to compact. */
function seedSession(sessions: SessionStore, size = 40_000): string {
  const id = sessions.create();
  const big = "x".repeat(size);
  sessions.append(id, { role: "user", content: [{ type: "text", text: "start" }] });
  sessions.append(id, { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "a" } }] });
  sessions.append(id, { role: "tool", results: [{ callId: "c1", name: "read", text: big }] });
  sessions.append(id, { role: "user", content: [{ type: "text", text: "more" }] });
  sessions.append(id, { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "read", input: { path: "b" } }] });
  sessions.append(id, { role: "tool", results: [{ callId: "c2", name: "read", text: big }] });
  return id;
}

function setup(
  answers: AssistantPart[][],
  opts: { mode?: PermissionMode; decision?: "allow-once" | "deny"; tools?: HarnessTool[]; saved?: Provider | undefined; skills?: (cwd: string, design: boolean) => HarnessTool | null; stream?: ProviderDriverDeps["stream"] } = {},
) {
  const cwd = tmp();
  const data = tmp();
  const s = scripted(...answers);
  const sessions = new SessionStore(join(data, "sessions"));
  const saved = "saved" in opts ? opts.saved : provider();
  const driver = createProviderDriver("th", {
    provider: () => saved,
    secret: () => "sk-test",
    secretHeaders: () => ({}),
    sessions,
    outputDir: join(data, "out"),
    guardScript: BUILT_IN_GUARD,
    guide: () => "GUIDE TEXT",
    memory: () => "MEMORY TEXT",
    mcpTools: () => [],
    ...(opts.skills ? { skills: opts.skills } : {}),
    stream: opts.stream ?? s.stream,
  });
  const events: ThreadEvent[] = [];
  const asked: string[] = [];
  let session: string | null = null;
  const input = (prompt: string, sessionId: string | null = null): TurnInput => ({
    threadId: "t1",
    cwd,
    projectId: "p1",
    prompt,
    sessionId,
    model: "deepseek-v4",
    effort: "high",
    permissionMode: opts.mode ?? "full",
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    onTextDelta: () => {},
    onSession: (id) => (session = id),
    requestPermission: async (r) => (asked.push(`${r.toolName}: ${r.summary}`), opts.decision ?? "allow-once"),
    requestPlanDecision: async () => "manual",
    tools: opts.tools ?? [],
    mcpServers: [],
  });
  return { driver, events, asked, input, cwd, sessions, requests: s.requests, session: () => session };
}

describe("provider driver", () => {
  it("is its own agent with the provider's models", () => {
    const { driver } = setup([]);
    expect(driver.id).toBe("provider-th");
    expect(driver.label).toBe("TokenHarbor");
    expect(driver.models()).toEqual([{ id: "deepseek-v4", label: "DeepSeek V4", contextWindow: 128_000, efforts: ["low", "medium", "high"], cost: { input: 1, output: 2 } }]);
    expect(driver.defaultModel).toBe("deepseek-v4");
    expect(driver.credentials?.byok).toBe(false);
    expect(driver.capabilities.manualCompact).toBe(true);
    expect(driver.skillsDelivery).toEqual({ mode: "tool", prefix: "", reads: [] });
  });

  it("runs a turn that writes a file, and persists the session for the next turn", async () => {
    const t = setup([[{ type: "tool-call", id: "c1", name: "write", input: { path: "hello.txt", content: "hi\n" } }], [{ type: "text", text: "Created hello.txt." }], [{ type: "text", text: "Still here." }]]);
    await t.driver.runTurn(t.input("make hello.txt"));
    expect(readFileSync(join(t.cwd, "hello.txt"), "utf8")).toBe("hi\n");
    expect(t.events.map((e) => e.kind)).toEqual(["turn-start", "context-breakdown", "tool-use", "tool-result", "assistant-text", "turn-end"]);
    expect(t.events[2]).toMatchObject({ name: "Write", summary: "hello.txt" });
    expect(t.events[3]).toMatchObject({ isError: false, payload: { diff: [{ path: "hello.txt" }] } });
    const end = t.events.at(-1) as Extract<ThreadEvent, { kind: "turn-end" }>;
    expect(end).toMatchObject({ inputTokens: 2000, outputTokens: 200, costUsd: (2000 * 1 + 200 * 2) / 1e6, usage: { contextUsed: 1000, contextSize: 128_000 } });

    const first = t.requests[0]!;
    expect(first.model).toBe("deepseek-v4");
    expect(first.effort).toBe("high");
    expect(first.system.join("\n")).toContain("GUIDE TEXT");
    expect(first.system.join("\n")).toContain("MEMORY TEXT");
    expect(first.tools.map((x) => x.name)).toEqual(["read", "edit", "write", "bash", "glob", "grep", "todowrite"]);
    expect(first.cacheKey).toBe(t.session());

    // Next turn resumes the stored history.
    const sid = t.session()!;
    t.events.length = 0;
    await t.driver.runTurn(t.input("and now?", sid));
    const third = t.requests[2]!;
    expect(third.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(t.sessions.load(sid)).toHaveLength(6);
  });

  it("remembers a read from an earlier turn of the same session", async () => {
    const t = setup([
      [{ type: "tool-call", id: "c1", name: "read", input: { path: "a.txt" } }],
      [{ type: "text", text: "read it" }],
      [{ type: "tool-call", id: "c2", name: "edit", input: { path: "a.txt", old_string: "one", new_string: "uno" } }],
      [{ type: "text", text: "edited" }],
    ]);
    writeFileSync(join(t.cwd, "a.txt"), "one\n");
    await t.driver.runTurn(t.input("read a.txt"));
    await t.driver.runTurn(t.input("now edit it", t.session()));
    expect(readFileSync(join(t.cwd, "a.txt"), "utf8")).toBe("uno\n");
  });

  it("asks before an edit in ask mode and reports a denial to the model", async () => {
    const t = setup([[{ type: "tool-call", id: "c1", name: "write", input: { path: "x.txt", content: "x" } }], [{ type: "text", text: "ok" }]], { mode: "ask", decision: "deny" });
    await t.driver.runTurn(t.input("write x"));
    expect(t.asked).toEqual(["Write: x.txt"]);
    expect(t.events.find((e) => e.kind === "tool-result")).toMatchObject({ isError: true });
    expect(t.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", results: [{ isError: true, text: expect.stringContaining("denied") }] });
  });

  it("refuses edits in plan mode without asking", async () => {
    const t = setup([[{ type: "tool-call", id: "c1", name: "bash", input: { command: "touch y" } }], [{ type: "text", text: "planned" }]], { mode: "plan" });
    await t.driver.runTurn(t.input("do it"));
    expect(t.asked).toEqual([]);
    expect(t.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", results: [{ isError: true, text: expect.stringContaining("Plan mode") }] });
  });

  it("offers the app's tools with JSON schemas and validates their arguments", async () => {
    const ran: unknown[] = [];
    const browser: HarnessTool = { name: "browser_open", description: "Open a URL", input: { url: z.string() }, autoAllow: true, run: async (a) => (ran.push(a), { text: "opened" }) };
    const t = setup([[{ type: "tool-call", id: "c1", name: "browser_open", input: { url: 5 } }, { type: "tool-call", id: "c2", name: "browser_open", input: { url: "https://x.dev" } }], [{ type: "text", text: "ok" }]], { tools: [browser] });
    await t.driver.runTurn(t.input("open"));
    expect(t.requests[0]!.tools.find((x) => x.name === "browser_open")!.parameters).toMatchObject({ type: "object", properties: { url: { type: "string" } }, required: ["url"] });
    expect(ran).toEqual([{ url: "https://x.dev" }]);
    expect(t.requests[1]!.messages.at(-1)).toMatchObject({ results: [{ isError: true }, { text: "opened" }] });
  });

  it("turns TodoWrite into the thread's plan", async () => {
    const t = setup([[{ type: "tool-call", id: "c1", name: "todowrite", input: { todos: [{ content: "Read code", status: "in_progress" }] } }], [{ type: "text", text: "ok" }]]);
    await t.driver.runTurn(t.input("plan"));
    expect(t.events.find((e) => e.kind === "plan")).toEqual({ kind: "plan", entries: [{ content: "Read code", status: "in_progress" }] });
  });

  it("reports a removed provider and a lost session", async () => {
    const gone = setup([], { saved: undefined });
    await gone.driver.runTurn(gone.input("hi"));
    expect(gone.events.map((e) => e.kind)).toEqual(["turn-start", "error", "turn-end"]);

    const lost = setup([[{ type: "text", text: "fresh" }]]);
    let reason = "";
    const input = { ...lost.input("hi", "0000aaaa-dead-beef-0000-000000000000"), onSessionLost: async (r: string) => ((reason = r), { promptPrefix: "HANDOFF" }) };
    await lost.driver.runTurn(input);
    expect(reason).toMatch(/gone/);
    expect(lost.requests[0]!.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "HANDOFF\n\nhi" }] });
  });

  it("gives GPT models apply_patch instead of edit", async () => {
    const t = setup([[{ type: "text", text: "ok" }]], { saved: provider({ models: [{ id: "gpt-5.5", capabilities: { tools: true, vision: true, reasoning: true }, contextWindow: 400_000, maxOutput: 128_000 }] }) });
    await t.driver.runTurn({ ...t.input("hi"), model: "gpt-5.5" });
    expect(t.requests[0]!.tools.map((x) => x.name)).toContain("apply_patch");
    expect(t.requests[0]!.tools.map((x) => x.name)).not.toContain("edit");
  });

  it("auto-compacts a long session before the call", async () => {
    const t = setup([[{ type: "text", text: "done" }]], {
      saved: provider({ models: [{ id: "deepseek-v4", name: "DeepSeek V4", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 20_000, maxOutput: 8_000, cost: { input: 1, output: 2 } }] }),
    });
    const sid = seedSession(t.sessions);
    await t.driver.runTurn(t.input("and now?", sid));
    expect(t.events.find((e) => e.kind === "compaction")).toMatchObject({ trigger: "auto" });
    const first = t.sessions.load(sid)![0]!;
    const firstText = first.role === "user" ? first.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
    expect(firstText.startsWith("<conversation-summary>")).toBe(true);
    expect(t.events.at(-1)).toMatchObject({ kind: "turn-end" });
  });

  it("prunes old tool output under a large reported context instead of compacting", async () => {
    const requests: LlmRequest[] = [];
    let n = 0;
    const stream = (async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
      requests.push(req);
      if (req.tools.length === 0) {
        yield { type: "finish", reason: "stop", message: [{ type: "text", text: SUMMARY_ANSWER }], usage: { ...emptyUsage(), inputTokens: 50, outputTokens: 10 } };
        return;
      }
      n++;
      const message: AssistantPart[] = n === 1 ? [{ type: "tool-call", id: "c9", name: "read", input: { path: "x" } }] : [{ type: "text", text: "done" }];
      yield { type: "finish", reason: n === 1 ? "tool-calls" : "stop", message, usage: { ...emptyUsage(), inputTokens: n === 1 ? 400_000 : 500, outputTokens: 100 } };
    }) as ProviderDriverDeps["stream"];
    const t = setup([], { stream });
    const sid = seedSession(t.sessions, 160_000);
    await t.driver.runTurn(t.input("hi", sid));
    // The old result is cleared and, because the estimate now fits, no summary call is made.
    expect(requests.filter((r) => r.tools.length === 0)).toHaveLength(0);
    expect(t.events.some((e) => e.kind === "compaction")).toBe(false);
    expect(t.sessions.load(sid)![2]).toMatchObject({ role: "tool", results: [{ text: PRUNED_MARKER }] });
  });

  it("auto-compacts at most once when the kept tail alone still exceeds the limit", async () => {
    const requests: LlmRequest[] = [];
    let n = 0;
    const stream = (async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
      requests.push(req);
      if (req.tools.length === 0) {
        yield { type: "finish", reason: "stop", message: [{ type: "text", text: SUMMARY_ANSWER }], usage: { ...emptyUsage(), inputTokens: 50, outputTokens: 10 } };
        return;
      }
      n++;
      const message: AssistantPart[] = n <= 2 ? [{ type: "tool-call", id: `c${n}`, name: "read", input: { path: "x" } }] : [{ type: "text", text: "done" }];
      yield { type: "finish", reason: n <= 2 ? "tool-calls" : "stop", message, usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 100 } };
    }) as ProviderDriverDeps["stream"];
    const t = setup([], {
      stream,
      saved: provider({ models: [{ id: "deepseek-v4", name: "DeepSeek V4", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 20_000, maxOutput: 8_000, cost: { input: 1, output: 2 } }] }),
    });
    // The huge result sits between two user boundaries, so it stays in the kept
    // tail: after one summary the history is still over the cap.
    const sid = t.sessions.create();
    const huge = "x".repeat(80_000);
    const load = (m: LlmMessage) => t.sessions.append(sid, m);
    load({ role: "user", content: [{ type: "text", text: "start" }] });
    load({ role: "assistant", content: [{ type: "tool-call", id: "s1", name: "read", input: { path: "a" } }] });
    load({ role: "tool", results: [{ callId: "s1", name: "read", text: "small" }] });
    load({ role: "user", content: [{ type: "text", text: "more" }] });
    load({ role: "assistant", content: [{ type: "tool-call", id: "s2", name: "read", input: { path: "b" } }] });
    load({ role: "tool", results: [{ callId: "s2", name: "read", text: huge }] });
    load({ role: "user", content: [{ type: "text", text: "final" }] });
    load({ role: "assistant", content: [{ type: "tool-call", id: "s3", name: "read", input: { path: "c" } }] });
    load({ role: "tool", results: [{ callId: "s3", name: "read", text: "small" }] });
    await t.driver.runTurn(t.input("go", sid));
    expect(requests.filter((r) => r.tools.length === 0)).toHaveLength(1);
    expect(t.events.filter((e) => e.kind === "compaction")).toHaveLength(1);
  });

  it("compacts on /compact with a focus and runs no loop", async () => {
    const t = setup([[{ type: "text", text: "should not run" }]]);
    const sid = seedSession(t.sessions);
    await t.driver.runTurn({ ...t.input("", sid), compact: { focus: "the auth flow" } });
    expect(t.events.find((e) => e.kind === "compaction")).toMatchObject({ trigger: "manual" });
    expect(t.events.at(-1)).toMatchObject({ kind: "turn-end" });
    const summaryReq = t.requests.find((r) => r.tools.length === 0)!;
    expect(summaryReq.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("the auth flow") }] });
    expect(t.requests.every((r) => r.tools.length === 0)).toBe(true);
  });

  it("says nothing to compact for an unknown session", async () => {
    const t = setup([]);
    await t.driver.runTurn({ ...t.input("", "00000000-0000-0000-0000-000000000000"), compact: { focus: null } });
    expect(t.events.map((e) => e.kind)).toEqual(["turn-start", "notice", "turn-end"]);
    expect(t.events[1]).toMatchObject({ text: "Nothing to compact yet." });
  });

  it("compacts once and retries when the first call overflows", async () => {
    let n = 0;
    const stream = (async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
      if (req.tools.length === 0) {
        yield { type: "finish", reason: "stop", message: [{ type: "text", text: SUMMARY_ANSWER }], usage: { ...emptyUsage(), inputTokens: 50, outputTokens: 10 } };
        return;
      }
      n++;
      if (n === 1) throw new LlmError("too long", "overflow", 400);
      yield { type: "finish", reason: "stop", message: [{ type: "text", text: "done" }], usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 100 } };
    }) as ProviderDriverDeps["stream"];
    const t = setup([], { stream });
    const sid = seedSession(t.sessions);
    await t.driver.runTurn(t.input("hi", sid));
    expect(t.events.filter((e) => e.kind === "compaction")).toHaveLength(1);
    expect(t.events.some((e) => e.kind === "assistant-text")).toBe(true);
    expect(t.events.at(-1)).toMatchObject({ kind: "turn-end" });
  });

  it("emits the context breakdown on the first turn only", async () => {
    const t = setup([[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]]);
    await t.driver.runTurn(t.input("hi"));
    expect(t.events.some((e) => e.kind === "context-breakdown")).toBe(true);
    const sid = t.session()!;
    t.events.length = 0;
    await t.driver.runTurn(t.input("again", sid));
    expect(t.events.some((e) => e.kind === "context-breakdown")).toBe(false);
  });

  it("appends the skills tool to the request", async () => {
    const skill: HarnessTool = { name: "skill", description: "Load a skill", input: { name: z.string() }, autoAllow: true, run: async () => ({ text: "<skill/>" }) };
    const t = setup([[{ type: "text", text: "ok" }]], { skills: () => skill });
    await t.driver.runTurn(t.input("hi"));
    expect(t.requests[0]!.tools.map((x) => x.name)).toContain("skill");
  });

  it("folds AGENTS.md into the system prompt", async () => {
    const t = setup([[{ type: "text", text: "ok" }]]);
    writeFileSync(join(t.cwd, "AGENTS.md"), "PROJECT RULES\n");
    await t.driver.runTurn(t.input("hi"));
    expect(t.requests[0]!.system.join("\n")).toContain("Project instructions from AGENTS.md:\n\nPROJECT RULES");
  });
});

describe("ProviderAgents", () => {
  it("keeps one driver per runnable provider, made and dropped as the list changes", () => {
    let saved: Provider[] = [provider(), provider({ id: "gem", wireProtocol: "gemini" }), provider({ id: "empty", models: [] })];
    const agents = new ProviderAgents({ providers: () => saved, secret: () => null, secretHeaders: () => ({}), sessions: new SessionStore(tmp()), outputDir: tmp(), guardScript: BUILT_IN_GUARD, guide: () => null, memory: () => null, mcpTools: () => [] });
    const first = agents.list();
    expect(first.map((d) => d.id)).toEqual([providerAgentId("th")]);
    saved = [...saved, provider({ id: "pgs", label: "PGS Grove" })];
    const second = agents.list();
    expect(second.map((d) => d.id)).toEqual(["provider-th", "provider-pgs"]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]!.label).toBe("PGS Grove");
    saved = saved.filter((p) => p.id !== "th");
    expect(agents.list().map((d) => d.id)).toEqual(["provider-pgs"]);
  });
});

describe("SessionStore", () => {
  it("appends, loads, survives a torn line and replaces atomically", () => {
    const store = new SessionStore(tmp());
    const id = store.create();
    store.append(id, { role: "user", content: [{ type: "text", text: "a" }] });
    store.append(id, { role: "assistant", content: [{ type: "tool-call", id: "c", name: "read", input: {} }] });
    expect(store.load(id)).toHaveLength(2);
    expect(repairHistory(store.load(id)!)).toHaveLength(1);
    const file = join((store as unknown as { dir: string }).dir, `${id}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8") + '{"role":"us');
    expect(store.load(id)).toHaveLength(2);
    store.replace(id, [{ role: "user", content: [{ type: "text", text: "summary" }] }]);
    expect(store.load(id)).toHaveLength(1);
    expect(store.load("../etc/passwd")).toBeNull();
    expect(store.load("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
