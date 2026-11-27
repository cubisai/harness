import { describe, expect, it, vi } from "vitest";
import { IDLE, takeOverReducer } from "../src/renderer/src/takeover";
import { deferred } from "./helpers";
import type { BrowserState } from "../src/shared/types";

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
  it("shares a browser load, retries a failure, and keeps the live owner over the older reply", async () => {
    const reply = deferred<BrowserState>();
    const state: BrowserState = { owner: null, paused: false, logs: [{ level: "warning", text: "saved" }], device: "tablet", screenshots: [] };
    const browserState = vi.fn(() => reply.promise).mockRejectedValueOnce(new Error("disconnected"));
    vi.stubGlobal("window", { unskilled: { browserState } });
    const { useStore } = await import("../src/renderer/src/store");
    try {
      const load = useStore.getState().loadBrowserState;
      await Promise.all([load(), load()]);
      expect(browserState).toHaveBeenCalledTimes(1);
      expect(useStore.getState()).toMatchObject({ browserLoaded: false, notice: expect.stringContaining("disconnected") });
      const retry = load();
      const owner = { threadId: "a", turnId: "new" };
      useStore.getState().apply({ type: "browser-control", owner, paused: true });
      reply.resolve(state);
      await retry;
      expect(useStore.getState()).toMatchObject({ browserLoaded: true, browser: { ...state, owner, paused: true }, takeOver: { mode: "human-driving" } });
      useStore.getState().apply({ type: "browser-control", owner: null, paused: false });
      useStore.getState().apply({ type: "browser-action", owner, action: "open", url: "http://x.test" });
      expect(useStore.getState().takeOver).toMatchObject({ mode: "idle", steps: 0 });
    } finally { useStore.setState(useStore.getInitialState()); vi.unstubAllGlobals(); }
  });
  it("keeps the browser paused until main releases its owner, including when another thread is selected", async () => {
    const fakeApi = {
      browserTakeOver: vi.fn(() => Promise.resolve()),
      interrupt: vi.fn(() => Promise.resolve()),
      listAgents: vi.fn(() => Promise.resolve([])),
    };
    vi.stubGlobal("window", { unskilled: fakeApi });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ selectedThreadId: "t1", running: { t1: true }, takeOver: IDLE });

    const owner = { threadId: "t1", turnId: "turn-a" };
    useStore.getState().apply({ type: "browser-control", owner, paused: false });
    useStore.getState().apply({ type: "browser-action", action: "click", url: "https://x.test", owner });
    expect(useStore.getState().takeOver.mode).toBe("agent-driving");

    useStore.getState().browserInput();
    expect(useStore.getState().takeOver.mode).toBe("human-driving");
    expect(fakeApi.browserTakeOver).toHaveBeenCalledWith(true, owner);
    useStore.setState({ selectedThreadId: "t2" });
    useStore.getState().apply({ type: "running", threadId: "t2", running: false });
    expect(useStore.getState().takeOver.mode).toBe("human-driving");

    await useStore.getState().stopAgent();
    expect(fakeApi.interrupt).not.toHaveBeenCalled();
    expect(fakeApi.browserTakeOver).toHaveBeenCalledWith(false, owner, true);
    expect(useStore.getState().takeOver.mode).toBe("human-driving");
    useStore.getState().apply({ type: "browser-control", owner: null, paused: false });
    expect(useStore.getState().takeOver.mode).toBe("idle");
    vi.unstubAllGlobals();
  });
});
