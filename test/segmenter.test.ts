import { describe, expect, it } from "vitest";
import { createSegmenter, segmentEvents } from "../src/renderer/src/turns";
import { makeHistory } from "../scripts/history-fixtures";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

/** makeHistory yields bare ThreadEvents; the projection wants stored rows. */
const stored = (events: ThreadEvent[]): StoredEvent[] => events.map((event, i) => ({ seq: i + 1, createdAt: i * 1000, event }));
/** ThreadView drops a subagent's steps (parentId) before projecting. */
const root = (events: StoredEvent[]): StoredEvent[] => events.filter((e) => !e.event.parentId);

describe("createSegmenter", () => {
  it("matches segmentEvents on a 3000-event history with subagents", () => {
    const events = root(stored(makeHistory({ events: 3000, seed: 11, subagents: true })));
    expect(createSegmenter()(events, false)).toEqual(segmentEvents(events, false));
    expect(createSegmenter()(events, true)).toEqual(segmentEvents(events, true));
  });

  it("matches on every prefix, mid-turn cuts included, as running toggles", () => {
    const events = root(stored(makeHistory({ events: 800, seed: 5 })));
    const segmenter = createSegmenter();
    for (let n = 1; n <= events.length; n++) {
      const prefix = events.slice(0, n);
      expect(segmenter(prefix, true)).toEqual(segmentEvents(prefix, true));
      expect(segmenter(prefix, false)).toEqual(segmentEvents(prefix, false));
    }
  });

  it("matches when older pages are prepended", () => {
    const events = root(stored(makeHistory({ events: 2000, seed: 6, subagents: true })));
    const segmenter = createSegmenter();
    const tail = events.slice(-1000);
    expect(segmenter(tail, false)).toEqual(segmentEvents(tail, false));
    expect(segmenter(events, false)).toEqual(segmentEvents(events, false));
  });

  it("reuses closed turns when one event is appended to the open turn", () => {
    const all = root(stored(makeHistory({ events: 3000, seed: 11, subagents: true })));
    const cut = all.findIndex((e) => e.event.kind === "turn-end") + 3; // inside the second turn
    expect(all[cut]!.event.kind).not.toBe("turn-end");
    const rebuilt: string[] = [];
    const segmenter = createSegmenter((key) => rebuilt.push(key));
    const prefix = all.slice(0, cut);
    expect(segmenter(prefix, true)).toEqual(segmentEvents(prefix, true));
    expect(rebuilt.length).toBeGreaterThan(0);
    rebuilt.length = 0;
    const grown = all.slice(0, cut + 1);
    expect(segmenter(grown, true)).toEqual(segmentEvents(grown, true));
    expect(rebuilt).toEqual([]);
  });

  it("prints a 50k timing line (not asserted)", () => {
    const events = root(stored(makeHistory({ events: 50_000, seed: 3, subagents: true })));
    const before = performance.now();
    segmentEvents(events, true);
    const full = performance.now() - before;
    // Warm the segmenter on all but the last few events, then time the append.
    const segmenter = createSegmenter();
    const cut = events.length - 5;
    segmenter(events.slice(0, cut), true);
    const start = performance.now();
    segmenter(events, true);
    const append = performance.now() - start;
    console.log(`[segmenter] 50k events: segmentEvents ${full.toFixed(1)} ms, append ${append.toFixed(1)} ms`);
  });
});
