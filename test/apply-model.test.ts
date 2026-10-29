import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveUpdate, StoredEvent } from "../src/shared/types";
import type { AgentDriver, ModelSwitch, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { CODEX_DEFAULT_MODEL, createCodexDriver } from "../src/main/agents/codex";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { normalizeUsage } from "../src/main/usage";
import { catalog, closeAfter, tempDir } from "./helpers";

interface FakeDriver extends AgentDriver {
  log: string[];
  switches: ModelSwitch[];
  sessions: (string | null)[];
  prompts: string[];
}

function fakeDriver(result?: ModelSwitch, run?: (input: TurnInput) => void): FakeDriver {
  const log: string[] = [];
  const switches: ModelSwitch[] = [];
  const sessions: (string | null)[] = [];
  const prompts: string[] = [];
  const driver: FakeDriver = {
    id: "fake",
    label: "Fake",
    defaultModel: "m1",
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "skilled:",
    models: () => [
      { id: "m1", label: "Model 1" },
      { id: "m2", label: "Model 2" },
    ],
    log,
    switches,
    sessions,
    prompts,
    async runTurn(input: TurnInput) {
      log.push("runTurn");
      sessions.push(input.sessionId);
      prompts.push(input.prompt);
      input.onSession("s1");
      input.onEvent({ kind: "assistant-text", text: "ok" });
      run?.(input);
    },
  };
  if (result) {
    driver.setModel = async () => {
      log.push("setModel");
      switches.push(result);
      return result;
    };
  }
  return driver;
}

function setup(driver: FakeDriver) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const updates: LiveUpdate[] = [];
  const service = new Service(store, () => catalog(), [driver], (u) => updates.push(u));
  const project = store.addProject(tempDir());
  const thread = service.createThread(project.id);
  return { store, service, driver, updates, thread };
}

function modelNotices(store: Store, threadId: string): StoredEvent[] {
  return store.listEvents(threadId).filter((e) => e.event.kind === "notice" && /model/i.test(e.event.text));
}

describe("Service.applyModel in send", () => {
  it("switches in place before the next turn and keeps the session", async () => {
    const { service, driver, thread, store } = setup(fakeDriver("in-place"));
    await service.send({ threadId: thread.id, text: "one" });
    service.updateThread(thread.id, { model: "m2" });
    await service.send({ threadId: thread.id, text: "two" });

    expect(driver.log).toEqual(["runTurn", "setModel", "runTurn"]);
    expect(driver.switches).toEqual(["in-place"]);
    expect(driver.sessions).toEqual([null, "s1"]);
    expect(store.getThread(thread.id).sessionId).toBe("s1");
    expect(modelNotices(store, thread.id)).toHaveLength(1);
  });

  it("falls back to a new session when the driver can't switch", async () => {
    const { service, driver, thread, store } = setup(fakeDriver());
    await service.send({ threadId: thread.id, text: "one" });
    service.updateThread(thread.id, { model: "m2" });
    await service.send({ threadId: thread.id, text: "two" });

    expect(driver.sessions).toEqual([null, null]);
    expect(modelNotices(store, thread.id)).toHaveLength(1);
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "notice" && /Now talking to/.test(e.event.text))).toBe(false);

    expect(await service.applyModel(thread.id, "m1", "m2")).toBe("unsupported");
  });

  it("clears the session when the switch needs a new one", async () => {
    const { service, driver, thread } = setup(fakeDriver("new-session"));
    await service.send({ threadId: thread.id, text: "one" });
    service.updateThread(thread.id, { model: "m2" });
    await service.send({ threadId: thread.id, text: "two" });

    expect(driver.sessions).toEqual([null, null]);
    expect(driver.switches).toEqual(["new-session"]);
  });

  it("hands the conversation over when the new session can't take it in place", async () => {
    const big = normalizeUsage({ inputTokens: 50_000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const driver = fakeDriver("new-session", (input) =>
      input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 50_000, outputTokens: 5, durationMs: 1, usage: big }),
    );
    const { service, thread, store } = setup(driver);
    await service.send({ threadId: thread.id, text: "one" });
    service.updateThread(thread.id, { model: "m2" });
    await service.send({ threadId: thread.id, text: "two" });

    // The earlier message arrives as the catch-up, then the new prompt after the separator.
    expect(driver.prompts[1]).toContain("one");
    expect(driver.prompts[1]).toContain("\n---\ntwo");
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "notice" && e.event.text.startsWith("Handed this thread's history to"))).toBe(true);
  });

  it("compares the model a turn was asked for, not the id the API resolved it to", async () => {
    const resolved = (input: TurnInput) => input.onEvent({ kind: "turn-start", turnId: "t", agent: "fake", model: "m1-2026-10-01" });
    const { service, driver, thread, store } = setup(fakeDriver("in-place", resolved));
    await service.send({ threadId: thread.id, text: "one" });
    await service.send({ threadId: thread.id, text: "two" });
    expect(driver.switches).toEqual([]);
    expect(modelNotices(store, thread.id)).toHaveLength(0);

    service.updateThread(thread.id, { model: "m2" });
    await service.send({ threadId: thread.id, text: "three" });
    expect(driver.switches).toEqual(["in-place"]);
    expect(modelNotices(store, thread.id)).toHaveLength(1);
  });

  it("doesn't switch when the model hasn't changed", async () => {
    const { service, driver, thread } = setup(fakeDriver("in-place"));
    await service.send({ threadId: thread.id, text: "one" });
    await service.send({ threadId: thread.id, text: "two" });

    expect(driver.log).toEqual(["runTurn", "runTurn"]);
    expect(driver.switches).toEqual([]);
  });
});

describe("Codex setModel", () => {
  it("classifies a switch and a return to the default", async () => {
    const driver = createCodexDriver({ command: "codex", args: ["app-server"], clientVersion: "t" });
    closeAfter(() => driver.dispose?.());
    expect(await driver.setModel!({ threadId: "t", sessionId: "s", from: "a", to: "gpt-x" })).toBe("in-place");
    expect(await driver.setModel!({ threadId: "t", sessionId: "s", from: "gpt-x", to: CODEX_DEFAULT_MODEL })).toBe("new-session");
  });
});
