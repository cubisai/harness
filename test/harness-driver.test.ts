import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PermissionMode, Provider, ThreadEvent } from "../src/shared/types";
import type { HarnessTool, TurnInput } from "../src/main/agents/types";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver, providerAgentId } from "../src/main/harness/driver";
import { ProviderAgents } from "../src/main/harness/register";
import { SessionStore, repairHistory } from "../src/main/harness/session";
import type { Route } from "../src/main/harness/llm/client";
import { emptyUsage, type AssistantPart, type LlmEvent, type LlmRequest } from "../src/main/harness/llm/types";

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

function scripted(...answers: AssistantPart[][]) {
  const requests: LlmRequest[] = [];
  const stream = async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
    requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
    const message = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    yield { type: "finish", reason: message.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", message, usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 100 } };
  };
  return { stream, requests };
}

function setup(answers: AssistantPart[][], opts: { mode?: PermissionMode; decision?: "allow-once" | "deny"; tools?: HarnessTool[]; saved?: Provider | undefined } = {}) {
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
    stream: s.stream,
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
  });

  it("runs a turn that writes a file, and persists the session for the next turn", async () => {
    const t = setup([[{ type: "tool-call", id: "c1", name: "write", input: { path: "hello.txt", content: "hi\n" } }], [{ type: "text", text: "Created hello.txt." }], [{ type: "text", text: "Still here." }]]);
    await t.driver.runTurn(t.input("make hello.txt"));
    expect(readFileSync(join(t.cwd, "hello.txt"), "utf8")).toBe("hi\n");
    expect(t.events.map((e) => e.kind)).toEqual(["turn-start", "tool-use", "tool-result", "assistant-text", "turn-end"]);
    expect(t.events[1]).toMatchObject({ name: "Write", summary: "hello.txt" });
    expect(t.events[2]).toMatchObject({ isError: false, payload: { diff: [{ path: "hello.txt" }] } });
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
