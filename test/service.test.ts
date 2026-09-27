import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveUpdate, ThreadEvent } from "../src/shared/types";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { Service, titleFrom } from "../src/main/service";
import { normalizeUsage } from "../src/main/usage";
import { catalog, closeAfter, tempDir } from "./helpers";

function fakeDriver(script: (input: TurnInput) => Promise<void>): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake",
    label: "Fake",
    defaultModel: "fake-1",
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "skilled:",
    models: () => [{ id: "fake-1", label: "Fake 1" }],
    prompts,
    async runTurn(input) {
      prompts.push(input.prompt);
      await script(input);
    },
  };
}

function setup(script: (input: TurnInput) => Promise<void>) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const updates: LiveUpdate[] = [];
  const driver = fakeDriver(script);
  const service = new Service(store, () => catalog(), [driver], (u) => updates.push(u));
  const project = store.addProject(tempDir());
  const thread = service.createThread(project.id);
  return { store, service, driver, updates, thread };
}

describe("Service.send", () => {
  it("stores the turn, names the thread, and remembers the session", async () => {
    const { store, service, thread, updates } = setup(async (input) => {
      input.onSession("session-1");
      input.onTextDelta("Hel");
      input.onEvent({ kind: "assistant-text", text: "Hello" });
    });
    await service.send({ threadId: thread.id, text: "Say hi" });
    expect(store.listEvents(thread.id).map((e) => e.event.kind)).toEqual(["user", "assistant-text"]);
    expect(store.getThread(thread.id)).toMatchObject({ title: "Say hi", sessionId: "session-1" });
    expect(updates.filter((u) => u.type === "running").map((u) => (u as { running: boolean }).running)).toEqual([true, false]);
    expect(service.isRunning(thread.id)).toBe(false);
  });

  it("says so when a model ends the turn without any reply", async () => {
    const turnEnd = { kind: "turn-end" as const, costUsd: null, inputTokens: 10, outputTokens: 0, durationMs: 5 };
    const silent = setup(async (input) => input.onEvent(turnEnd));
    await silent.service.send({ threadId: silent.thread.id, text: "hi" });
    const events = silent.store.listEvents(silent.thread.id).map((e) => e.event);
    expect(events.map((e) => e.kind)).toEqual(["user", "notice", "turn-end"]);
    expect(events[1]).toMatchObject({ kind: "notice", text: expect.stringMatching(/without a reply from fake-1/) });

    const replied = setup(async (input) => {
      input.onEvent({ kind: "assistant-text", text: "OK" });
      input.onEvent(turnEnd);
    });
    await replied.service.send({ threadId: replied.thread.id, text: "hi" });
    expect(replied.store.listEvents(replied.thread.id).map((e) => e.event.kind)).toEqual(["user", "assistant-text", "turn-end"]);
  });

  it("broadcasts live deltas without writing them to the store", async () => {
    const { store, service, thread, updates } = setup(async (input) => {
      input.onReasoningDelta?.({ itemId: "r1", text: "think", opaque: false });
      input.onTextDelta("x", "i1");
    });
    await service.send({ threadId: thread.id, text: "go" });
    expect(updates).toContainEqual({
      type: "delta",
      threadId: thread.id,
      delta: { kind: "reasoning-delta", itemId: "r1", text: "think", opaque: false },
    });
    expect(updates).toContainEqual({
      type: "delta",
      threadId: thread.id,
      delta: { kind: "text-delta", itemId: "i1", text: "x" },
    });
    expect(store.listEvents(thread.id).map((e) => e.event.kind)).toEqual(["user"]);
  });

  it("expands a user-invoked skill into the prompt", async () => {
    const { service, thread, driver } = setup(async () => {});
    await service.send({ threadId: thread.id, text: "ticket 2", skill: "implement" });
    expect(driver.prompts[0]).toContain('<skill name="implement"');
  });

  it("routes permission requests to the UI and back", async () => {
    let decision = "";
    const { service, thread, updates } = setup(async (input) => {
      decision = await input.requestPermission({ toolName: "Bash", summary: "ls", canAlwaysAllow: false });
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "permission");
    expect(req).toBeDefined();
    service.respondPermission((req as Extract<LiveUpdate, { type: "permission" }>).request.requestId, "allow-once");
    await sending;
    expect(decision).toBe("allow-once");
  });

  it("denies pending permissions when interrupted", async () => {
    let decision = "";
    const { service, thread } = setup(async (input) => {
      decision = await input.requestPermission({ toolName: "Bash", summary: "ls", canAlwaysAllow: false });
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    service.interrupt(thread.id);
    await sending;
    expect(decision).toBe("deny");
  });

  it("refuses a second send while a turn runs", async () => {
    let release!: () => void;
    const { service, thread } = setup(() => new Promise<void>((r) => (release = r)));
    const first = service.send({ threadId: thread.id, text: "one" });
    await new Promise((r) => setTimeout(r, 10));
    await expect(service.send({ threadId: thread.id, text: "two" })).rejects.toThrow(/already running/);
    release();
    await first;
  });

  it("remembers allow-always per agent and re-asks after a switch", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const updates: LiveUpdate[] = [];
    const decisions: string[] = [];
    const driver = (id: string): AgentDriver => ({
      id,
      label: id.toUpperCase(),
      defaultModel: "m1",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "",
      models: () => [{ id: "m1", label: "M1" }],
      async runTurn(input) {
        decisions.push(await input.requestPermission({ toolName: "Run", summary: "npm test", canAlwaysAllow: true }));
      },
    });
    const service = new Service(store, () => catalog(), [driver("a"), driver("b")], (u) => updates.push(u));
    const project = store.addProject(tempDir());
    const thread = service.createThread(project.id);

    const first = service.send({ threadId: thread.id, text: "one" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "permission") as Extract<LiveUpdate, { type: "permission" }>;
    service.respondPermission(req.request.requestId, "allow-always");
    await first;
    expect(updates.filter((u) => u.type === "permission")).toHaveLength(1);

    await service.send({ threadId: thread.id, text: "two" });
    expect(updates.filter((u) => u.type === "permission")).toHaveLength(1);
    expect(decisions[1]).toBe("allow-once");

    service.updateThread(thread.id, { agent: "b" });
    const third = service.send({ threadId: thread.id, text: "three" });
    await new Promise((r) => setTimeout(r, 10));
    expect(updates.filter((u) => u.type === "permission")).toHaveLength(2);
    service.interrupt(thread.id);
    await third;
  });

  it("records an expected session rebuild as a non-miss on the next turn", async () => {
    let turns = 0;
    const { store, service, thread } = setup(async (input) => {
      turns++;
      if (turns === 2) input.onSessionRebuilt?.();
      input.onEvent({
        kind: "turn-end",
        costUsd: null,
        inputTokens: 100,
        outputTokens: 1,
        durationMs: 1,
        usage: normalizeUsage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 50_000 }),
      });
    });
    await service.send({ threadId: thread.id, text: "one" });
    await service.send({ threadId: thread.id, text: "two" });

    const ends = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "turn-end" }> => e.kind === "turn-end");
    expect(ends).toHaveLength(2);
    expect(ends[0]!.usage).toMatchObject({ miss: false });
    expect(ends[0]!.usage?.missCause).toBeUndefined();
    expect(ends[1]!.usage).toMatchObject({ miss: false, missCause: "session-rebuild" });
  });

  it("passes the chosen effort and clears an unsupported one on a model switch", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const seen: (string | null | undefined)[] = [];
    const driver: AgentDriver = {
      id: "fake",
      label: "Fake",
      defaultModel: "m1",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "",
      models: () => [
        { id: "m1", label: "M1", efforts: ["low", "high"] },
        { id: "m2", label: "M2", efforts: ["low"] },
      ],
      async runTurn(input) {
        seen.push(input.effort);
      },
    };
    const service = new Service(store, () => catalog(), [driver], () => {});
    const project = store.addProject(tempDir());
    const thread = service.createThread(project.id);

    service.updateThread(thread.id, { effort: "high" });
    expect(store.getThread(thread.id).effort).toBe("high");
    await service.send({ threadId: thread.id, text: "one" });
    expect(seen).toEqual(["high"]);

    // The new model doesn't offer "high": the effort goes back to the default.
    service.updateThread(thread.id, { model: "m2" });
    expect(store.getThread(thread.id).effort).toBeNull();

    // A supported effort survives the switch.
    service.updateThread(thread.id, { effort: "low" });
    service.updateThread(thread.id, { model: "m1" });
    expect(store.getThread(thread.id).effort).toBe("low");
  });
});

describe("titleFrom", () => {
  it("uses the first line, prefixed with the skill", () => {
    expect(titleFrom("Fix the bug\nmore", undefined)).toBe("Fix the bug");
    expect(titleFrom("ticket 3", "implement")).toBe("/implement ticket 3");
    expect(titleFrom("", "skilled-setup")).toBe("/skilled-setup");
    expect(titleFrom("x".repeat(80)).length).toBe(60);
  });
});
