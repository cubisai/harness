import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { segmentEvents } from "../src/renderer/src/turns";
import { makeHistory, seedStore } from "../scripts/history-fixtures";
import type { ThreadEvent } from "../src/shared/types";
import { closeAfter, tempDir } from "./helpers";

const isRoot = (e: ThreadEvent): boolean => !e.parentId;

describe("makeHistory", () => {
  it("is exactly `events` long, deterministic, and differs by seed", () => {
    const a = makeHistory({ events: 500, seed: 9 });
    const b = makeHistory({ events: 500, seed: 9 });
    const c = makeHistory({ events: 500, seed: 10 });
    expect(a).toHaveLength(500);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("matches every tool-result to an earlier tool-use and closes every root turn", () => {
    const events = makeHistory({ events: 2000, seed: 11 });
    const seen = new Set<string>();
    const starts: number[] = [];
    const ends: number[] = [];
    events.forEach((e, i) => {
      if (e.kind === "tool-use") seen.add(e.toolUseId);
      if (e.kind === "tool-result") expect(seen.has(e.toolUseId)).toBe(true);
      if (e.kind === "turn-start" && isRoot(e)) starts.push(i);
      if (e.kind === "turn-end" && isRoot(e)) ends.push(i);
    });
    const paired = Math.min(starts.length, ends.length);
    for (let i = 0; i < paired; i++) expect(starts[i]!).toBeLessThan(ends[i]!);
    // Only the truncated last turn may lack its turn-end.
    expect(starts.length - ends.length).toBeGreaterThanOrEqual(0);
    expect(starts.length - ends.length).toBeLessThanOrEqual(1);
  });

  it("carries parentId on child events when subagents are on", () => {
    const events = makeHistory({ events: 3000, seed: 7, subagents: true });
    expect(events.some((e) => e.parentId)).toBe(true);
    // Each child points at the root task call that spawned it.
    const tasks = new Set(events.flatMap((e) => (e.kind === "tool-use" && e.name === "task" && !e.parentId ? [e.toolUseId] : [])));
    for (const e of events) if (e.parentId) expect(tasks.has(e.parentId)).toBe(true);
  });
});

describe("seedStore", () => {
  it("seeds the big thread and extra projects", () => {
    const store = new Store(join(tempDir(), "fixtures.db"));
    closeAfter(() => store.close());
    const { threadId } = seedStore(store, { events: 1000, seed: 4 }, { projects: 2, threadsPerProject: 3 });

    const events = store.listEvents(threadId);
    expect(events).toHaveLength(1000);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    expect(store.listProjects()).toHaveLength(3);
    expect(segmentEvents(events, false).length).toBeGreaterThan(0);
  }, 45_000); // I/O-bound seeding: it once passed 15 s on a slow Windows runner.
});
