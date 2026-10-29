// The rollback figures: computed locally from persisted turn-end usage
// (Store.turnUsage reads the windows; nothing here reaches the network).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import {
  cumulativeHitRate,
  HIT_RATE_TRIGGER,
  hitRateRegression,
  PREFIX_TRIGGER,
  prefixStability,
} from "../src/main/cache-policy";
import type { Usage } from "../src/shared/types";
import { closeAfter, tempDir } from "./helpers";

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

function turnEnd(u: Usage): { kind: "turn-end"; costUsd: null; inputTokens: number; outputTokens: number; durationMs: number; usage: Usage } {
  return { kind: "turn-end", costUsd: null, inputTokens: u.inputTokens, outputTokens: u.outputTokens, durationMs: 0, usage: u };
}

describe("cumulativeHitRate", () => {
  it("weights turns by size, not by the mean of the per-turn rates", () => {
    // Per turn 90/100 and 0/1000, so the mean of the two rates would be 0.45;
    // cumulatively only 90 of 1100 processed tokens were cache reads.
    const turns = [
      usage({ cacheReadTokens: 90, cacheWriteTokens: 0, inputTokens: 10 }),
      usage({ cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1000 }),
    ];
    expect(cumulativeHitRate(turns)).toBe(90 / 1100);
    expect(cumulativeHitRate(turns)).not.toBe(0.45);
  });

  it("ignores turns that didn't report cache reads", () => {
    const reported = usage({ cacheReadTokens: 800, cacheWriteTokens: 0, inputTokens: 200 });
    expect(cumulativeHitRate([usage({ inputTokens: 5000 }), reported])).toBe(0.8);
  });

  it("is null with nothing to compare", () => {
    expect(cumulativeHitRate([])).toBeNull();
    expect(cumulativeHitRate([usage({ inputTokens: 500 })])).toBeNull();
    expect(cumulativeHitRate([usage({ cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0 })])).toBeNull();
  });
});

describe("hitRateRegression", () => {
  const baseline = [usage({ cacheReadTokens: 800, cacheWriteTokens: 0, inputTokens: 200 })]; // 0.80

  it("trips on a 6 pp drop and passes a 4 pp one", () => {
    const regressed = hitRateRegression(baseline, [usage({ cacheReadTokens: 740, cacheWriteTokens: 0, inputTokens: 260 })]);
    expect(regressed.baseline).toBe(0.8);
    expect(regressed.current).toBe(0.74);
    expect(regressed.delta).toBeCloseTo(-0.06, 10);
    expect(regressed.pass).toBe(false);

    const ok = hitRateRegression(baseline, [usage({ cacheReadTokens: 760, cacheWriteTokens: 0, inputTokens: 240 })]);
    expect(ok.current).toBe(0.76);
    expect(ok.delta).toBeCloseTo(-0.04, 10);
    expect(ok.delta!).toBeGreaterThan(HIT_RATE_TRIGGER);
    expect(ok.pass).toBe(true);
  });

  it("has no verdict when either window has no reported turns", () => {
    expect(hitRateRegression([], baseline)).toEqual({ baseline: null, current: 0.8, delta: null, pass: null });
    expect(hitRateRegression(baseline, [])).toEqual({ baseline: 0.8, current: null, delta: null, pass: null });
    expect(hitRateRegression(baseline, [usage({ inputTokens: 100 })])).toEqual({ baseline: 0.8, current: null, delta: null, pass: null });
  });
});

describe("prefixStability", () => {
  const window = (misses: number): Usage[] =>
    Array.from({ length: 200 }, (_, i) => usage({ cacheReadTokens: 1000, inputTokens: 10, miss: i < misses }));

  it("passes at the trigger and fails above it", () => {
    expect(prefixStability(window(2))).toEqual({ turns: 200, unstable: 2, rate: 2 / 200, pass: true });
    expect(2 / 200).toBe(PREFIX_TRIGGER);
    expect(prefixStability(window(3))).toEqual({ turns: 200, unstable: 3, rate: 3 / 200, pass: false });
  });

  it("counts an empty window as stable", () => {
    expect(prefixStability([])).toEqual({ turns: 0, unstable: 0, rate: 0, pass: true });
  });
});

describe("Store.turnUsage", () => {
  it("collects every thread's turn-end usage inside the window", () => {
    const store = new Store(join(tempDir(), "turn-usage.db"));
    closeAfter(() => store.close());
    const p = store.addProject("/tmp/p");
    const a = store.createThread(p.id, "claude", "claude-opus-5", "ask");
    const b = store.createThread(p.id, "claude", "claude-opus-5", "ask");

    store.appendEvent(a.id, turnEnd(usage({ cacheReadTokens: 800, cacheWriteTokens: 100, inputTokens: 100 })));
    store.appendEvent(b.id, { kind: "user", text: "hi" });
    store.appendEvent(b.id, { kind: "turn-end", costUsd: null, inputTokens: 50, outputTokens: 2, durationMs: 4 });
    store.appendEvent(b.id, turnEnd(usage({ cacheReadTokens: 700, cacheWriteTokens: 0, inputTokens: 300 })));

    // appendEvent stamps created_at with Date.now(), so the window has to end in the future.
    const inside = store.turnUsage(0, Date.now() + 1000);
    expect(inside.map((r) => r.usage.cacheReadTokens).sort()).toEqual([700, 800]);
    expect(inside.map((r) => r.threadId).sort()).toEqual([a.id, b.id].sort());
    expect(inside.every((r) => Number.isInteger(r.createdAt))).toBe(true);

    const now = Date.now();
    expect(store.turnUsage(now + 1000, now + 2000)).toEqual([]);
  });
});
