import { describe, expect, it } from "vitest";
import { elapsed, inboxModel, nthVisibleThread, shortTime, visibleThreads, waitingThreads } from "../src/renderer/src/sections";
import type { Thread } from "../src/shared/types";

const NOW = new Date(2026, 9, 2, 15, 0, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const thread = (id: string, projectId: string, ago: number, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId,
  agent: "claude",
  title: id,
  sessionId: null,
  bindings: {},
  model: "default",
  effort: null,
  permissionMode: "ask",
  createdAt: NOW - ago,
  updatedAt: NOW - ago,
  ...patch,
});

const ids = (list: Thread[]) => list.map((t) => t.id);

describe("inboxModel", () => {
  const threads = {
    p1: [thread("a", "p1", 5 * MIN), thread("b", "p1", 2 * DAY), thread("arch", "p1", MIN, { archived: true })],
    p2: [thread("c", "p2", MIN), thread("d", "p2", 3 * MIN, { pinned: true }), thread("e", "p2", 10 * DAY)],
    p3: [],
  };

  it("sorts every project's threads into Running, Pinned and Recent, newest first", () => {
    const m = inboxModel(["p1", "p2", "p3"], threads, { running: { b: true } });
    expect(ids(m.running)).toEqual(["b"]);
    expect(ids(m.pinned)).toEqual(["d"]);
    expect(ids(m.recent)).toEqual(["c", "a", "e"]);
    expect(m.groups.map((g) => [g.projectId, ids(g.threads)])).toEqual([
      ["p1", ["a"]],
      ["p2", ["c", "e"]],
      ["p3", []],
    ]);
    expect(ids(m.archived.p1!)).toEqual(["arch"]);
  });

  it("puts a thread waiting on the user under Running, and a running pin there too", () => {
    const m = inboxModel(["p1", "p2"], threads, { running: { d: true }, waiting: new Set(["e"]) });
    expect(ids(m.running)).toEqual(["d", "e"]);
    expect(ids(m.pinned)).toEqual([]);
  });

  it("orders the visible list Running, Pinned, then Recent grouped or flat, skipping closed groups", () => {
    const m = inboxModel(["p1", "p2"], threads, { running: { b: true } });
    expect(ids(visibleThreads(m, { groupByProject: true }))).toEqual(["b", "d", "a", "c", "e"]);
    expect(ids(visibleThreads(m, { groupByProject: false }))).toEqual(["b", "d", "c", "a", "e"]);
    expect(ids(visibleThreads(m, { groupByProject: true, collapsed: { p1: true } }))).toEqual(["b", "d", "c", "e"]);
    expect(nthVisibleThread(m, 3, { groupByProject: true })?.id).toBe("a");
    expect(nthVisibleThread(m, 9, { groupByProject: true })).toBeNull();
  });
});

describe("waitingThreads", () => {
  it("joins permissions and plans", () => {
    expect([...waitingThreads([{ threadId: "a" }], [{ threadId: "b" }, { threadId: "a" }])].sort()).toEqual(["a", "b"]);
  });
});

describe("row times", () => {
  it("reads now, minutes, hours today, yesterday, then dates", () => {
    expect(shortTime(NOW - 10_000, NOW)).toBe("now");
    expect(shortTime(NOW - 5 * MIN, NOW)).toBe("5m");
    expect(shortTime(NOW - 3 * 60 * MIN, NOW)).toBe("3h");
    expect(shortTime(NOW - 20 * 60 * MIN, NOW)).toBe("Yd");
    expect(shortTime(NOW - 40 * DAY, NOW)).toMatch(/\d/);
  });

  it("shows a running turn's elapsed time", () => {
    expect(elapsed(12_400)).toBe("12s");
    expect(elapsed(4 * MIN + 5_000)).toBe("4m");
    expect(elapsed(65 * MIN)).toBe("1h 5m");
  });
});
