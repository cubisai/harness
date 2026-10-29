import { describe, expect, it } from "vitest";
import type { StoredEvent, Usage } from "../src/shared/types";
import { cacheStats } from "../src/shared/cache-stats";
import { cacheMeterText } from "../src/renderer/src/components/CacheMeter";

function usage(over: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheTtl: null,
    hitRate: null,
    miss: false,
    provenance: "reported",
    ...over,
  };
}

function turnEnd(seq: number, createdAt: number, over: Partial<Usage> = {}): StoredEvent {
  return { seq, createdAt, event: { kind: "turn-end", costUsd: null, inputTokens: usage(over).inputTokens, outputTokens: 0, durationMs: 0, usage: usage(over) } };
}

describe("cacheMeterText", () => {
  it("is quiet before any turn-end usage", () => {
    const stats = cacheStats([{ seq: 1, createdAt: 0, event: { kind: "user", text: "hi" } }], 0);
    expect(stats.turns).toBe(0);
    expect(cacheMeterText(stats)).toBeNull();
  });

  it("says so when the agent never reports cache reads", () => {
    const stats = cacheStats([turnEnd(1, 1_000, { inputTokens: 500 })], 2_000);
    expect(stats.reported).toBe(false);
    expect(cacheMeterText(stats)).toBe("cache —");
  });

  it("shows one percentage when reported", () => {
    const stats = cacheStats([turnEnd(1, 1_000, { inputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 200 })], 2_000);
    expect(cacheMeterText(stats)).toBe("cache 97%");
  });

  it("flags a miss on the newest turn", () => {
    const stats = cacheStats(
      [turnEnd(1, 1_000, { inputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 9000, miss: true, missCause: "tool-definitions" })],
      2_000,
    );
    expect(cacheMeterText(stats)).toMatch(/ · miss$/);
  });
});
