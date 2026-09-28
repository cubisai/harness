import { describe, expect, it, vi } from "vitest";
import type { LimitsPatch } from "../src/main/agents/limits";
import { LimitsTracker } from "../src/main/agents/limits";
import { LimitsRefresher } from "../src/main/limits-refresher";

const win = (id: string, usedPercent: number, resetsAt: number | null = null) => ({ id, label: id, usedPercent, resetsAt });

function trackerWith(agent: string, patch: LimitsPatch, at: number): LimitsTracker {
  const t = new LimitsTracker(() => {});
  t.update(agent, patch, at);
  return t;
}

function refresher(
  readLimits: () => Promise<LimitsPatch | "unsupported" | null>,
  tracker: LimitsTracker,
  now: () => number = () => 0,
): LimitsRefresher {
  return new LimitsRefresher({ drivers: [{ agent: "claude", readLimits }], tracker, now });
}

describe("LimitsRefresher", () => {
  it("asks once, then not again within the 5-minute TTL", async () => {
    let now = 1_000_000;
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => ({ windows: [win("a", 10)] }));
    const r = refresher(read, new LimitsTracker(() => {}), () => now);
    await r.tick();
    expect(read).toHaveBeenCalledTimes(1);
    now += 4 * 60_000;
    await r.tick();
    expect(read).toHaveBeenCalledTimes(1);
    now += 2 * 60_000; // six minutes past the snapshot now
    await r.tick();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("lets a push report reset the TTL", async () => {
    let now = 0;
    const tracker = new LimitsTracker(() => {});
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => ({ windows: [win("a", 10)] }));
    const r = refresher(read, tracker, () => now);
    await r.tick(); // snapshot at 0
    now = 60_000;
    tracker.update("claude", { windows: [win("a", 20)] }, now); // a push at 60s
    now = 60_000 + 4 * 60_000;
    await r.tick();
    expect(read).toHaveBeenCalledTimes(1);
    now = 60_000 + 5 * 60_000 + 1;
    await r.tick();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request per agent", async () => {
    let release!: (v: LimitsPatch) => void;
    const read = vi.fn(() => new Promise<LimitsPatch>((resolve) => (release = resolve)));
    const r = refresher(read, new LimitsTracker(() => {}));
    const first = r.tick();
    const second = r.tick();
    release({ windows: [win("a", 10)] });
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("backs off 5/10/20/30 minutes after failures", async () => {
    let now = 0;
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => {
      throw new Error("down");
    });
    const r = refresher(read, new LimitsTracker(() => {}), () => now);
    await r.tick(); // 1
    now = 300_001; // just past the 5-minute back-off
    await r.tick(); // 2
    now = 900_002; // + 10 minutes
    await r.tick(); // 3
    now = 2_100_003; // + 20 minutes
    await r.tick(); // 4
    expect(read).toHaveBeenCalledTimes(4);
    now = 3_899_999; // inside the 30-minute cap
    await r.tick();
    expect(read).toHaveBeenCalledTimes(4);
    now = 3_900_004; // past it
    await r.tick(); // 5
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("resets the back-off after a successful read", async () => {
    let now = 0;
    let failing = true;
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => {
      if (failing) throw new Error("down");
      return { windows: [win("a", 5)] };
    });
    const tracker = new LimitsTracker(() => {});
    const r = refresher(read, tracker, () => now);
    await r.tick(); // fails, back-off 5
    now = 5 * 60_000 + 1;
    failing = false;
    await r.tick(); // succeeds, back-off cleared
    expect(read).toHaveBeenCalledTimes(2);
    const last = tracker.lastChecked("claude")!;
    now = last + 1;
    await r.tick(); // within the TTL
    expect(read).toHaveBeenCalledTimes(2);
    now = last + 5 * 60_000 + 1;
    await r.tick();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("stops asking an agent that has no plan limits, until reset", async () => {
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => "unsupported" as const);
    const r = refresher(read, new LimitsTracker(() => {}));
    await r.tick();
    await r.tick();
    expect(read).toHaveBeenCalledTimes(1);
    r.reset("claude");
    await r.tick();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("treats null as nothing to ask, not a failure", async () => {
    let now = 0;
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => null);
    const r = refresher(read, new LimitsTracker(() => {}), () => now);
    await r.tick();
    now = 1;
    await r.tick();
    now = 2;
    await r.tick();
    expect(read).toHaveBeenCalledTimes(3); // no back-off gate held it back
  });

  it("does nothing while no window is focused", async () => {
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => ({}));
    const r = refresher(read, new LimitsTracker(() => {}));
    r.setActive(false);
    await r.tick();
    expect(read).not.toHaveBeenCalled();
    r.setActive(true);
    await r.tick();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("asks early once when a window's reset passes, at most once a minute", async () => {
    let now = 200;
    const tracker = trackerWith("claude", { windows: [win("a", 100, 100)] }, 0);
    const read = vi.fn(async (): Promise<LimitsPatch | "unsupported" | null> => ({ windows: [win("a", 0)] }));
    const r = refresher(read, tracker, () => now);
    await r.tick(); // inside the TTL, but the reset just passed
    expect(read).toHaveBeenCalledTimes(1);
    now = 300;
    await r.tick(); // at most one per minute
    expect(read).toHaveBeenCalledTimes(1);
    now = 200 + 60_001;
    await r.tick(); // the fresh snapshot has no pending reset
    expect(read).toHaveBeenCalledTimes(1);
  });
});
