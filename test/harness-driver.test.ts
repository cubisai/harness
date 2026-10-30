import { CODE_HINT } from "../src/main/code-hint";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PermissionMode, PlanDecision, Provider, Question, ThreadEvent } from "../src/shared/types";
import type { HarnessTool, TurnInput } from "../src/main/agents/types";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { ASK_USER_TOOL } from "../src/main/questions";
import { createProviderDriver, LOOK_AROUND, providerAgentId, RUN_CODE_TIP, type ProviderDriverDeps } from "../src/main/harness/driver";
import { PLAN_MODE_NOTE, PROPOSE_PLAN_TOOL } from "../src/main/harness/plan";
import { ProviderAgents } from "../src/main/harness/register";
import { EXPLORE_PROMPT, TASK_TOOL } from "../src/main/harness/subagent";
import { SessionStore, repairHistory } from "../src/main/harness/session";
import { isPruned } from "../src/main/harness/context/prune";
import { MemorySnapshots, PENDING_SESSION } from "../src/main/memory/snapshot";
import { tempDir } from "./helpers";
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

const SUMMARY_ANSWER = "## Request\nx";

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
  opts: {
    mode?: PermissionMode;
    decision?: "allow-once" | "deny";
    tools?: HarnessTool[];
    saved?: Provider | undefined;
    skills?: (cwd: string, design: boolean) => HarnessTool | null;
    stream?: ProviderDriverDeps["stream"];
    plan?: PlanDecision;
    requestUserInput?: TurnInput["requestUserInput"];
    memory?: ProviderDriverDeps["memory"];
    codeMode?: () => "off" | "on";
  } = {},
) {
  const cwd = tmp();
  const data = tmp();
  const outputDir = join(data, "out");
  const s = scripted(...answers);
  const sessions = new SessionStore(join(data, "sessions"));
  const saved = "saved" in opts ? opts.saved : provider();
  const driver = createProviderDriver("th", {
    provider: () => saved,
    secret: () => "sk-test",
    secretHeaders: () => ({}),
    sessions,
    outputDir,
    guardScript: BUILT_IN_GUARD,
    guide: () => "GUIDE TEXT",
    memory: opts.memory ?? (() => "MEMORY TEXT"),
    mcpTools: () => [],
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.codeMode ? { codeMode: opts.codeMode } : {}),
    stream: opts.stream ?? s.stream,
  });
  const events: ThreadEvent[] = [];
  const asked: string[] = [];
  const planRequests: string[] = [];
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
    requestPlanDecision: async (p) => (planRequests.push(p.plan), opts.plan ?? "manual"),
    tools: opts.tools ?? [],
    mcpServers: [],
    ...(opts.requestUserInput ? { requestUserInput: opts.requestUserInput } : {}),
  });
  return { driver, events, asked, planRequests, input, cwd, outputDir, sessions, requests: s.requests, session: () => session };
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
    expect(end).toMatchObject({ inputTokens: 2000, outputTokens: 200, costUsd: (2000 * 1 + 200 * 2) / 1e6, usage: { contextUsed: 1000, contextSize: 128_000 }, steps: 2, pruned: 0 });

    const first = t.requests[0]!;
    expect(first.model).toBe("deepseek-v4");
    expect(first.effort).toBe("high");
    expect(first.system.join("\n")).toContain("GUIDE TEXT");
    expect(first.system.join("\n")).toContain("MEMORY TEXT");
    expect(first.tools.map((x) => x.name)).toEqual(["read", "edit", "write", "bash", "glob", "grep", "web_fetch", "todowrite", TASK_TOOL]);
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

  it("runs a mutating app tool alone but lets read ones overlap", async () => {
    const peakOf = async (effect: "read" | "mutate"): Promise<number> => {
      let active = 0;
      let peak = 0;
      const probe: HarnessTool = {
        name: "probe",
        description: "probe",
        input: { n: z.number() },
        autoAllow: true,
        effect,
        run: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
          return { text: "ok" };
        },
      };
      const t = setup(
        [
          [
            { type: "tool-call", id: "c1", name: "probe", input: { n: 1 } },
            { type: "tool-call", id: "c2", name: "probe", input: { n: 2 } },
          ],
          [{ type: "text", text: "done" }],
        ],
        { tools: [probe] },
      );
      await t.driver.runTurn(t.input("go"));
      return peak;
    };
    expect(await peakOf("mutate")).toBe(1);
    expect(await peakOf("read")).toBe(2);
  });

  it("runs an auto-allowed mutating app tool without asking in ask mode", async () => {
    const ran: string[] = [];
    const memory: HarnessTool = {
      name: "memory_write",
      description: "Save a note",
      input: { x: z.string() },
      autoAllow: true,
      effect: "mutate",
      run: async () => (ran.push("ran"), { text: "saved" }),
    };
    const t = setup([[{ type: "tool-call", id: "c1", name: "memory_write", input: { x: "hi" } }], [{ type: "text", text: "done" }]], { mode: "ask", tools: [memory] });
    await t.driver.runTurn(t.input("save"));
    expect(t.asked).toEqual([]);
    expect(ran).toEqual(["ran"]);
    expect(t.events.find((e) => e.kind === "tool-result")).toMatchObject({ isError: false });
  });

  it("bounds an app tool's long output and saves the full text", async () => {
    const text = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join("\n");
    const browser: HarnessTool = { name: "browser_open", description: "Open a URL", input: { url: z.string() }, autoAllow: true, run: async () => ({ text }) };
    const t = setup([[{ type: "tool-call", id: "c1", name: "browser_open", input: { url: "https://x.dev" } }], [{ type: "text", text: "ok" }]], { tools: [browser] });
    await t.driver.runTurn(t.input("open"));
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.text).toMatch(/full output is in/);
    const savedFile = join(t.outputDir, "c1.txt");
    expect(existsSync(savedFile)).toBe(true);
    expect(readFileSync(savedFile, "utf8")).toBe(text);
  });

  it("leaves a short app result unchanged", async () => {
    const browser: HarnessTool = { name: "browser_open", description: "Open a URL", input: { url: z.string() }, autoAllow: true, run: async () => ({ text: "opened" }) };
    const t = setup([[{ type: "tool-call", id: "c1", name: "browser_open", input: { url: "https://x.dev" } }], [{ type: "text", text: "ok" }]], { tools: [browser] });
    await t.driver.runTurn(t.input("open"));
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.text).toBe("opened");
  });

  it("leaves the skill tool's long body unbounded", async () => {
    const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
    const skill: HarnessTool = { name: "skill", description: "Load a skill", input: { name: z.string() }, autoAllow: true, run: async () => ({ text }) };
    const t = setup([[{ type: "tool-call", id: "c1", name: "skill", input: { name: "x" } }], [{ type: "text", text: "ok" }]], { skills: () => skill });
    await t.driver.runTurn(t.input("hi"));
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.text).toBe(text);
  });

  it("turns TodoWrite into the thread's plan", async () => {
    const t = setup([[{ type: "tool-call", id: "c1", name: "todowrite", input: { todos: [{ content: "Read code", status: "in_progress" }] } }], [{ type: "text", text: "ok" }]]);
    await t.driver.runTurn(t.input("plan"));
    expect(t.events.find((e) => e.kind === "plan")).toEqual({ kind: "plan", entries: [{ content: "Read code", status: "in_progress" }] });
    // Like Claude's and OpenCode's: a plan, not a tool row; the model still gets the short summary.
    expect(t.events.some((e) => e.kind === "tool-use" || e.kind === "tool-result")).toBe(false);
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    // While parts are open the result reminds the model to keep the list current.
    expect(result.text).toBe("1 todos: 1 in progress, 0 completed, 0 pending. Update this list as each part finishes, and before your final reply.");
  });

  it("in code mode, points the second look-around call of a turn at run_code, once", async () => {
    const calls = [
      [{ type: "tool-call", id: "c1", name: "bash", input: { command: "ls" } }],
      [{ type: "tool-call", id: "c2", name: "bash", input: { command: "cat a.txt" } }],
      [{ type: "tool-call", id: "c3", name: "bash", input: { command: "grep hello a.txt" } }],
      [{ type: "text", text: "ok" }],
    ] as const;
    const on = setup(calls.map((c) => [...c]), { codeMode: () => "on" });
    writeFileSync(join(on.cwd, "a.txt"), "hello");
    await on.driver.runTurn(on.input("look"));
    const text = (n: number) => (on.requests[n]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!.text;
    expect(text(1)).not.toContain(RUN_CODE_TIP);
    expect(text(2)).toContain(RUN_CODE_TIP);
    expect(text(3)).not.toContain(RUN_CODE_TIP);
    // The row shows the command's own output, not the tip.
    expect(JSON.stringify(on.events.filter((e) => e.kind === "tool-result"))).not.toContain("Tip:");

    const off = setup(calls.map((c) => [...c]));
    await off.driver.runTurn(off.input("look"));
    expect((off.requests[2]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!.text).not.toContain(RUN_CODE_TIP);
  });

  it("in code mode, repeats the run_code tip on the fourth look-around call, and stops there", async () => {
    const look = (i: number) => [{ type: "tool-call", id: `c${i}`, name: "bash", input: { command: `grep word${i} .` } }];
    const calls = [look(1), look(2), look(3), look(4), look(5), look(6), [{ type: "text", text: "ok" }]];
    const on = setup(calls.map((c) => [...c]) as never, { codeMode: () => "on" });
    await on.driver.runTurn(on.input("look"));
    const text = (n: number) => (on.requests[n]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!.text;
    expect([1, 2, 3, 4, 5, 6].map((n) => text(n).includes(RUN_CODE_TIP))).toEqual([false, true, false, true, false, false]);
  });

  it("counts only listing, reading and searching commands as looking around", () => {
    for (const c of ["ls -la", "cd /x && cat a.ts", "grep -rn foo src", "find . -name '*.ts'"]) expect(LOOK_AROUND.test(c)).toBe(true);
    for (const c of ["npm test", "git status", "node --test", "cd /x && npm run build"]) expect(LOOK_AROUND.test(c)).toBe(false);
  });

  it("shows no plan for a bad todo list and tells the model why", async () => {
    const t = setup([[{ type: "tool-call", id: "c1", name: "todowrite", input: { todos: [{ content: "a", status: "doing" }] } }], [{ type: "text", text: "ok" }]]);
    await t.driver.runTurn(t.input("plan"));
    expect(t.events.some((e) => e.kind === "plan")).toBe(false);
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"status" must be');
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

  it("runs a team member on its own model when the provider lists it, else on the lead's", async () => {
    const small = { id: "small", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 64_000, maxOutput: 4_000 };
    const hand = (agent: string): AssistantPart[] => [{ type: "tool-call", id: `c-${agent}`, name: "task", input: { description: "Check", prompt: "Check it.", agent } }];
    const t = setup([hand("listed"), [{ type: "text", text: "checked" }], hand("missing"), [{ type: "text", text: "checked too" }], [{ type: "text", text: "done" }]], {
      saved: provider({ models: [...provider().models, small] }),
    });
    await t.driver.runTurn({
      ...t.input("go"),
      team: [
        { id: "listed", description: "L", prompt: "You are listed.", model: "small", effort: "low" },
        { id: "missing", description: "M", prompt: "You are missing.", model: "nope" },
      ],
    });
    const listed = t.requests.find((r) => r.system.includes("You are listed."))!;
    expect(listed).toMatchObject({ model: "small", effort: "low" });
    const missing = t.requests.find((r) => r.system.includes("You are missing."))!;
    expect(missing).toMatchObject({ model: "deepseek-v4", effort: "high" });
    const results = t.events.filter((e) => e.kind === "tool-result");
    expect(results.some((e) => e.kind === "tool-result" && /ran on deepseek-v4: nope isn't offered/.test(JSON.stringify(e)))).toBe(true);
  });

  it("reconciles a team turn's cost: the lead's own calls plus each member priced on the model it ran on (P6.3)", async () => {
    const small = { id: "small", capabilities: { tools: true, vision: false, reasoning: true }, contextWindow: 64_000, maxOutput: 4_000, cost: { input: 10, output: 20 } };
    const hand = (agent: string): AssistantPart[] => [{ type: "tool-call", id: `c-${agent}`, name: "task", input: { description: "Check", prompt: "Check it.", agent } }];
    const t = setup([hand("listed"), [{ type: "text", text: "a" }], hand("plain"), [{ type: "text", text: "b" }], [{ type: "text", text: "done" }]], {
      saved: provider({ models: [...provider().models, small] }),
    });
    await t.driver.runTurn({
      ...t.input("go"),
      team: [
        { id: "listed", description: "L", prompt: "You are listed.", model: "small" },
        { id: "plain", description: "P", prompt: "You are plain." },
      ],
    });
    // Every call reports 1000 in / 100 out. Lead: 3 calls on deepseek (1/2 per M); listed: small (10/20); plain: deepseek.
    const lead = (3000 * 1 + 300 * 2) / 1e6;
    const listed = (1000 * 10 + 100 * 20) / 1e6;
    const plain = (1000 * 1 + 100 * 2) / 1e6;
    const results = t.events.filter((e): e is Extract<ThreadEvent, { kind: "tool-result" }> => e.kind === "tool-result" && !e.parentId);
    expect(results.map((r) => r.runUsage)).toEqual([
      { inputTokens: 1000, outputTokens: 100, costUsd: listed },
      { inputTokens: 1000, outputTokens: 100, costUsd: plain },
    ]);
    const end = t.events.find((e) => e.kind === "turn-end")!;
    expect(end).toMatchObject({ inputTokens: 5000, outputTokens: 500 });
    expect((end as { costUsd: number }).costUsd).toBeCloseTo(lead + listed + plain, 10);
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
    // Big enough that pruning the older result still leaves the protected newest
    // one over the cap, so the turn compacts as well.
    const sid = seedSession(t.sessions, 80_000);
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
    const pruned = (t.sessions.load(sid)![2] as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(isPruned(pruned.text)).toBe(true);
    expect(pruned.text).toContain(t.outputDir);
    expect(readFileSync(join(t.outputDir, "c1.pruned.txt"), "utf8")).toBe("x".repeat(160_000));
    expect(t.events.at(-1)).toMatchObject({ kind: "turn-end", steps: 2, pruned: 1 });
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

  it("freezes the memory block for the life of an agent session", async () => {
    const snapshots = new MemorySnapshots(tempDir());
    let n = 0;
    const calls: [string, string | undefined, string | null | undefined][] = [];
    const memory: ProviderDriverDeps["memory"] = (projectId, threadId, sessionKey) => {
      calls.push([projectId, threadId, sessionKey]);
      return snapshots.get(threadId!, sessionKey ?? PENDING_SESSION, () => `MEM-${++n}`);
    };
    const t = setup([[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]], { memory });
    await t.driver.runTurn(t.input("hi"));
    const sid = t.session()!;
    await t.driver.runTurn(t.input("again", sid));
    // The block is frozen: the resumed turn reuses the first turn's, byte for byte.
    expect(t.requests[0]!.system.join("\n")).toContain("MEM-1");
    expect(t.requests[1]!.system).toEqual(t.requests[0]!.system);
    // Both reads name the one session id that was settled on the first turn.
    expect(calls).toEqual([["p1", "t1", sid], ["p1", "t1", sid]]);
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

  it("runs propose_plan in plan mode and continues the same turn with the approved mode", async () => {
    const t = setup(
      [
        [{ type: "tool-call", id: "c1", name: "write", input: { path: "hello.txt", content: "hi\n" } }],
        [{ type: "tool-call", id: "c2", name: PROPOSE_PLAN_TOOL, input: { plan: "## Plan\n1. write hello" } }],
        [{ type: "tool-call", id: "c3", name: "write", input: { path: "hello.txt", content: "hi\n" } }],
        [{ type: "text", text: "Done." }],
      ],
      { mode: "plan", plan: "auto" },
    );
    await t.driver.runTurn(t.input("plan it"));
    expect(t.planRequests).toEqual(["## Plan\n1. write hello"]);
    expect(t.requests[0]!.tools.map((x) => x.name)).toContain(PROPOSE_PLAN_TOOL);
    expect(t.requests[0]!.system.at(-1)).toBe(PLAN_MODE_NOTE);
    // The write before approval is refused with the plan-mode reason, without a card.
    const refused = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("Plan mode is read-only") });
    // The write after approval runs in the same turn.
    expect(readFileSync(join(t.cwd, "hello.txt"), "utf8")).toBe("hi\n");
    const approved = (t.requests[3]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(approved.isError).toBeUndefined();
    expect(t.asked).toEqual([]);
  });

  it("keeps planning with the user's feedback and leaves the mode read-only", async () => {
    const t = setup(
      [
        [{ type: "tool-call", id: "c1", name: PROPOSE_PLAN_TOOL, input: { plan: "v1" } }],
        [{ type: "tool-call", id: "c2", name: "write", input: { path: "x.txt", content: "x" } }],
        [{ type: "text", text: "ok" }],
      ],
      { mode: "plan", plan: { keep: "add tests" } },
    );
    await t.driver.runTurn(t.input("plan"));
    const keep = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(keep.text).toContain("add tests");
    expect(keep.text).toContain("keep planning");
    const refused = (t.requests[2]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("Plan mode is read-only") });
    expect(existsSync(join(t.cwd, "x.txt"))).toBe(false);
  });

  it("does not offer propose_plan outside plan mode", async () => {
    const t = setup([[{ type: "text", text: "ok" }]], { mode: "full" });
    await t.driver.runTurn(t.input("hi"));
    expect(t.requests[0]!.tools.map((x) => x.name)).not.toContain(PROPOSE_PLAN_TOOL);
    expect(t.requests[0]!.system.at(-1)).not.toBe(PLAN_MODE_NOTE);
  });

  it("offers ask_user when the app can ask, and returns the answer to the model", async () => {
    const questions: Question[] = [];
    const t = setup(
      [
        [
          {
            type: "tool-call",
            id: "c1",
            name: ASK_USER_TOOL,
            input: { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] }] },
          },
        ],
        [{ type: "text", text: "ok" }],
      ],
      { requestUserInput: async (q) => (questions.push(...q), { answers: { q0: ["A"] } }) },
    );
    await t.driver.runTurn(t.input("ask"));
    expect(t.requests[0]!.tools.map((x) => x.name)).toContain(ASK_USER_TOOL);
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.text).toContain("Answer: A");
    expect(questions.map((q) => q.question)).toEqual(["Which one?"]);
  });

  it("does not offer ask_user without a way to ask", async () => {
    const t = setup([[{ type: "text", text: "ok" }]]);
    await t.driver.runTurn(t.input("hi"));
    expect(t.requests[0]!.tools.map((x) => x.name)).not.toContain(ASK_USER_TOOL);
  });

  it("runs parallel task subagents with only read-only tools and folds in their usage", async () => {
    const childSteps = new Map<string, number>();
    const requests: LlmRequest[] = [];
    let mainStep = 0;
    const userTextOf = (req: LlmRequest): string => {
      const first = req.messages.find((m) => m.role === "user");
      return first && first.role === "user" ? first.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
    };
    const stream = (async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
      requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
      // Children are identified by their prompt, since parallel children interleave.
      if (req.system[0] === EXPLORE_PROMPT) {
        const prompt = userTextOf(req);
        const n = (childSteps.get(prompt) ?? 0) + 1;
        childSteps.set(prompt, n);
        if (n === 1) {
          yield { type: "finish", reason: "tool-calls", message: [{ type: "tool-call", id: `r-${prompt}`, name: "read", input: { path: "f.txt" } }], usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 10 } };
          return;
        }
        yield { type: "finish", reason: "stop", message: [{ type: "text", text: prompt === "find A" ? "report A" : "report B" }], usage: { ...emptyUsage(), inputTokens: 200, outputTokens: 20 } };
        return;
      }
      mainStep++;
      if (mainStep === 1) {
        yield {
          type: "finish",
          reason: "tool-calls",
          message: [
            { type: "tool-call", id: "tA", name: TASK_TOOL, input: { description: "A", prompt: "find A" } },
            { type: "tool-call", id: "tB", name: TASK_TOOL, input: { description: "B", prompt: "find B" } },
          ],
          usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 100 },
        };
        return;
      }
      yield { type: "finish", reason: "stop", message: [{ type: "text", text: "all done" }], usage: { ...emptyUsage(), inputTokens: 500, outputTokens: 50 } };
    }) as ProviderDriverDeps["stream"];

    const browser: HarnessTool = { name: "browser_open", description: "Open a URL", input: { url: z.string() }, autoAllow: true, run: async () => ({ text: "opened" }) };
    const t = setup([], { stream, tools: [browser], requestUserInput: async () => ({ answers: { q0: ["A"] } }) });
    writeFileSync(join(t.cwd, "f.txt"), "hello\n");
    await t.driver.runTurn(t.input("research both"));

    // Both children ran, each with a read step then a report.
    const childRequests = requests.filter((r) => r.system[0] === EXPLORE_PROMPT);
    expect(childRequests.map(userTextOf).sort()).toEqual(["find A", "find A", "find B", "find B"]);
    // Children get exactly the three read-only native tools — never app tools, propose_plan or task.
    for (const r of childRequests) expect(r.tools.map((x) => x.name).sort()).toEqual(["glob", "grep", "read"]);

    // Every child event hangs off the task call that started it.
    const childEvents = t.events.filter((e) => e.parentId !== undefined);
    expect(new Set(childEvents.map((e) => e.parentId))).toEqual(new Set(["tA", "tB"]));
    const byA = t.events.filter((e) => e.parentId === "tA");
    const byB = t.events.filter((e) => e.parentId === "tB");
    expect(byA.map((e) => e.kind)).toEqual(["tool-use", "tool-result", "assistant-text"]);
    expect(byB.map((e) => e.kind)).toEqual(["tool-use", "tool-result", "assistant-text"]);
    expect(byA.find((e) => e.kind === "assistant-text")).toMatchObject({ text: "report A" });
    expect(byB.find((e) => e.kind === "assistant-text")).toMatchObject({ text: "report B" });

    // The main model's next request carries both reports back.
    const mainRequests = requests.filter((r) => r.system[0] !== EXPLORE_PROMPT);
    const reported = (mainRequests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results.map((r) => r.text);
    expect(reported.sort()).toEqual(["report A", "report B"]);

    // The children's usage is folded into the turn-end total.
    const end = t.events.at(-1) as Extract<ThreadEvent, { kind: "turn-end" }>;
    expect(end.inputTokens).toBe(1000 + 500 + 100 + 200 + 100 + 200);
  });

  it("drops the plan-mode note from later requests once a plan is approved", async () => {
    const t = setup(
      [
        [{ type: "tool-call", id: "c1", name: PROPOSE_PLAN_TOOL, input: { plan: "## Plan" } }],
        [{ type: "text", text: "Done." }],
      ],
      { mode: "plan", plan: "auto" },
    );
    await t.driver.runTurn(t.input("plan it"));
    expect(t.requests[0]!.system).toContain(PLAN_MODE_NOTE);
    expect(t.requests[1]!.system).not.toContain(PLAN_MODE_NOTE);
  });

  it("offers the task tool in plan mode and in ask mode", async () => {
    for (const mode of ["plan", "ask"] as const) {
      const t = setup([[{ type: "text", text: "ok" }]], { mode });
      await t.driver.runTurn(t.input("hi"));
      expect(t.requests[0]!.tools.map((x) => x.name)).toContain(TASK_TOOL);
    }
  });

  it("offers run_code only when code mode is on", async () => {
    const off = setup([[{ type: "text", text: "ok" }]]);
    await off.driver.runTurn(off.input("hi"));
    expect(off.requests[0]!.tools.map((x) => x.name)).not.toContain("run_code");

    const on = setup([[{ type: "text", text: "ok" }]], { codeMode: () => "on" });
    await on.driver.runTurn(on.input("hi"));
    expect(on.requests[0]!.tools.map((x) => x.name)).toContain("run_code");
  });

  it("in code mode, offers run_code instead of read, glob and grep and keeps store/load across turns", async () => {
    const first = "store('n', 1); const r = await tools.read({ path: 'a.txt' }); return r.includes('hello');";
    const second = "return load('n') + 1;";
    const t = setup(
      [
        [{ type: "tool-call", id: "c1", name: "run_code", input: { code: first } }],
        [{ type: "text", text: "ok" }],
        [{ type: "tool-call", id: "c2", name: "run_code", input: { code: second } }],
        [{ type: "text", text: "ok" }],
      ],
      { codeMode: () => "on" },
    );
    writeFileSync(join(t.cwd, "a.txt"), "hello\n");
    await t.driver.runTurn(t.input("go"));
    const names = t.requests[0]!.tools.map((x) => x.name);
    expect(names).toContain("run_code");
    // The model sees run_code instead of the three look-around tools; its script still calls them.
    for (const hidden of ["read", "glob", "grep"]) expect(names).not.toContain(hidden);
    expect(names).toContain("edit");
    expect(t.requests[0]!.tools.map((x) => x.name)).toContain("bash");
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.text).toContain("=> true");
    expect(t.events.find((e) => e.kind === "tool-use" && e.parentId === "c1")).toMatchObject({ name: "Read" });
    await t.driver.runTurn(t.input("again", t.session()));
    const next = (t.requests[3]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(next.text).toContain("=> 2");
  });

  it("in code mode, runs a shell search as usual", async () => {
    const t = setup(
      [[{ type: "tool-call", id: "b1", name: "bash", input: { command: "grep -rn hello ." } }], [{ type: "text", text: "ok" }]],
      { codeMode: () => "on" },
    );
    writeFileSync(join(t.cwd, "a.txt"), "hello\n");
    await t.driver.runTurn(t.input("go"));
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.text).toContain("a.txt");
    // One fixed line says when a run_code script beats the shell; off has none.
    expect(t.requests[0]!.system).toContain(CODE_HINT);
    const off = setup([[{ type: "text", text: "ok" }]]);
    await off.driver.runTurn(off.input("hi"));
    expect(off.requests[0]!.system).not.toContain(CODE_HINT);
  });

  it("authorizes each run_code inner call and surfaces a denial inside the script", async () => {
    const code = "await tools.write({ path: 'x.txt', content: 'x' }); return 'wrote';";
    const t = setup([[{ type: "tool-call", id: "c1", name: "run_code", input: { code } }], [{ type: "text", text: "ok" }]], { mode: "ask", codeMode: () => "on" });
    const asked: string[] = [];
    await t.driver.runTurn({
      ...t.input("go"),
      requestPermission: async (r) => {
        asked.push(`${r.toolName}: ${r.summary}`);
        return r.toolName === "run_code" ? "allow-once" : "deny";
      },
    });
    expect(asked).toEqual([`run_code: ${code}`, "Write: x.txt"]);
    // The denied inner call throws inside the script, so run_code itself reports the error.
    const result = (t.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/denied/i);
    expect(existsSync(join(t.cwd, "x.txt"))).toBe(false);
    // The refused inner call is still a visible child row, with its refusal as the result.
    expect(t.events.find((e) => e.kind === "tool-use" && e.parentId === "c1")).toMatchObject({ name: "Write", summary: "x.txt" });
    expect(t.events.find((e) => e.kind === "tool-result" && e.parentId === "c1")).toMatchObject({ isError: true });
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
