import { describe, expect, it } from "vitest";
import { cacheReport, defaultDb, formatReport, type ReportRow } from "../scripts/cache-report";
import type { ThreadEvent, Usage } from "../src/shared/types";

const usage = (read: number | null, write: number, input: number, extra: Partial<Usage> = {}): Usage => ({
  inputTokens: input,
  outputTokens: 10,
  reasoningTokens: null,
  cacheReadTokens: read,
  cacheWriteTokens: write,
  cacheTtl: "5m",
  hitRate: null,
  miss: false,
  provenance: "reported",
  ...extra,
});
const start = (threadId: string, agent: string, model: string): ReportRow => ({ threadId, agent, event: { kind: "turn-start", turnId: "x", agent, model } });
const end = (threadId: string, agent: string, u: Usage | undefined, costUsd: number | null = null): ReportRow => ({
  threadId,
  agent,
  event: { kind: "turn-end", costUsd, inputTokens: u?.inputTokens ?? 5, outputTokens: 10, durationMs: 1, ...(u ? { usage: u } : {}) } as ThreadEvent,
});

describe("cacheReport", () => {
  it("rolls turns up per agent and the model each turn started with, with a warm rate that skips a thread's first turn", () => {
    const lines = cacheReport([
      start("a", "claude", "sonnet"),
      end("a", "claude", usage(0, 900, 100), 0.5),
      start("a", "claude", "sonnet"),
      end("a", "claude", usage(900, 0, 100, { miss: false }), 0.1),
      start("a", "claude", "opus"),
      end("a", "claude", usage(0, 1000, 0, { miss: true, missCause: "model" }), 1),
    ]);
    const sonnet = lines.find((l) => l.model === "sonnet")!;
    expect(sonnet).toMatchObject({ turns: 2, reported: 2, cacheRead: 900, cacheWrite: 900, input: 200 });
    expect(sonnet.hitRate).toBeCloseTo(900 / 2000);
    expect(sonnet.warmHitRate).toBeCloseTo(0.9);
    expect(sonnet.costUsd).toBeCloseTo(0.6);
    const opus = lines.find((l) => l.model === "opus")!;
    expect(opus.misses).toEqual({ model: 1 });
    // Opus's only turn wasn't the thread's first, so it counts as warm.
    expect(opus.warmHitRate).toBe(0);
  });

  it("keeps agents that don't report cache reads apart from a 0% rate", () => {
    const [line] = cacheReport([start("b", "acp", "m"), end("b", "acp", usage(null, 0, 50)), end("b", "acp", undefined)]);
    expect(line).toMatchObject({ turns: 2, reported: 0, hitRate: null, warmHitRate: null, input: 55 });
    expect(formatReport([line!])).toMatch(/acp\s+m\s+2\s+not reported\s+—/);
  });
});

describe("defaultDb", () => {
  it("points at the installed app's profile on each platform", () => {
    expect(defaultDb("darwin")).toMatch(/Library[\\/]Application Support[\\/]CubiQ[\\/]unskilled\.db$/);
    expect(defaultDb("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" })).toMatch(/Roaming[\\/]CubiQ[\\/]unskilled\.db$/);
    expect(defaultDb("linux", { XDG_CONFIG_HOME: "/cfg" })).toMatch(/cfg[\\/]CubiQ[\\/]unskilled\.db$/);
  });
});
