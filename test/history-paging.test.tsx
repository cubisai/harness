import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventPage, StoredEvent, Thread, ThreadTotals } from "../src/shared/types";
import { HISTORY_PAGE, eventCount, mergeBySeq, useStore } from "../src/renderer/src/store";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p",
  kind: "chat",
  agent: "claude",
  title: "Thread",
  sessionId: null,
  bindings: {},
  model: "opus",
  effort: null,
  permissionMode: "ask",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const ev = (seq: number, text = `m${seq}`): StoredEvent => ({ seq, createdAt: 0, event: { kind: "user", text } });

const totals = (over: Partial<ThreadTotals> = {}): ThreadTotals => ({
  events: 100,
  turns: 4,
  inputTokens: 400,
  cacheReadTokens: 40,
  outputTokens: 200,
  costUsd: 0.4,
  lastSeq: 90,
  ...over,
});

describe("mergeBySeq", () => {
  it("dedupes by seq, sorts ascending, and keeps a later list's copy", () => {
    const merged = mergeBySeq([ev(3), ev(1)], [ev(2), ev(3, "page")]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((merged[2]!.event as { text: string }).text).toBe("page");
  });

  it("returns either list when the other is empty", () => {
    expect(mergeBySeq([], [ev(5)]).map((e) => e.seq)).toEqual([5]);
    expect(mergeBySeq([ev(5)], []).map((e) => e.seq)).toEqual([5]);
  });
});

describe("eventCount", () => {
  it("uses the server total plus events past it, never below what's loaded", () => {
    const t = totals({ events: 50, lastSeq: 40 });
    expect(eventCount(undefined, null)).toBe(0);
    expect(eventCount([ev(1), ev(2)], null)).toBe(2);
    expect(eventCount([ev(38), ev(39)], t)).toBe(50);
    expect(eventCount([ev(38), ev(41), ev(42)], t)).toBe(52);
    expect(eventCount([ev(1), ev(2)], totals({ events: 0, lastSeq: 0 }))).toBe(2);
  });
});

describe("selectThread paging", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a history page and the thread's totals", async () => {
    const page: EventPage = { events: [ev(10), ev(11)], firstSeq: 10, hasMore: true };
    const t = totals();
    const listEventsPage = vi.fn(async () => page);
    const threadTotals = vi.fn(async () => t);
    vi.stubGlobal("window", { unskilled: { listEventsPage, threadTotals } });
    useStore.setState({ threads: { p: [thread()] }, events: {}, history: {} });

    await useStore.getState().selectThread("t1");

    expect(listEventsPage).toHaveBeenCalledWith("t1", { minEvents: HISTORY_PAGE });
    expect(threadTotals).toHaveBeenCalledWith("t1");
    expect(useStore.getState().events.t1?.map((e) => e.seq)).toEqual([10, 11]);
    expect(useStore.getState().history.t1).toEqual({ firstSeq: 10, hasMore: true, loadingOlder: false, totals: t });
  });

  it("keeps a live event that lands while the page loads", async () => {
    let resolvePage!: (page: EventPage) => void;
    const listEventsPage = vi.fn(() => new Promise<EventPage>((res) => (resolvePage = res)));
    const threadTotals = vi.fn(async () => totals());
    vi.stubGlobal("window", { unskilled: { listEventsPage, threadTotals } });
    useStore.setState({ threads: { p: [thread()] }, events: {}, history: {} });

    const pending = useStore.getState().selectThread("t1");
    // The turn's newest event arrives over IPC before the page request resolves.
    useStore.getState().apply({ type: "event", threadId: "t1", stored: ev(12) });
    resolvePage({ events: [ev(10), ev(11)], firstSeq: 10, hasMore: true });
    await pending;

    expect(useStore.getState().events.t1?.map((e) => e.seq)).toEqual([10, 11, 12]);
    expect(useStore.getState().events.t1?.some((e) => (e.event as { text: string }).text === "m12")).toBe(true);
  });
});

describe("loadOlder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prepends the older page, deduped, and updates firstSeq and hasMore", async () => {
    const listEventsPage = vi.fn(async () => ({ events: [ev(10), ev(11), ev(20)], firstSeq: 10, hasMore: false }));
    vi.stubGlobal("window", { unskilled: { listEventsPage } });
    useStore.setState({
      threads: { p: [thread()] },
      events: { t1: [ev(20), ev(21)] },
      history: { t1: { firstSeq: 20, hasMore: true, loadingOlder: false, totals: totals() } },
    });

    await useStore.getState().loadOlder("t1");

    expect(listEventsPage).toHaveBeenCalledWith("t1", { beforeSeq: 20, minEvents: HISTORY_PAGE });
    expect(useStore.getState().events.t1?.map((e) => e.seq)).toEqual([10, 11, 20, 21]);
    expect(useStore.getState().history.t1).toMatchObject({ firstSeq: 10, hasMore: false, loadingOlder: false });
  });

  it("does nothing when there is no older page or one is already loading", async () => {
    const listEventsPage = vi.fn(async () => ({ events: [], firstSeq: 0, hasMore: false }));
    vi.stubGlobal("window", { unskilled: { listEventsPage } });
    useStore.setState({
      events: { t1: [ev(1)] },
      history: { t1: { firstSeq: 1, hasMore: false, loadingOlder: false, totals: totals() }, t2: { firstSeq: 5, hasMore: true, loadingOlder: true, totals: totals() } },
    });

    await useStore.getState().loadOlder("t1");
    await useStore.getState().loadOlder("t2");
    await useStore.getState().loadOlder("missing");

    expect(listEventsPage).not.toHaveBeenCalled();
  });

  it("leaves the window intact when the page request fails", async () => {
    const listEventsPage = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("window", { unskilled: { listEventsPage } });
    const t = totals();
    useStore.setState({
      events: { t1: [ev(20)] },
      history: { t1: { firstSeq: 20, hasMore: true, loadingOlder: false, totals: t } },
    });

    await useStore.getState().loadOlder("t1");

    expect(useStore.getState().events.t1?.map((e) => e.seq)).toEqual([20]);
    expect(useStore.getState().history.t1).toEqual({ firstSeq: 20, hasMore: true, loadingOlder: false, totals: t });
  });
});
