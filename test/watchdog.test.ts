import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnWatchdog } from "../src/main/watchdog";

describe("createTurnWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const calls: string[] = [];
    const dog = createTurnWatchdog({ onNotice: () => calls.push("notice"), onStop: () => calls.push("stop"), noticeMs: 3_000, stopMs: 10_000, tickMs: 1_000, now: () => Date.now() });
    return { dog, calls };
  };

  it("notices a silent turn once, then stops it once", () => {
    const { dog, calls } = make();
    vi.advanceTimersByTime(3_000);
    expect(calls).toEqual(["notice"]);
    vi.advanceTimersByTime(6_000);
    expect(calls).toEqual(["notice"]);
    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual(["notice", "stop"]);
    vi.advanceTimersByTime(20_000);
    expect(calls).toEqual(["notice", "stop"]);
    dog.dispose();
  });

  it("never fires while the agent keeps showing progress", () => {
    const { dog, calls } = make();
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(2_000);
      dog.bump();
    }
    expect(calls).toEqual([]);
    dog.dispose();
  });

  it("doesn't count time spent waiting on the user", async () => {
    const { dog, calls } = make();
    let answer!: (v: string) => void;
    const waited = dog.waitOn(new Promise<string>((r) => (answer = r)));
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([]);
    answer("allow-once");
    await expect(waited).resolves.toBe("allow-once");
    vi.advanceTimersByTime(2_000);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual(["notice"]);
    dog.dispose();
  });

  it("notices again after progress resumes and stalls a second time", () => {
    const { dog, calls } = make();
    vi.advanceTimersByTime(3_000);
    dog.bump();
    vi.advanceTimersByTime(3_000);
    expect(calls).toEqual(["notice", "notice"]);
    dog.dispose();
  });

  it("stops firing once disposed", () => {
    const { dog, calls } = make();
    dog.dispose();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([]);
  });
});
