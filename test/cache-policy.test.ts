import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpServerEntry, Usage } from "../src/shared/types";
import type { HarnessTool } from "../src/main/agents/types";
import {
  annotateUsage,
  claudeCompactEnv,
  classifyMiss,
  codexCompactConfig,
  COMPACT_AT,
  drainConfigChanges,
  fingerprint,
  forgetThread,
  isMiss,
  pinToolSet,
  pinnedFingerprint,
  queueConfigChange,
  shouldCompact,
  stableStringify,
  toolSetOf,
} from "../src/main/cache-policy";

const THREAD = "cache-policy-thread";

afterEach(() => {
  forgetThread(THREAD);
});

function tool(name: string, input: HarnessTool["input"] = {}): HarnessTool {
  return { name, description: `${name} description`, input, autoAllow: true, run: async () => ({ text: "" }) };
}

const docs: McpServerEntry = { name: "docs", enabled: true, spec: { type: "stdio", command: "docs-mcp", args: ["--stdio"] } };
const remote: McpServerEntry = { name: "remote", enabled: true, spec: { type: "http", url: "https://mcp.example.com/mcp" } };

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

describe("stableStringify", () => {
  it("sorts keys recursively, keeping array order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("tool set pinning", () => {
  it("fingerprints the same tools and servers regardless of input order", () => {
    const a = toolSetOf([tool("browser_click", { ref: z.string() }), tool("browser_open", { url: z.string() })], [docs, remote]);
    const b = toolSetOf([tool("browser_open", { url: z.string() }), tool("browser_click", { ref: z.string() })], [remote, docs]);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("only pins to a new set after the queued change drains", () => {
    const set = toolSetOf([tool("browser_open", { url: z.string() })], [docs]);
    pinToolSet(THREAD, set);
    const before = pinnedFingerprint(THREAD);
    expect(before).not.toBeNull();
    expect(pinnedFingerprint(THREAD)).toBe(before);
    expect(pinnedFingerprint(THREAD)).toBe(before);

    const changed = toolSetOf([tool("browser_open", { url: z.string(), tab: z.string() })], [docs]);
    queueConfigChange(THREAD, { set: changed });
    expect(pinnedFingerprint(THREAD)).toBe(before);

    const drained = drainConfigChanges(THREAD);
    expect(drained).toEqual([{ set: changed }]);
    expect(pinnedFingerprint(THREAD)).toBe(fingerprint(changed));
  });
});

describe("isMiss", () => {
  it("sits between an incremental append and a real miss", () => {
    expect(isMiss(100_000, 4_999)).toBe(false);
    expect(isMiss(100_000, 5_001)).toBe(true);
    expect(isMiss(10_000, 1_999)).toBe(false);
    expect(isMiss(10_000, 2_001)).toBe(true);
  });
});

describe("classifyMiss", () => {
  it("names the first signal, and whether the miss was expected", () => {
    expect(classifyMiss({ compacted: true })).toEqual({ cause: "compaction", expected: true });
    expect(classifyMiss({ toolFingerprintChanged: true, compacted: true })).toEqual({ cause: "tool-definitions", expected: false });
    expect(classifyMiss({})).toEqual({ cause: "unknown", expected: false });
  });
});

describe("annotateUsage", () => {
  it("leaves the first turn alone", () => {
    expect(annotateUsage(usage({ cacheWriteTokens: 50_000 }), { prev: null, idleMs: null, signals: {} })).toMatchObject({ miss: false });
  });

  it("calls a big write after a compaction an expected miss", () => {
    const prev = usage({ cacheReadTokens: 100_000, cacheTtl: "5m" });
    const result = annotateUsage(usage({ cacheWriteTokens: 50_000 }), { prev, idleMs: 0, signals: { compacted: true } });
    expect(result.miss).toBe(false);
    expect(result.missCause).toBe("compaction");
  });

  it("calls the same big write with no signal an unknown miss", () => {
    const prev = usage({ cacheReadTokens: 100_000, cacheTtl: "5m" });
    const result = annotateUsage(usage({ cacheWriteTokens: 50_000 }), { prev, idleMs: 0, signals: {} });
    expect(result.miss).toBe(true);
    expect(result.missCause).toBe("unknown");
  });

  it("records a rebuild that stayed cheap", () => {
    const prev = usage({ cacheReadTokens: 100_000, cacheTtl: "5m" });
    const result = annotateUsage(usage({ cacheWriteTokens: 100 }), { prev, idleMs: 0, signals: { sessionRebuilt: true } });
    expect(result.miss).toBe(false);
    expect(result.missCause).toBe("session-rebuild");
  });

  it("calls a big write after an expired TTL an expected miss", () => {
    const prev = usage({ cacheReadTokens: 100_000, cacheTtl: "5m" });
    const result = annotateUsage(usage({ cacheWriteTokens: 50_000 }), { prev, idleMs: 10 * 60_000, signals: {} });
    expect(result.miss).toBe(false);
    expect(result.missCause).toBe("ttl-expiry");
  });
});

describe("shouldCompact", () => {
  it("only compacts between turns, when the context is nearly full", () => {
    expect(shouldCompact({ remaining: 40_000, window: 200_000, atTurnBoundary: false })).toBe(false);
    expect(shouldCompact({ remaining: 40_000, window: 200_000, atTurnBoundary: true })).toBe(true);
    expect(shouldCompact({ remaining: 40_000, window: 200_000, atTurnBoundary: true, pendingSwitch: true })).toBe(false);
    expect(shouldCompact({ remaining: 40_000, window: 200_000, atTurnBoundary: true, justSwitched: true })).toBe(false);
    expect(shouldCompact({ remaining: 40_000, window: 200_000, atTurnBoundary: true, midToolCall: true })).toBe(false);
    expect(COMPACT_AT).toBe(0.2);
  });
});

describe("compaction knobs", () => {
  it("builds Codex's auto-compaction config", () => {
    expect(codexCompactConfig({ tokenLimit: 150_000 })).toEqual({
      model_auto_compact_token_limit: 150_000,
      model_auto_compact_token_limit_scope: "body_after_prefix",
    });
    expect(codexCompactConfig({ tokenLimit: 150_000 }).model_auto_compact_token_limit_scope).toBe("body_after_prefix");
  });

  it("clamps Claude's window into the supported range", () => {
    expect(claudeCompactEnv({ window: 50_000 }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
    expect(claudeCompactEnv({ window: 5_000_000 }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    const value = Number(claudeCompactEnv({ window: 250_000.4 }).CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(100_000);
    expect(value).toBeLessThanOrEqual(1_000_000);
  });

  it("passes through pct and ttl only when given", () => {
    expect(claudeCompactEnv({ window: 200_000, pct: 120, ttl: "1h" })).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "100",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    });
  });
});
