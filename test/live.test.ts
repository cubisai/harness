import { describe, expect, it } from "vitest";
import type { LiveDelta, StoredEvent, ThreadEvent } from "../src/shared/types";
import { LIVE_ITEM_CAP, appendDelta, applyLiveEvent, emptyLive, flushPending, liveReasoningMode, reasoningChannel, visibleItems } from "../src/renderer/src/live";

const stored = (seq: number, event: ThreadEvent): StoredEvent => ({ seq, event, createdAt: 0 });

describe("live stream state", () => {
  it("batches pending text until a flush", () => {
    const delta = (text: string): LiveDelta => ({ kind: "text-delta", itemId: "a", text });
    let state = emptyLive();
    for (const text of ["Hel", "lo", " world"]) state = appendDelta(state, delta(text));
    expect(visibleItems(state, "text")).toEqual([]); // still pending
    const items = visibleItems(flushPending(state), "text");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("Hello world");
  });

  it("shows no reasoning block for whitespace-only reasoning", () => {
    let state = emptyLive();
    for (const id of ["r1", "r2"]) state = appendDelta(state, { kind: "reasoning-delta", itemId: id, text: "\n" } as LiveDelta);
    state = flushPending(state);
    expect(visibleItems(state, "reasoning")).toEqual([]);
    expect(liveReasoningMode(state)).toBe("none");
    state = flushPending(appendDelta(state, { kind: "reasoning-delta", itemId: "r1", text: "Now the schema." } as LiveDelta));
    expect(visibleItems(state, "reasoning")).toHaveLength(1);
  });

  it("keeps streaming text when a mid-turn tool-use lands", () => {
    let state = appendDelta(emptyLive(), { kind: "text-delta", itemId: "a", text: "hello" });
    state = flushPending(state);
    state = applyLiveEvent(state, stored(1, { kind: "tool-use", toolUseId: "t1", name: "Read", summary: "src/a.ts", itemId: "b" }));
    expect(visibleItems(state, "text").map((i) => i.text)).toEqual(["hello"]);
  });

  it("drops a late delta once the terminal assistant-text lands", () => {
    let state = appendDelta(emptyLive(), { kind: "text-delta", itemId: "a", text: "Hello world" });
    state = flushPending(state);
    const done = applyLiveEvent(state, stored(2, { kind: "assistant-text", text: "Hello world", itemId: "a" }));
    expect(visibleItems(done, "text")).toEqual([]);
    expect(appendDelta(done, { kind: "text-delta", itemId: "a", text: "!" })).toBe(done);
  });

  it("clears every text item for a terminal event without an itemId, keeping reasoning", () => {
    let state = appendDelta(emptyLive(), { kind: "text-delta", itemId: "a", text: "hi" });
    state = appendDelta(state, { kind: "reasoning-delta", itemId: "r", text: "why" });
    state = flushPending(state);
    const done = applyLiveEvent(state, stored(3, { kind: "assistant-text", text: "hi" }));
    expect(visibleItems(done, "text")).toEqual([]);
    expect(visibleItems(done, "reasoning").map((i) => i.text)).toEqual(["why"]);
  });

  it("caps an item at LIVE_ITEM_CAP chars, keeping the tail", () => {
    const text = "a".repeat(LIVE_ITEM_CAP) + "0123456789";
    let state = appendDelta(emptyLive(), { kind: "text-delta", itemId: "a", text });
    state = flushPending(state);
    const item = visibleItems(state, "text")[0]!;
    expect(item.text).toHaveLength(LIVE_ITEM_CAP);
    expect(item.text.endsWith("0123456789")).toBe(true);
  });

  it("merges usage-update deltas into the live usage", () => {
    let state = appendDelta(emptyLive(), { kind: "usage-update", cacheReadTokens: 100 });
    expect(state.usage?.cacheReadTokens).toBe(100);
    state = appendDelta(state, { kind: "usage-update", outputTokens: 5 });
    expect(state.usage?.cacheReadTokens).toBe(100);
    expect(state.usage?.outputTokens).toBe(5);
  });
});

describe("reasoning display", () => {
  it("maps opacity onto exactly one channel", () => {
    for (const opaque of [false, true]) {
      const channel = reasoningChannel({ opaque });
      expect(["text", "tokens"]).toContain(channel);
      expect(channel).not.toBe("both");
    }
    expect(reasoningChannel({ opaque: false })).toBe("text");
    expect(reasoningChannel({ opaque: true })).toBe("tokens");
  });

  it("shows nothing, then tokens, then text once a flush lands", () => {
    expect(liveReasoningMode(emptyLive())).toBe("none");
    expect(liveReasoningMode({ ...emptyLive(), thinkingTokens: 50 })).toBe("tokens");
    const flushed = flushPending(appendDelta({ ...emptyLive(), thinkingTokens: 50 }, { kind: "reasoning-delta", itemId: "r", text: "why", opaque: false }));
    expect(liveReasoningMode(flushed)).toBe("text");
    expect(liveReasoningMode(flushed)).not.toBe("tokens");
  });
});
