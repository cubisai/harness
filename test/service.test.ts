import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveUpdate } from "../src/shared/types";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { Store } from "../src/main/db";
import { Service, titleFrom } from "../src/main/service";
import { catalog, closeAfter, tempDir } from "./helpers";

function fakeDriver(script: (input: TurnInput) => Promise<void>): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake",
    label: "Fake",
    defaultModel: "fake-1",
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
  const service = new Service(store, catalog(), [driver], (u) => updates.push(u));
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
});

describe("titleFrom", () => {
  it("uses the first line, prefixed with the skill", () => {
    expect(titleFrom("Fix the bug\nmore", undefined)).toBe("Fix the bug");
    expect(titleFrom("ticket 3", "implement")).toBe("/implement ticket 3");
    expect(titleFrom("", "skilled-setup")).toBe("/skilled-setup");
    expect(titleFrom("x".repeat(80)).length).toBe(60);
  });
});
