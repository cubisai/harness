import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

const at = (seq: number, event: ThreadEvent): StoredEvent => ({ seq, event, createdAt: seq });
const use = (seq: number, toolUseId: string, name: string) => at(seq, { kind: "tool-use", toolUseId, name, summary: "" });
const result = (seq: number, toolUseId: string, isError = false) => at(seq, { kind: "tool-result", toolUseId, isError, summary: "" });

describe("mayChangeFiles", () => {
  it("treats edits, commands and unknown tools as changing files, and look-only tools as not", async () => {
    vi.stubGlobal("window", { unskilled: {} });
    const { mayChangeFiles } = await import("../src/renderer/src/store");
    const events = [use(1, "a", "Edit"), use(2, "b", "Run"), use(3, "c", "Read"), use(4, "d", "Search"), use(5, "e", "fileChange"), use(6, "f", "TodoWrite")];
    expect(mayChangeFiles(events, "a")).toBe(true);
    expect(mayChangeFiles(events, "b")).toBe(true);
    expect(mayChangeFiles(events, "c")).toBe(false);
    expect(mayChangeFiles(events, "d")).toBe(false);
    expect(mayChangeFiles(events, "e")).toBe(true);
    expect(mayChangeFiles(events, "f")).toBe(false);
    expect(mayChangeFiles(events, "missing")).toBe(true);
    expect(mayChangeFiles(undefined, "a")).toBe(true);
  });
});

describe("store refreshes the diff mid-turn", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bumps diffVersion once after a burst of edit results, and not for a read", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { unskilled: {} });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ selectedThreadId: "t1", events: { t1: [use(1, "r", "Read"), use(2, "e1", "Edit"), use(3, "e2", "Edit")] }, diffVersion: 0 });
    const { apply } = useStore.getState();

    apply({ type: "event", threadId: "t1", stored: result(4, "r") });
    vi.advanceTimersByTime(400);
    expect(useStore.getState().diffVersion).toBe(0);

    apply({ type: "event", threadId: "t1", stored: result(5, "e1") });
    apply({ type: "event", threadId: "t1", stored: result(6, "e2") });
    expect(useStore.getState().diffVersion).toBe(0);
    vi.advanceTimersByTime(400);
    expect(useStore.getState().diffVersion).toBe(1);
  });
});
