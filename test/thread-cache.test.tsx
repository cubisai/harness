import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventPage, PermissionRequest, StoredEvent, Thread, ThreadTotals } from "../src/shared/types";
import { CACHE_THREADS, HISTORY_PAGE, evictable, useStore } from "../src/renderer/src/store";

const thread = (id: string): Thread => ({
  id,
  projectId: "p",
  kind: "chat",
  agent: "claude",
  title: id,
  sessionId: null,
  bindings: {},
  model: "opus",
  effort: null,
  permissionMode: "ask",
  createdAt: 0,
  updatedAt: 0,
});

const ev = (seq: number, text = `m${seq}`): StoredEvent => ({ seq, createdAt: 0, event: { kind: "user", text } });

const totals = (): ThreadTotals => ({ events: 1, turns: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, lastSeq: 1 });

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);

type StoreState = ReturnType<typeof useStore.getState>;

/** Reset the store's per-thread caches (and selection order) to a clean slate, then apply the test's seed. */
function seed(patch: Partial<StoreState> = {}): void {
  useStore.setState({
    selectedProjectId: "p",
    selectedThreadId: null,
    selectedOrder: [],
    threads: {},
    events: {},
    history: {},
    artifactFiles: {},
    turnScores: {},
    live: {},
    running: {},
    permissions: [],
    plans: [],
    questions: [],
    outbox: {},
    finished: [],
    ...patch,
  });
}

/** The calls selectThread makes; each resolves a page that carries one event. */
function fakeApi(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listEventsPage: vi.fn(async (id: string): Promise<EventPage> => ({ events: [ev(1, id)], firstSeq: 1, hasMore: false })),
    threadTotals: vi.fn(async () => totals()),
    listArtifacts: vi.fn(async () => []),
    learnScores: vi.fn(async () => []),
    ...over,
  };
}

describe("evictable", () => {
  it("drops the oldest entries beyond the newest max", () => {
    expect(evictable(["a", "b", "c", "d"], new Set(), 2)).toEqual(["a", "b"]);
    expect(evictable(["a", "b", "c", "d"], new Set(), 1)).toEqual(["a", "b", "c"]);
  });

  it("never drops an id in keep", () => {
    expect(evictable(["a", "b", "c", "d"], new Set(["a", "c"]), 2)).toEqual(["b"]);
  });

  it("drops nothing at or under the cap", () => {
    expect(evictable(["a", "b"], new Set(), CACHE_THREADS)).toEqual([]);
    expect(evictable([], new Set(), CACHE_THREADS)).toEqual([]);
  });
});

describe("selectThread cache bound", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only the most recent threads' caches", async () => {
    const ten = ids(10);
    vi.stubGlobal("window", { unskilled: fakeApi() });
    seed({
      threads: { p: ten.map(thread) },
      artifactFiles: Object.fromEntries(ten.map((id) => [id, []])),
      turnScores: Object.fromEntries(ten.map((id) => [id, {}])),
    });

    for (const id of ten) await useStore.getState().selectThread(id);

    const s = useStore.getState();
    expect(s.selectedThreadId).toBe("t9");
    expect(s.selectedOrder).toEqual(ten.slice(2));
    for (const id of ten.slice(2)) {
      expect(s.events[id]).toBeDefined();
      expect(s.history[id]).toBeDefined();
      expect(s.artifactFiles[id]).toBeDefined();
      expect(s.turnScores[id]).toBeDefined();
    }
    for (const id of ten.slice(0, 2)) {
      expect(s.events[id]).toBeUndefined();
      expect(s.history[id]).toBeUndefined();
      expect(s.artifactFiles[id]).toBeUndefined();
      expect(s.turnScores[id]).toBeUndefined();
    }
  });

  it("keeps a running thread that was selected first", async () => {
    const ten = ids(10);
    vi.stubGlobal("window", { unskilled: fakeApi() });
    seed({ threads: { p: ten.map(thread) }, running: { t0: true } });

    for (const id of ten) await useStore.getState().selectThread(id);

    const s = useStore.getState();
    expect(s.events.t0).toBeDefined();
    expect(s.events.t1).toBeUndefined(); // the running thread holds t0's slot; t1 is what goes
    expect(s.events.t9).toBeDefined();
  });

  it("keeps a thread with a pending card", async () => {
    const ten = ids(10);
    vi.stubGlobal("window", { unskilled: fakeApi() });
    const ask: PermissionRequest = { requestId: "r0", threadId: "t0", toolName: "Bash", summary: "run", canAlwaysAllow: true };
    seed({ threads: { p: ten.map(thread) }, permissions: [ask] });

    for (const id of ten) await useStore.getState().selectThread(id);

    const s = useStore.getState();
    expect(s.events.t0).toBeDefined();
    expect(s.events.t1).toBeUndefined();
  });

  it("re-selects an evicted thread by loading its page again", async () => {
    const ten = ids(10);
    const api = fakeApi();
    vi.stubGlobal("window", { unskilled: api });
    seed({ threads: { p: ten.map(thread) }, artifactFiles: Object.fromEntries(ten.map((id) => [id, []])) });

    for (const id of ten) await useStore.getState().selectThread(id);
    expect(useStore.getState().events.t0).toBeUndefined();
    (api.listEventsPage as ReturnType<typeof vi.fn>).mockClear();

    await useStore.getState().selectThread("t0");

    expect(api.listEventsPage).toHaveBeenCalledWith("t0", { minEvents: HISTORY_PAGE });
    expect(useStore.getState().events.t0?.map((e) => e.seq)).toEqual([1]);
  });
});

describe("live events for unloaded threads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not cache one, and loads the page on selection", async () => {
    const stored = ev(9, "live");
    const listEventsPage = vi.fn(async (): Promise<EventPage> => ({ events: [stored], firstSeq: 9, hasMore: false }));
    vi.stubGlobal("window", { unskilled: fakeApi({ listEventsPage }) });
    seed({ threads: { p: [thread("t1"), thread("t2")] }, selectedThreadId: "t2" });

    useStore.getState().apply({ type: "event", threadId: "t1", stored });

    // Not loaded and not selected: the event stays out of `events` (live state still updates).
    expect(useStore.getState().events.t1).toBeUndefined();
    expect(useStore.getState().live.t1).toBeDefined();

    await useStore.getState().selectThread("t1");

    expect(listEventsPage).toHaveBeenCalledWith("t1", { minEvents: HISTORY_PAGE });
    expect(useStore.getState().events.t1?.map((e) => e.seq)).toEqual([9]);
  });

  it("still appends for a loaded thread, ignoring a duplicate seq", () => {
    vi.stubGlobal("window", { unskilled: fakeApi() });
    seed({ threads: { p: [thread("t1")] }, events: { t1: [ev(1)] } });

    useStore.getState().apply({ type: "event", threadId: "t1", stored: ev(2) });
    useStore.getState().apply({ type: "event", threadId: "t1", stored: ev(2) });

    expect(useStore.getState().events.t1?.map((e) => e.seq)).toEqual([1, 2]);
  });
});
