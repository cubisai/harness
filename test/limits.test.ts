import { describe, expect, it } from "vitest";
import type { AgentLimits } from "../src/shared/types";
import { claudeLimitsPatch, codexLimitsPatch, LimitsTracker } from "../src/main/agents/limits";

describe("claudeLimitsPatch", () => {
  it("turns a rate_limit_event into a window: fraction to percent, seconds to ms", () => {
    expect(claudeLimitsPatch({ status: "allowed", rateLimitType: "five_hour", utilization: 0.423, resetsAt: 1_790_000_000 })).toEqual({
      windows: [{ id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: 1_790_000_000_000 }],
    });
  });

  // The shape Claude Code emitted for a claude.ai login, recorded from the fake API in claude-e2e.test.ts.
  it("includes the other windows the same response carried", () => {
    expect(
      claudeLimitsPatch({
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.84,
        resetsAt: 1_790_000_000,
        unifiedWindows: { seven_day: { utilization: 0.41, resetsAt: 1_790_500_000 } },
        isUsingOverage: false,
        surpassedThreshold: 0.8,
      } as Parameters<typeof claudeLimitsPatch>[0]),
    ).toEqual({
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 84, resetsAt: 1_790_000_000_000 },
        { id: "seven_day", label: "Weekly", usedPercent: 41, resetsAt: 1_790_500_000_000 },
      ],
      state: "warning",
    });
  });

  it("marks warnings and rejections", () => {
    expect(claudeLimitsPatch({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 })).toMatchObject({ state: "warning" });
    expect(claudeLimitsPatch({ status: "rejected" })).toEqual({ state: "limited" });
    expect(claudeLimitsPatch({ status: "allowed" })).toEqual({});
  });
});

describe("codexLimitsPatch", () => {
  it("names windows by length and keeps the plan", () => {
    expect(
      codexLimitsPatch({
        limitId: "codex",
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_790_000_000 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: null },
        planType: "plus",
      }),
    ).toEqual({
      windows: [
        { id: "codex:primary", label: "5-hour", usedPercent: 37, resetsAt: 1_790_000_000_000 },
        { id: "codex:secondary", label: "Weekly", usedPercent: 12, resetsAt: null },
      ],
      plan: "plus",
    });
  });

  it("treats missing fields as unchanged, and a reached limit as limited", () => {
    expect(codexLimitsPatch({ primary: null, secondary: null, planType: null })).toEqual({});
    expect(codexLimitsPatch({ rateLimitReachedType: "rate_limit_reached" })).toEqual({ state: "limited" });
    expect(codexLimitsPatch({ limitId: "gpt-x", limitName: "GPT-X", primary: { usedPercent: 5, windowDurationMins: 60 } }).windows).toEqual([
      { id: "gpt-x:primary", label: "GPT-X 1-hour", usedPercent: 5, resetsAt: null },
    ]);
  });
});

describe("LimitsTracker", () => {
  it("merges partial reports and only reports real changes", () => {
    const seen: AgentLimits[] = [];
    const t = new LimitsTracker((l) => seen.push(l));
    const report = t.for("claude");
    report({ windows: [{ id: "five_hour", label: "5-hour", usedPercent: 40, resetsAt: 1 }] });
    report({ windows: [{ id: "five_hour", label: "5-hour", usedPercent: 40, resetsAt: 1 }] }); // same again: quiet
    report({ windows: [{ id: "seven_day", label: "Weekly", usedPercent: null, resetsAt: 2 }] });
    report({ windows: [{ id: "five_hour", label: "5-hour", usedPercent: null, resetsAt: null }] }); // keeps 40 and the reset
    expect(seen).toHaveLength(2);
    expect(t.all()[0]).toMatchObject({
      agent: "claude",
      state: "ok",
      windows: [
        { id: "five_hour", usedPercent: 40, resetsAt: 1 },
        { id: "seven_day", usedPercent: null, resetsAt: 2 },
      ],
    });
  });

  it("derives warning and limited from the fullest window, and holds a reported limit", () => {
    const seen: AgentLimits[] = [];
    const t = new LimitsTracker((l) => seen.push(l));
    t.update("codex", { windows: [{ id: "a", label: "5-hour", usedPercent: 85, resetsAt: null }] });
    expect(seen.at(-1)!.state).toBe("warning");
    t.update("codex", { state: "limited" });
    t.update("codex", { plan: "plus" });
    expect(seen.at(-1)).toMatchObject({ state: "limited", plan: "plus" });
    t.update("codex", { windows: [{ id: "a", label: "5-hour", usedPercent: 3, resetsAt: null }] }); // the window reset
    expect(seen.at(-1)!.state).toBe("ok");
  });
});
