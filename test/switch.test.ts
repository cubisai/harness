import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentCapabilities, LiveUpdate, ThreadEvent, Usage } from "../src/shared/types";
import { createAcpDriver } from "../src/main/agents/acp/driver";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { normalizeUsage } from "../src/main/usage";
import { catalog, closeAfter, tempDir } from "./helpers";

type Script = (input: TurnInput) => Promise<void>;

function fake(id: string, script: Script, caps: Partial<AgentCapabilities> = {}): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id,
    label: id.toUpperCase(),
    defaultModel: `${id}-1`,
    capabilities: { ...SAFE_DEFAULTS, ...caps },
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "",
    models: () => [{ id: `${id}-1`, label: `${id} 1` }],
    prompts,
    async runTurn(input) {
      prompts.push(input.prompt);
      await script(input);
    },
  };
}

const usage = (u: { inputTokens?: number; cacheReadTokens?: number | null; cacheWriteTokens?: number | null }): Usage =>
  normalizeUsage({ inputTokens: u.inputTokens ?? 100, outputTokens: 5, cacheReadTokens: u.cacheReadTokens === undefined ? 0 : u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens === undefined ? 0 : u.cacheWriteTokens });

const endWith = (u: Usage): ThreadEvent => ({ kind: "turn-end", costUsd: null, inputTokens: u.inputTokens, outputTokens: 5, durationMs: 1, usage: u });

/** A clean git repository with one commit. */
function repo(): string {
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

const refExists = (dir: string, ref: string) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/${ref}`], { cwd: dir }).status === 0;

function setup(drivers: AgentDriver[], cwd = repo()) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const updates: LiveUpdate[] = [];
  const service = new Service(store, () => catalog(), drivers, (u) => updates.push(u));
  const project = store.addProject(cwd);
  const thread = service.createThread(project.id, drivers[0]!.id);
  return { store, service, updates, thread, cwd };
}

/** "a" answers and reports a big turn, so a handoff replaces more than it costs. */
const aScript: Script = async (input) => {
  input.onSession("a-1");
  input.onEvent({ kind: "assistant-text", text: "I changed the login check." });
  input.onEvent(endWith(usage({ inputTokens: 50_000, cacheReadTokens: 10_000 })));
};

describe("Service.switchAgent", () => {
  it("hands off through a first message: git ref, trust reset, reply kept as a handoff event", async () => {
    const a = fake("a", aScript);
    const b = fake("b", async (input) => {
      input.onSession("b-1");
      input.onEvent({ kind: "assistant-text", text: "Got it." });
      input.onEvent(endWith(usage({ cacheReadTokens: 0, cacheWriteTokens: 4000 })));
    });
    const { store, service, thread, cwd } = setup([a, b]);
    service.updateThread(thread.id, { permissionMode: "full" });
    await service.send({ threadId: thread.id, text: "Fix the login bug" });
    const seq = store.listEvents(thread.id).at(-1)!.seq;

    const res = await service.switchAgent(thread.id, "b", "handoff");
    expect(res).toMatchObject({ ok: true, mode: "handoff", gitRef: `harness-handoff/${seq}`, seeded: { channel: "first-message", sent: 1, tier: 0, estimated: true } });
    expect(refExists(cwd, `harness-handoff/${seq}`)).toBe(true);
    expect(b.prompts).toHaveLength(1);
    expect(b.prompts[0]).toContain("Fix the login bug");
    expect(b.prompts[0]).toContain("I changed the login check.");

    const after = store.getThread(thread.id);
    expect(after).toMatchObject({ agent: "b", permissionMode: "ask", sessionId: "b-1" });
    expect(after.bindings["a:default"]!.resumeCursor).toBe("a-1");
    const kinds = store.listEvents(thread.id).map((e) => e.event);
    const handoffs = kinds.filter((e): e is Extract<ThreadEvent, { kind: "handoff" }> => e.kind === "handoff");
    expect(handoffs.map((e) => e.phase)).toEqual(["seeded", "reply", "signal"]);
    expect(handoffs[1]!.text).toBe("Got it.");
    // The synthetic prompt's reply is not an assistant turn.
    expect(kinds.filter((e) => e.kind === "assistant-text")).toHaveLength(1);
    expect(handoffs[2]!.text).toContain("Re-seeded 4.1k tokens");
  });

  it("refuses a dirty worktree and changes nothing", async () => {
    const a = fake("a", aScript);
    const b = fake("b", async () => {});
    const { store, service, thread, cwd } = setup([a, b]);
    await service.send({ threadId: thread.id, text: "Fix it" });
    writeFileSync(join(cwd, "app.ts"), "export const a = 2;\n");
    const seq = store.listEvents(thread.id).at(-1)!.seq;

    const res = await service.switchAgent(thread.id, "b", "handoff");
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toMatch(/Commit or stash.*app\.ts/);
    expect(refExists(cwd, `harness-handoff/${seq}`)).toBe(false);
    expect(store.getThread(thread.id).agent).toBe("a");
    expect(b.prompts).toHaveLength(0);
  });

  it("says a target without a seeding channel can't take a handoff", async () => {
    const a = fake("a", aScript);
    const b = fake("b", async () => {}, { seeding: "none" });
    const { store, service, thread } = setup([a, b]);
    await service.send({ threadId: thread.id, text: "Fix it" });
    const res = await service.switchAgent(thread.id, "b", "handoff");
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("no way to receive a handoff") });
    expect(store.getThread(thread.id).agent).toBe("a");
  });

  it("keeps no allow-always rule from the old agent", async () => {
    const asked: string[] = [];
    const script: Script = async (input) => {
      asked.push(await input.requestPermission({ toolName: "Run", summary: "npm test", canAlwaysAllow: true }));
    };
    const a = fake("a", script);
    const b = fake("b", script);
    const { service, thread, updates } = setup([a, b]);
    const first = service.send({ threadId: thread.id, text: "one" });
    // The turn snapshots the working tree first, so wait for the request itself.
    await vi.waitFor(() => expect(updates.some((u) => u.type === "permission")).toBe(true), { timeout: 5000 });
    const req = updates.find((u) => u.type === "permission") as Extract<LiveUpdate, { type: "permission" }>;
    service.respondPermission(req.request.requestId, "allow-always");
    await first;

    expect((await service.switchAgent(thread.id, "b", "fresh")).ok).toBe(true);
    const second = service.send({ threadId: thread.id, text: "two" });
    // The turn runs the catch-up (a git-backed checkpoint) first, so wait for the request itself.
    await vi.waitFor(() => expect(updates.filter((u) => u.type === "permission")).toHaveLength(2), { timeout: 5000 });
    service.interrupt(thread.id);
    await second;
  });

  it("goes back to the earlier session, and the bloat signal reads the first turn after a switch", async () => {
    let bTurn = 0;
    const a = fake("a", async (input) => {
      input.onSession("a-1");
      input.onEvent(endWith(usage({ cacheReadTokens: 10_000 })));
    });
    const b = fake("b", async (input) => {
      bTurn++;
      input.onSession("b-1");
      input.onEvent(endWith(usage({ cacheReadTokens: null, cacheWriteTokens: null })));
    });
    const { store, service, thread } = setup([a, b]);
    await service.send({ threadId: thread.id, text: "one" });
    expect((await service.switchAgent(thread.id, "b", "fresh")).ok).toBe(true);
    await service.send({ threadId: thread.id, text: "two" });
    expect(bTurn).toBe(1);

    const back = await service.switchAgent(thread.id, "a", "back");
    expect(back).toMatchObject({ ok: true, thread: { agent: "a", sessionId: "a-1" } });
    expect(back.ok && back.thread.bindings["b:default"]!.resumeCursor).toBe("b-1");
    await service.send({ threadId: thread.id, text: "three" });

    const signals = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "handoff" }> => e.kind === "handoff" && e.phase === "signal")
      .map((e) => e.text);
    // A fresh switch hands nothing off, so only going back gets a reading.
    expect(signals).toEqual([expect.stringContaining("Reused 10.0k cached tokens")]);
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "notice" && e.event.text.startsWith("Back to A"))).toBe(true);
  });

  it("refuses to go back when the agent has no earlier session", async () => {
    const { service, thread } = setup([fake("a", aScript), fake("b", async () => {})]);
    expect(await service.switchAgent(thread.id, "b", "back")).toMatchObject({ ok: false, reason: expect.stringContaining("no earlier B conversation") });
  });

  it("hands a returning agent only what it missed, once", async () => {
    const a = fake("a", async (input) => {
      input.onSession("a-1");
      input.onEvent({ kind: "assistant-text", text: "A's first answer." });
      input.onEvent(endWith(usage({ inputTokens: 50_000, cacheReadTokens: 10_000 })));
    });
    const b = fake("b", async (input) => {
      input.onSession("b-1");
      input.onEvent({ kind: "assistant-text", text: "B's take on it." });
      input.onEvent(endWith(usage({ inputTokens: 50_000, cacheReadTokens: 0 })));
    });
    const { store, service, thread } = setup([a, b]);
    await service.send({ threadId: thread.id, text: "one" });
    expect((await service.switchAgent(thread.id, "b", "fresh")).ok).toBe(true);
    await service.send({ threadId: thread.id, text: "two" });
    expect((await service.switchAgent(thread.id, "a", "back")).ok).toBe(true);

    const before = a.prompts.length;
    await service.send({ threadId: thread.id, text: "three" });
    const prompt = a.prompts[before]!;
    expect(prompt.startsWith("# Handoff from")).toBe(true);
    expect(prompt).toContain("B's take on it.");
    expect(prompt).not.toContain("A's first answer.");
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "notice" && e.event.text.startsWith("Handed what it missed to"))).toBe(true);

    const beforeSecond = a.prompts.length;
    await service.send({ threadId: thread.id, text: "four" });
    expect(a.prompts[beforeSecond]).toBe("four");
  });

  it("carries nothing over when the user picks Start fresh", async () => {
    const a = fake("a", async (input) => {
      input.onSession("a-1");
      input.onEvent({ kind: "assistant-text", text: "Set up the project." });
      input.onEvent(endWith(usage({ inputTokens: 50_000, cacheReadTokens: 0 })));
    });
    const b = fake("b", async (input) => {
      input.onSession("b-1");
    });
    const { store, service, thread } = setup([a, b]);
    await service.send({ threadId: thread.id, text: "start" });
    expect((await service.switchAgent(thread.id, "b", "fresh")).ok).toBe(true);
    await service.send({ threadId: thread.id, text: "continue" });
    expect(b.prompts[0]).toBe("continue");
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "notice" && e.event.text.startsWith("Now talking to B"))).toBe(true);
  });

  it("catches a new agent up on a thread with history, and not on an empty one", async () => {
    const a = fake("a", async (input) => {
      input.onSession("a-1");
      input.onEvent({ kind: "assistant-text", text: "Set up the project." });
      input.onEvent(endWith(usage({ inputTokens: 50_000, cacheReadTokens: 0 })));
    });
    const b = fake("b", async (input) => {
      input.onSession("b-1");
      input.onEvent({ kind: "assistant-text", text: "On it." });
    });
    const { store, service, thread } = setup([a, b]);
    await service.send({ threadId: thread.id, text: "start" });
    service.updateThread(thread.id, { agent: "b" });
    await service.send({ threadId: thread.id, text: "continue" });

    expect(b.prompts[0]!.startsWith("# Handoff from")).toBe(true);
    expect(b.prompts[0]).toContain("start");
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "notice" && e.event.text.startsWith("Handed this thread's history to"))).toBe(true);

    const b2 = fake("b", async (input) => {
      input.onSession("b-1");
      input.onEvent({ kind: "assistant-text", text: "On it." });
    });
    const empty = setup([fake("a", async () => {}), b2]);
    empty.service.updateThread(empty.thread.id, { agent: "b" });
    await empty.service.send({ threadId: empty.thread.id, text: "first" });
    expect(b2.prompts[0]).toBe("first");
    expect(empty.store.listEvents(empty.thread.id).some((e) => e.event.kind === "notice" && e.event.text.includes("Handed"))).toBe(false);
  });
});

describe("handoff to an ACP agent", () => {
  it("sends the checkpoint as one session/prompt and keeps the reply as a handoff event", async () => {
    const acp = createAcpDriver({ id: "mock", label: "Mock", command: process.execPath, args: [join(__dirname, "fixtures", "mock-acp-agent.mjs")] }, { clientVersion: "test" });
    closeAfter(() => acp.dispose?.());
    const { store, service, thread } = setup([fake("a", aScript), acp]);
    await service.send({ threadId: thread.id, text: "HANDOFF-MARKER fix it" });

    const res = await service.switchAgent(thread.id, "mock", "handoff");
    expect(res).toMatchObject({ ok: true, seeded: { channel: "first-message", sent: 1 } });
    const replies = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "handoff" }> => e.kind === "handoff" && e.phase === "reply");
    // The mock echoes its prompt: one reply holding the header and the closing line means one prompt carried it all.
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("# Handoff from a");
    expect(replies[0]!.text).toContain("HANDOFF-MARKER fix it");
    expect(replies[0]!.text).toContain("don't run any tools yet");
    expect(store.listEvents(thread.id).filter((e) => e.event.kind === "assistant-text" && e.provenance?.agent === "mock")).toHaveLength(0);
  });
});
