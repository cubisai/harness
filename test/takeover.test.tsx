import { describe, expect, it, vi } from "vitest";
import { IDLE, takeOverReducer } from "../src/renderer/src/takeover";

describe("takeOverReducer", () => {
  it("counts agent actions from idle", () => {
    const one = takeOverReducer(IDLE, { type: "agent-action" });
    expect(one.mode).toBe("agent-driving");
    expect(one.steps).toBe(1);
    expect(takeOverReducer(one, { type: "agent-action" }).steps).toBe(2);
  });

  it("gives the lock to a human input and holds it there", () => {
    const driving = takeOverReducer(IDLE, { type: "agent-action" });
    const taken = takeOverReducer(driving, { type: "human-input" });
    expect(taken.mode).toBe("human-driving");
    expect(taken.paused).toBe(true);
    // The paused agent can't take the pointer back; a second input changes nothing.
    expect(takeOverReducer(taken, { type: "agent-action" })).toBe(taken);
    expect(takeOverReducer(taken, { type: "human-input" })).toBe(taken);
  });

  it("resume hands the pointer back only from human-driving", () => {
    const driving = takeOverReducer(IDLE, { type: "agent-action" });
    const taken = takeOverReducer(driving, { type: "human-input" });
    const resumed = takeOverReducer(taken, { type: "resume" });
    expect(resumed.mode).toBe("agent-driving");
    expect(resumed.paused).toBe(false);
    expect(takeOverReducer(IDLE, { type: "resume" })).toBe(IDLE);
    expect(takeOverReducer(driving, { type: "resume" })).toBe(driving);
  });

  it("watch mode never leaves agent-driving", () => {
    const watching = takeOverReducer(IDLE, { type: "watch", on: true });
    const driving = takeOverReducer(watching, { type: "agent-action" });
    expect(takeOverReducer(driving, { type: "human-input" })).toBe(driving);
  });

  it("stop and turn-ended reset to idle but keep the watch flag", () => {
    const watching = takeOverReducer(IDLE, { type: "watch", on: true });
    const driving = takeOverReducer(watching, { type: "agent-action" });
    const stopped = takeOverReducer(driving, { type: "stop" });
    expect(stopped.mode).toBe("idle");
    expect(stopped.watch).toBe(true);
    const turned = takeOverReducer(driving, { type: "turn-ended" });
    expect(turned.mode).toBe("idle");
    expect(turned.watch).toBe(true);
  });
});

describe("takeOver store actions", () => {
  it("agent-action lands via apply; browserInput pauses; stopAgent interrupts and resumes", async () => {
    const fakeApi = {
      browserTakeOver: vi.fn(() => Promise.resolve()),
      interrupt: vi.fn(() => Promise.resolve()),
      listAgents: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("window", { unskilled: fakeApi });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ selectedThreadId: "t1", running: { t1: true }, takeOver: IDLE });

    useStore.getState().apply({ type: "browser-action", action: "click", url: "https://x.test" });
    expect(useStore.getState().takeOver.mode).toBe("agent-driving");

    useStore.getState().browserInput();
    expect(useStore.getState().takeOver.mode).toBe("human-driving");
    expect(fakeApi.browserTakeOver).toHaveBeenCalledWith(true);

    await useStore.getState().stopAgent();
    expect(fakeApi.interrupt).toHaveBeenCalledWith("t1");
    expect(fakeApi.browserTakeOver).toHaveBeenCalledWith(false);
    expect(useStore.getState().takeOver.mode).toBe("idle");
    vi.unstubAllGlobals();
  });
});
