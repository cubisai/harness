import { describe, expect, it, vi } from "vitest";
import type { AgentLimits } from "../src/shared/types";
import { claudeLimitsPatch, claudeUsagePatch, codexLimitsPatch, codexReadPatch, LimitsTracker } from "../src/main/agents/limits";

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

describe("claudeUsagePatch", () => {
  it("maps each present window, already a percentage, with ISO resets as ms", () => {
    expect(
      claudeUsagePatch({
        rate_limits_available: true,
        subscription_type: "max",
        rate_limits: {
          five_hour: { utilization: 42.4, resets_at: "2026-09-28T12:00:00.000Z" },
          seven_day: { utilization: 8, resets_at: null },
          seven_day_sonnet: null,
          seven_day_oauth_apps: { utilization: 101, resets_at: "bad" },
        },
      }),
    ).toEqual({
      complete: true,
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: Date.parse("2026-09-28T12:00:00.000Z") },
        { id: "seven_day", label: "Weekly", usedPercent: 8, resetsAt: null },
        { id: "seven_day_oauth_apps", label: "Weekly (apps)", usedPercent: 100, resetsAt: null },
      ],
      plan: "max",
    });
  });

  it("returns no windows when the endpoint has none", () => {
    expect(claudeUsagePatch({ rate_limits_available: true, rate_limits: null })).toEqual({});
    expect(claudeUsagePatch({ rate_limits_available: true, subscription_type: null, rate_limits: { five_hour: null } })).toEqual({});
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

describe("codexReadPatch", () => {
  it("merges every snapshot in rateLimitsByLimitId", () => {
    expect(
      codexReadPatch({
        rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_700_000_000 } },
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_790_000_000 }, planType: "plus" },
          "gpt-x": { limitId: "gpt-x", limitName: "GPT-X", primary: { usedPercent: 5, windowDurationMins: 60 }, rateLimitReachedType: "rate_limit_reached" },
        },
      }),
    ).toEqual({
      complete: true,
      windows: [
        { id: "codex:primary", label: "5-hour", usedPercent: 37, resetsAt: 1_790_000_000_000 },
        { id: "gpt-x:primary", label: "GPT-X 1-hour", usedPercent: 5, resetsAt: null },
      ],
      state: "limited",
      plan: "plus",
    });
  });

  it("falls back to rateLimits when there is no per-id map", () => {
    expect(codexReadPatch({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080 } }, rateLimitsByLimitId: null })).toEqual({
      complete: true,
      windows: [{ id: "codex:primary", label: "Weekly", usedPercent: 12, resetsAt: null }],
    });
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

  it("ignores a past-reset window and clears a held limited once they all reset", () => {
    const seen: AgentLimits[] = [];
    const t = new LimitsTracker((l) => seen.push(l));
    t.update("claude", { windows: [{ id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: 5_000 }] }, 1_000);
    expect(seen.at(-1)!.state).toBe("limited");
    // The reset passed: a report with no state recomputes from live windows only.
    t.update("claude", { plan: "max" }, 6_000);
    expect(seen.at(-1)).toMatchObject({ state: "ok", plan: "max" });
  });

  it("does not let a repeated stale window resurrect the limit", () => {
    const seen: AgentLimits[] = [];
    const t = new LimitsTracker((l) => seen.push(l));
    t.update("claude", { windows: [{ id: "a", label: "A", usedPercent: 100, resetsAt: 10 }] }, 0);
    // The merge keeps the last numbers, but the window is past its reset.
    t.update("claude", { windows: [{ id: "a", label: "A", usedPercent: null, resetsAt: null }] }, 20);
    expect(seen.at(-1)!.state).toBe("ok");
    expect(seen.at(-1)!.windows[0]).toMatchObject({ usedPercent: 100, resetsAt: 10 });
  });
});

describe("LimitsTracker persistence", () => {
  it("loads silently and saves a real change after the debounce", () => {
    vi.useFakeTimers();
    try {
      const loaded: AgentLimits[] = [{ agent: "claude", windows: [], state: "ok", plan: null, updatedAt: 7 }];
      const saved: AgentLimits[][] = [];
      const seen: AgentLimits[] = [];
      const t = new LimitsTracker((l) => seen.push(l), { load: () => loaded, save: (all) => saved.push(all) });
      expect(seen).toHaveLength(0);
      expect(t.all()).toEqual(loaded);
      expect(t.lastChecked("claude")).toBe(7);
      t.update("claude", { plan: "max" });
      expect(saved).toHaveLength(0); // still settling
      vi.advanceTimersByTime(1_000);
      expect(saved).toHaveLength(1);
      const first = saved[0]!;
      expect(first[0]).toMatchObject({ plan: "max" });
      expect(t.lastChecked("claude")).toBe(first[0]!.updatedAt);
      expect(t.lastChecked("codex")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("full snapshots", () => {
  it("ignores Claude's internal meters and non-window fields", () => {
    const patch = claudeUsagePatch({
      rate_limits_available: true,
      subscription_type: "pro",
      rate_limits: {
        five_hour: { utilization: 31, resets_at: "2026-09-28T13:10:00Z" },
        iguana_necktie: { utilization: 100, resets_at: "2026-10-01T07:59:00Z" },
        spend: null,
      },
    } as never);
    expect(patch.windows?.map((w) => w.id)).toEqual(["five_hour"]);
  });

  it("an empty read carries no windows, so nothing known is wiped", () => {
    const patch = claudeUsagePatch({ rate_limits_available: true, subscription_type: "pro", rate_limits: null } as never);
    expect(patch.windows).toBeUndefined();
    expect(patch.complete).toBeUndefined();
  });

  it("a complete patch replaces the known windows; a partial one merges", () => {
    const tracker = new LimitsTracker(() => {});
    tracker.update("claude", { windows: [{ id: "bogus", label: "bogus", usedPercent: 100, resetsAt: null }] }, 1);
    tracker.update("claude", { windows: [{ id: "five_hour", label: "5-hour", usedPercent: 10, resetsAt: null }] }, 2);
    expect(tracker.all()[0]!.windows.map((w) => w.id).sort()).toEqual(["bogus", "five_hour"]);
    tracker.update("claude", { windows: [{ id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: null }], complete: true }, 3);
    expect(tracker.all()[0]!.windows.map((w) => w.id)).toEqual(["five_hour"]);
    expect(tracker.all()[0]!.state).toBe("ok");
  });
});
