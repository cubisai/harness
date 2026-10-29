import { describe, expect, it } from "vitest";
import { caseRow, compareRuns, percentile, renderReport, settingDifferences } from "../evals/lib/report";
import type { RunResult, TaskResult, TrialResult } from "../evals/lib/types";

const trial = (over: Partial<TrialResult> = {}): TrialResult => ({
  pass: true, score: 1, graders: [], overBudget: false, harnessError: null, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
  steps: 1, toolCalls: 1, durationMs: 1000, costUsd: 0.01, events: [], ...over,
});
const task = (id: string, trials: TrialResult[], over: Partial<TaskResult> = {}): TaskResult => ({
  id, tags: ["capability"], cacheKey: id, cached: false, trials, passAtK: trials.some((t) => t.pass), passHatK: trials.every((t) => t.pass), ...over,
});
const run = (tasks: TaskResult[], meta: Partial<RunResult["meta"]> = {}): RunResult => ({
  meta: { tier: "full", agent: "native", model: "m", protocol: "openai-chat", harnessHash: "aaaaaaa1", startedAt: "2026-10-17T00:00:00.000Z", durationMs: 5000, ...meta },
  tasks,
});

describe("eval report", () => {
  it("percentiles use nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it("a case row reports pass rate, statuses, coverage and traces", () => {
    const r = caseRow(task("a", [trial({ trace: "traces/r/a-1.json", cached: true }), trial({ pass: false, status: "failed", costUsd: null, durationMs: 3000 })], { requestedTrials: 3 }));
    expect(r).toMatchObject({ trials: 2, requested: 3, passRate: 0.5, statuses: { passed: 1, failed: 1 }, meanCost: null, p50Ms: 1000, cached: 1, traces: ["traces/r/a-1.json"] });
  });

  it("compares only the shared tasks and names the settings that differ", () => {
    const base = run([task("a", [trial()]), task("b", [trial({ pass: false })])], { effort: "low" });
    const cand = run([task("a", [trial({ pass: false })]), task("c", [trial()])], { effort: "high", harnessHash: "bbbbbbb2" });
    const c = compareRuns(base, cand);
    expect(c).toMatchObject({ shared: ["a"], onlyBase: ["b"], onlyCandidate: ["c"] });
    expect(c.base.passRate).toBe(1);
    expect(c.candidate.passRate).toBe(0);
    expect(settingDifferences(base, cand)).toEqual(['effort: "low" → "high"', 'harness: "aaaaaaa1" → "bbbbbbb2"']);
  });

  it("renders escaped HTML with trace links and a comparison", () => {
    const html = renderReport(run([task("<x>", [trial({ trace: "traces/r/x.json" })])]), compareRuns(run([task("<x>", [trial()])]), run([task("<x>", [trial()])])));
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("<x>");
    expect(html).toContain('href="../traces/r/x.json"');
    expect(html).toContain("Same settings");
  });
});
