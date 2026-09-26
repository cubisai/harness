import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredEvent, Usage } from "../src/shared/types";
import { MISS_WORDS, cacheStats } from "../src/shared/cache-stats";

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("no network");
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  delete (globalThis as { window?: unknown }).window;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

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
  return {
    seq,
    createdAt,
    event: { kind: "turn-end", costUsd: null, inputTokens: usage(over).inputTokens, outputTokens: 0, durationMs: 0, usage: usage(over) },
  };
}

const NOW = 1_060_000;

/** Two reported turns, plus a user event and a notice that must not count. */
function fixture(): StoredEvent[] {
  return [
    { seq: 1, createdAt: 900_000, event: { kind: "user", text: "hi" } },
    turnEnd(2, 900_000, { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 9000 }),
    { seq: 3, createdAt: 950_000, event: { kind: "notice", text: "fyi" } },
    turnEnd(4, 1_000_000, { inputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 200, cacheTtl: "5m" }),
  ];
}

describe("cacheStats", () => {
  it("rolls up reported turns and stays warm inside the TTL", () => {
    const stats = cacheStats(fixture(), NOW);
    expect(stats.turns).toBe(2);
    expect(stats.reported).toBe(true);
    expect(stats.cacheReadTokens).toBe(9000);
    expect(stats.cacheWriteTokens).toBe(9200);
    expect(stats.sessionHitRate).toBeCloseTo(9000 / 19300);
    expect(stats.lastHitRate).toBeCloseTo(9000 / 9300);
    expect(stats.lastActivity).toBe(1_000_000);
    expect(stats.warm).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("goes cold once the TTL elapses", () => {
    expect(cacheStats(fixture(), 1_000_000 + 60_000).warm).toBe(true);
    expect(cacheStats(fixture(), 1_000_000 + 10 * 60_000).warm).toBe(false);
  });

  it("ignores threads with no turn-end usage", () => {
    const stats = cacheStats([{ seq: 1, createdAt: 5, event: { kind: "user", text: "hi" } }], NOW);
    expect(stats.turns).toBe(0);
    expect(stats.reported).toBe(false);
    expect(stats.lastActivity).toBeNull();
  });

  it("stays quiet when no turn reports cache reads", () => {
    const stats = cacheStats([turnEnd(1, 1_000, { inputTokens: 500 })], NOW);
    expect(stats.turns).toBe(1);
    expect(stats.reported).toBe(false);
    expect(stats.cacheReadTokens).toBe(0);
  });

  it("keeps the newest turn's true miss", () => {
    const stats = cacheStats(
      [turnEnd(1, 1_000, { inputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 9000, miss: true, missCause: "tool-definitions" })],
      NOW,
    );
    expect(stats.lastMiss).toEqual({ cause: "tool-definitions" });
    expect(MISS_WORDS["tool-definitions"]).toBe("tool definitions changed");
  });

  it("falls back to the unknown cause", () => {
    const stats = cacheStats([turnEnd(1, 1_000, { inputTokens: 100, cacheReadTokens: 500, miss: true })], NOW);
    expect(stats.lastMiss).toEqual({ cause: "unknown" });
  });
});
