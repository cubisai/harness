// Unit tests for evals/lib/calibrate.ts: verdict stability across repeated
// grader validations, with the validator and the clock injected so nothing
// here touches a shell or the filesystem.
import { describe, expect, it } from "vitest";
import { formatStability, stability } from "../evals/lib/calibrate";
import type { Validation } from "../evals/lib/validate";
import type { Task } from "../evals/lib/types";

const task = (id = "t"): Task => ({
  id,
  tags: ["capability"],
  tier: "smoke",
  fixture: "f",
  prompt: "p",
  mode: "auto-edit",
  graders: [],
  budget: { maxSteps: 1, maxInputTokens: 1, timeoutMs: 1000 },
});

const verdict = (noop: boolean, reference: boolean | null = false, skipped?: string): Validation => ({
  id: "t",
  noop: { pass: noop, why: [] },
  reference: reference === null ? null : { pass: reference, why: [] },
  problems: [],
  ...(skipped !== undefined && { skipped }),
});

describe("stability", () => {
  it("reports no flips when every verdict agrees", async () => {
    const s = await stability(task(), 3, async () => verdict(false, true));
    expect(s).toMatchObject({ runs: 3, flips: [] });
    expect(s.noop).toEqual([false, false, false]);
    expect(s.reference).toEqual([true, true, true]);
  });

  it("flags a reference verdict that flips, with its counts", async () => {
    const verdicts = [true, false, true];
    let i = 0;
    const s = await stability(task("ref-flip"), 3, async () => verdict(false, verdicts[i++]!));
    expect(s.flips).toEqual(["reference verdict flips (2/3 passed)"]);
    expect(s.reference).toEqual([true, false, true]);
  });

  it("flags a no-op verdict that flips, with its counts", async () => {
    const verdicts = [false, true, true];
    let i = 0;
    const s = await stability(task("noop-flip"), 3, async () => verdict(verdicts[i++]!, true));
    expect(s.flips).toEqual(["no-op verdict flips (2/3 passed)"]);
    expect(s.noop).toEqual([false, true, true]);
  });

  it("keeps null reference verdicts out of the comparison", async () => {
    const s = await stability(task("no-ref"), 3, async () => verdict(false, null));
    expect(s.reference).toEqual([null, null, null]);
    expect(s.flips).toEqual([]);
  });

  it("stops after the first call when the validation is skipped", async () => {
    let calls = 0;
    const s = await stability(task("skipped"), 5, async () => {
      calls++;
      return verdict(false, null, "needs team");
    });
    expect(calls).toBe(1);
    expect(s).toMatchObject({ runs: 0, flips: [], noop: [], reference: [], ms: [] });
  });
});

describe("formatStability", () => {
  it("prefixes a stable task with OK and a flaky one with FLAKY", () => {
    const stable = { id: "a", runs: 3, noop: [false, false, false], reference: [true, true, true], flips: [], ms: [10, 20, 30] };
    const flaky = { ...stable, flips: ["reference verdict flips (2/3 passed)"] };
    expect(formatStability(stable).startsWith("OK ")).toBe(true);
    expect(formatStability(stable)).not.toContain("FLAKY");
    expect(formatStability(flaky).startsWith("FLAKY ")).toBe(true);
    expect(formatStability(flaky)).toContain("reference verdict flips (2/3 passed)");
  });

  it("takes p50 and max from the injected clock", async () => {
    const ticks = [0, 10, 10, 30, 30, 60];
    const s = await stability(task("timed"), 3, async () => verdict(false, true), () => ticks.shift()!);
    expect(s.ms).toEqual([10, 20, 30]);
    const line = formatStability(s);
    expect(line).toContain("3x  p50 20ms  max 30ms");
  });
});
