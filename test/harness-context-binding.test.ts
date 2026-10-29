import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider, ThreadEvent } from "../src/shared/types";
import type { TurnInput } from "../src/main/agents/types";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { createProviderDriver } from "../src/main/harness/driver";
import { prefixKey, unbindThinking } from "../src/main/harness/context/binding";
import { compactedHistory } from "../src/main/harness/context/compact";
import { PRUNED_MARKER, pruneToolOutputs } from "../src/main/harness/context/prune";
import { SessionStore } from "../src/main/harness/session";
import type { Route } from "../src/main/harness/llm/client";
import { emptyUsage, type AssistantPart, type LlmEvent, type LlmMessage, type LlmRequest, type ReasoningPart } from "../src/main/harness/llm/types";

const signed = (text: string): ReasoningPart => ({ type: "reasoning", text, replay: { protocol: "anthropic-messages", data: { type: "thinking", thinking: text, signature: `sig-${text}` } } });
const responsesItem = (text: string): ReasoningPart => ({ type: "reasoning", text, replay: { protocol: "openai-responses", data: { type: "reasoning", encrypted_content: "enc" } } });
const user = (text: string): LlmMessage => ({ role: "user", content: [{ type: "text", text }] });
const step = (thinking: ReasoningPart, id: string): LlmMessage => ({ role: "assistant", content: [thinking, { type: "tool-call", id, name: "read", input: { path: id } }] });
const result = (id: string, text: string): LlmMessage => ({ role: "tool", results: [{ callId: id, name: "read", text }] });

/** Every Anthropic signature still in the history, in order. */
const signatures = (ms: LlmMessage[]): string[] =>
  ms.flatMap((m) => (m.role === "assistant" ? m.content.flatMap((p) => (p.type === "reasoning" && p.replay?.protocol === "anthropic-messages" ? [String(p.replay.data.signature)] : [])) : []));

describe("unbindThinking", () => {
  const history: LlmMessage[] = [user("go"), step(signed("a"), "c1"), result("c1", "one"), step(signed("b"), "c2"), result("c2", "two")];

  it("drops Anthropic replay from the given index on and keeps the text", () => {
    const out = unbindThinking(history, 3);
    expect(signatures(out)).toEqual(["sig-a"]);
    const part = (out[3] as { content: AssistantPart[] }).content[0]!;
    expect(part).toEqual({ type: "reasoning", text: "b" });
    // Tool calls and earlier messages are untouched.
    expect(out[1]).toBe(history[1]);
    expect((out[3] as { content: AssistantPart[] }).content[1]).toEqual(history[3]!.role === "assistant" ? history[3]!.content[1] : null);
  });

  it("drops every block by default, and returns the same array when there is nothing to drop", () => {
    const all = unbindThinking(history);
    expect(signatures(all)).toEqual([]);
    expect(unbindThinking(all)).toBe(all);
  });

  it("leaves other protocols' replay alone", () => {
    const ms: LlmMessage[] = [user("go"), step(responsesItem("r"), "c1"), result("c1", "x")];
    expect(unbindThinking(ms)).toBe(ms);
  });
});

describe("prefixKey", () => {
  const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];

  it("is stable for the same system and tools, whatever the key order", () => {
    const reordered = [{ parameters: { properties: { path: { type: "string" } }, type: "object" }, description: "Read a file", name: "read" }];
    expect(prefixKey(["a", "b"], tools)).toBe(prefixKey(["a", "b"], reordered));
  });

  it("changes when a system part or a tool changes", () => {
    const base = prefixKey(["a", "b"], tools);
    expect(prefixKey(["a", "b2"], tools)).not.toBe(base);
    expect(prefixKey(["a", "b"], [...tools, { name: "grep", description: "g", parameters: {} }])).not.toBe(base);
  });
});

describe("history rewrites drop bound thinking", () => {
  it("pruning keeps thinking before the first cleared result and drops it after", () => {
    const big = "x".repeat(200_000);
    const ms: LlmMessage[] = [user("go"), step(signed("a"), "c1"), result("c1", big), step(signed("b"), "c2"), result("c2", big), step(signed("c"), "c3"), result("c3", "small")];
    const out = pruneToolOutputs(ms, { protect: 10, minSaving: 1 });
    expect(out.pruned).toBeGreaterThan(0);
    expect((out.messages[2] as { results: { text: string }[] }).results[0]!.text).toBe(PRUNED_MARKER);
    // "a" came before the first cleared result (index 2), so its prefix is unchanged.
    expect(signatures(out.messages)).toEqual(["sig-a"]);
  });

  it("pruning nothing leaves the thinking in place", () => {
    const ms: LlmMessage[] = [user("go"), step(signed("a"), "c1"), result("c1", "short")];
    const out = pruneToolOutputs(ms);
    expect(out.pruned).toBe(0);
    expect(signatures(out.messages)).toEqual(["sig-a"]);
  });

  it("compaction carries the tail over without signed thinking", () => {
    const tail: LlmMessage[] = [step(signed("b"), "c2"), result("c2", "two")];
    const out = compactedHistory("did work", tail);
    expect(signatures(out)).toEqual([]);
    expect(out[1]!.role === "assistant" && out[1]!.content[1]).toMatchObject({ type: "tool-call", id: "c2" });
  });
});

// The driver keeps the request prefix byte-stable within a session and drops
// bound thinking when the prefix does change between turns.
describe("provider driver prefix guard", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "harness-binding-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const provider: Provider = {
    id: "th",
    label: "TokenHarbor",
    wireProtocol: "anthropic-messages",
    baseURL: "https://tokenharbor.ai/v1",
    secret: { kind: "safeStorage", ciphertext: "x" },
    models: [{ id: "claude-x", name: "Claude X", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 200_000, maxOutput: 8_000 }],
  };

  function setup(answers: AssistantPart[][]) {
    const requests: LlmRequest[] = [];
    let n = 0;
    const stream = async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
      requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
      const message = answers[Math.min(n++, answers.length - 1)]!;
      yield { type: "finish", reason: message.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", message, usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 10 } };
    };
    const cwd = tmp();
    const sessions = new SessionStore(join(tmp(), "sessions"));
    let memory = "MEMORY ONE";
    const driver = createProviderDriver("th", {
      provider: () => provider,
      secret: () => "sk-test",
      secretHeaders: () => ({}),
      sessions,
      outputDir: join(tmp(), "out"),
      guardScript: BUILT_IN_GUARD,
      guide: () => "GUIDE",
      memory: () => memory,
      mcpTools: () => [],
      stream,
    });
    let session: string | null = null;
    const events: ThreadEvent[] = [];
    const input = (prompt: string): TurnInput => ({
      threadId: "t1",
      cwd,
      projectId: "p1",
      prompt,
      sessionId: session,
      model: "claude-x",
      effort: "high",
      permissionMode: "full",
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: (id) => (session = id),
      requestPermission: async () => "allow-once",
      requestPlanDecision: async () => "manual",
      tools: [],
      mcpServers: [],
    });
    return { driver, requests, sessions, input, events, session: () => session!, setMemory: (m: string) => (memory = m) };
  }

  const answers = (): AssistantPart[][] => [
    [signed("plan"), { type: "tool-call", id: "c1", name: "glob", input: { pattern: "*.md" } }],
    [signed("done"), { type: "text", text: "Done." }],
    [signed("again"), { type: "text", text: "Again." }],
  ];

  it("sends the same system, tools and message prefix on every call of a turn", async () => {
    const t = setup(answers());
    await t.driver.runTurn(t.input("list docs"));
    expect(t.requests).toHaveLength(2);
    const [a, b] = t.requests as [LlmRequest, LlmRequest];
    expect(b.system).toEqual(a.system);
    expect(b.tools).toEqual(a.tools);
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
    // The tool round's thinking goes back with its signature.
    expect(signatures(b.messages)).toEqual(["sig-plan"]);
  });

  it("keeps thinking across turns while the prefix is unchanged", async () => {
    const t = setup(answers());
    await t.driver.runTurn(t.input("list docs"));
    await t.driver.runTurn(t.input("and again"));
    expect(signatures(t.requests.at(-1)!.messages)).toEqual(["sig-plan", "sig-done"]);
  });

  it("drops earlier thinking, in the request and on disk, when the prefix changed between turns", async () => {
    const t = setup(answers());
    await t.driver.runTurn(t.input("list docs"));
    const before = t.sessions.meta(t.session()).prefixKey;
    t.setMemory("MEMORY TWO");
    await t.driver.runTurn(t.input("and again"));
    const last = t.requests.at(-1)!;
    expect(last.system.join("\n")).toContain("MEMORY TWO");
    expect(signatures(last.messages)).toEqual([]);
    expect(signatures(t.sessions.load(t.session())!)).toEqual(["sig-again"]);
    expect(t.sessions.meta(t.session()).prefixKey).not.toBe(before);
  });

  it("drops thinking from a session that has no recorded prefix (one from before the check)", async () => {
    const t = setup(answers());
    await t.driver.runTurn(t.input("list docs"));
    const id = t.session();
    t.sessions.setMeta(id, { startedOn: t.sessions.meta(id).startedOn! });
    await t.driver.runTurn(t.input("and again"));
    expect(signatures(t.requests.at(-1)!.messages)).toEqual([]);
  });

  it("freezes the prompt's date when the session starts", async () => {
    const t = setup(answers());
    await t.driver.runTurn(t.input("list docs"));
    const meta = t.sessions.meta(t.session());
    expect(meta.startedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    t.sessions.setMeta(t.session(), { ...meta, startedOn: "2026-01-02" });
    await t.driver.runTurn(t.input("and again"));
    expect(t.requests.at(-1)!.system.at(-1)).toContain("Date: 2026-01-02 (when this session started)");
  });
});
