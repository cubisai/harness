import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveUpdate, StoredEvent } from "../src/shared/types";
import type { AgentDriver, ModelSwitch, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { CODEX_DEFAULT_MODEL, createCodexDriver } from "../src/main/agents/codex";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { catalog, closeAfter, tempDir } from "./helpers";

interface FakeDriver extends AgentDriver {
  log: string[];
  switches: ModelSwitch[];
  sessions: (string | null)[];
}

function fakeDriver(result?: ModelSwitch): FakeDriver {
  const log: string[] = [];
  const switches: ModelSwitch[] = [];
  const sessions: (string | null)[] = [];
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
    async runTurn(input: TurnInput) {
      log.push("runTurn");
      sessions.push(input.sessionId);
      input.onSession("s1");
      input.onEvent({ kind: "assistant-text", text: "ok" });
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
  const service = new Service(store, catalog(), [driver], (u) => updates.push(u));
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
