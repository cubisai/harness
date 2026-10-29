import { describe, expect, it } from "vitest";
import type { AgentLimits } from "../src/shared/types";
import { checkedAgo, isReset, limitMeterText, limitTooltip, resetCountdown } from "../src/renderer/src/components/Meters";

describe("resetCountdown", () => {
  it("reads in minutes, hours and days", () => {
    const now = 1_000_000_000;
    expect(resetCountdown(now + 45 * 60_000, now)).toBe("in 45m");
    expect(resetCountdown(now + (2 * 60 + 14) * 60_000, now)).toBe("in 2h 14m");
    expect(resetCountdown(now + (3 * 24 + 4) * 60 * 60_000, now)).toBe("in 3d 4h");
  });

  it("says reset once the time has passed", () => {
    expect(resetCountdown(1_000, 2_000)).toBe("reset");
  });
});

describe("checkedAgo", () => {
  it("says just now under a minute", () => {
    expect(checkedAgo(1_000, 1_000 + 59_000)).toBe("just now");
  });

  it("counts minutes and hours", () => {
    expect(checkedAgo(0, 12 * 60_000)).toBe("12 min ago");
    expect(checkedAgo(0, 2 * 60 * 60_000)).toBe("2h ago");
  });
});

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return { agent: "claude", windows: [], state: "ok", plan: null, updatedAt: 0, ...over };
}

describe("limitTooltip", () => {
  const now = 1_000_000;

  it("shows used percent and a relative reset per window", () => {
    const l = limits({
      windows: [{ id: "five_hour", label: "5-hour", usedPercent: 62, resetsAt: now + 45 * 60_000 }],
      updatedAt: now - 2 * 60_000,
    });
    expect(limitTooltip(l, now)).toBe("5-hour limit: 62% used, resets in 45m\nChecked 2 min ago");
  });

  it("shows a passed window as reset — refreshing", () => {
    const l = limits({
      windows: [{ id: "a", label: "Weekly", usedPercent: 100, resetsAt: now - 1 }],
      updatedAt: now - 30_000,
    });
    expect(isReset(l.windows[0]!, now)).toBe(true);
    expect(limitTooltip(l, now)).toBe("Weekly: reset — refreshing\nChecked just now");
  });

  it("says unknown when a window never reported a reset", () => {
    const l = limits({ windows: [{ id: "a", label: "A", usedPercent: null, resetsAt: null }], updatedAt: now - 30_000 });
    expect(limitTooltip(l, now)).toBe("A limit: in use, resets unknown\nChecked just now");
  });
});

describe("limitMeterText", () => {
  const now = 1_000_000;

  it("lists the 5-hour window then the weekly one", () => {
    const l = limits({
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 35, resetsAt: now + 60_000 },
        { id: "seven_day", label: "Weekly", usedPercent: 12, resetsAt: now + 3_600_000 },
      ],
    });
    expect(limitMeterText(l, now)).toBe("5h 35% · wk 12%");
  });

  it("shows the weekly window alone when that's all there is", () => {
    const l = limits({ windows: [{ id: "seven_day", label: "Weekly", usedPercent: 12, resetsAt: now + 3_600_000 }] });
    expect(limitMeterText(l, now)).toBe("wk 12%");
  });

  it("reads Codex's primary/secondary windows the same way", () => {
    const l = limits({
      windows: [
        { id: "codex:primary", label: "5-hour", usedPercent: 35, resetsAt: now + 60_000 },
        { id: "codex:secondary", label: "Weekly", usedPercent: 12, resetsAt: now + 3_600_000 },
      ],
    });
    expect(limitMeterText(l, now)).toBe("5h 35% · wk 12%");
  });

  it("drops a window whose reset has passed", () => {
    const l = limits({
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 90, resetsAt: now - 1 },
        { id: "seven_day", label: "Weekly", usedPercent: 12, resetsAt: now + 3_600_000 },
      ],
    });
    expect(limitMeterText(l, now)).toBe("wk 12%");
  });

  it("keeps the limit-reached text when limited", () => {
    const l = limits({
      state: "limited",
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: now + 45 * 60_000 },
        { id: "seven_day", label: "Weekly", usedPercent: 12, resetsAt: now + 3_600_000 },
      ],
    });
    expect(limitMeterText(l, now)).toBe("Limit reached · resets in 45m");
  });
});
