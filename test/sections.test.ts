import { describe, expect, it } from "vitest";
import { nthVisibleThread, SETTLE_AFTER_MS, sectionThreads } from "../src/renderer/src/sections";
import type { Thread } from "../src/shared/types";

const NOW = 10 * SETTLE_AFTER_MS;
const DAY = SETTLE_AFTER_MS / 3;

const thread = (id: string, ago: number): Thread => ({
  id,
  projectId: "p",
  agent: "claude",
  title: id,
  sessionId: null,
  bindings: {},
  model: "default",
  permissionMode: "ask",
  createdAt: NOW - ago,
  updatedAt: NOW - ago,
});

const names = (list: { name: string; threads: Thread[] }[]) => list.map((s) => [s.name, s.threads.map((t) => t.id)]);

describe("sectionThreads", () => {
  const threads = [thread("old", 4 * DAY), thread("new", 1_000), thread("mid", 2 * DAY), thread("older", 5 * DAY)];

  it("puts threads idle over three days under Settled, the rest under Active, newest first", () => {
    expect(names(sectionThreads(threads, { running: {}, pinned: {}, now: NOW }))).toEqual([
      ["Active", ["new", "mid"]],
      ["Settled", ["old", "older"]],
    ]);
  });

  it("keeps a running thread Active however old, and pins above both", () => {
    expect(names(sectionThreads(threads, { running: { older: true }, pinned: { mid: true }, now: NOW }))).toEqual([
      ["Pinned", ["mid"]],
      ["Active", ["new", "older"]],
      ["Settled", ["old"]],
    ]);
  });

  it("settles exactly past three days", () => {
    const edge = [thread("at", SETTLE_AFTER_MS), thread("past", SETTLE_AFTER_MS + 1)];
    expect(names(sectionThreads(edge, { running: {}, pinned: {}, now: NOW }))).toEqual([
      ["Active", ["at"]],
      ["Settled", ["past"]],
    ]);
  });

  it("leaves out empty sections", () => {
    expect(sectionThreads([], { running: {}, pinned: {}, now: NOW })).toEqual([]);
  });
});

describe("nthVisibleThread", () => {
  const threads = [thread("a", 1), thread("b", 2), thread("c", 5 * DAY)];
  const input = { running: {}, pinned: { c: true }, now: NOW };

  it("counts in section order", () => {
    expect(nthVisibleThread(threads, 1, input)?.id).toBe("c");
    expect(nthVisibleThread(threads, 3, input)?.id).toBe("b");
  });

  it("is null past the end", () => {
    expect(nthVisibleThread(threads, 9, input)).toBeNull();
  });
});
