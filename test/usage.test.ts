import { describe, expect, it } from "vitest";
import { hitRate, normalizeUsage } from "../src/main/usage";

describe("hitRate", () => {
  it("is cacheRead over true processed input", () => {
    expect(hitRate({ cacheReadTokens: 800, cacheWriteTokens: 100, inputTokens: 100 })).toBe(0.8);
  });

  it("counts inputTokens as net-new in the denominator", () => {
    expect(hitRate({ cacheReadTokens: 500, cacheWriteTokens: 0, inputTokens: 500 })).toBe(0.5);
  });

  it("is null when the agent reports no cache reads", () => {
    expect(hitRate({ cacheReadTokens: null, cacheWriteTokens: 100, inputTokens: 100 })).toBeNull();
  });

  it("is null when nothing was processed", () => {
    expect(hitRate({ cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0 })).toBeNull();
  });
});

describe("normalizeUsage", () => {
  it("marks unreported cache reads as unavailable", () => {
    const usage = normalizeUsage({ inputTokens: 100, outputTokens: 10 });
    expect(usage.cacheReadTokens).toBeNull();
    expect(usage.cacheWriteTokens).toBeNull();
    expect(usage.reasoningTokens).toBeNull();
    expect(usage.cacheTtl).toBeNull();
    expect(usage.hitRate).toBeNull();
    expect(usage.miss).toBe(false);
    expect(usage.provenance).toBe("unavailable");
  });

  it("derives a hit rate and reports provenance when cache reads are present", () => {
    const usage = normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 100 });
    expect(usage.hitRate).toBe(0.8);
    expect(usage.provenance).toBe("reported");
  });

  it("keeps an explicit provenance", () => {
    const usage = normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 800, provenance: "estimated" });
    expect(usage.provenance).toBe("estimated");
  });
});
