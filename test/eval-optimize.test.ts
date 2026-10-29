import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CRITERIA,
  addCandidate,
  applyRound,
  decide,
  loadExperiment,
  newExperiment,
  pairedBootstrap,
  saveExperiment,
  scoreOf,
  seededRng,
  shouldStop,
  summary,
  trainFailures,
} from "../evals/lib/optimize";
import type { Experiment, Round, SplitScore, Verdict } from "../evals/lib/optimize";
import type { GraderResult, RunMeta, RunResult, TaskResult, TrialResult } from "../evals/lib/types";
import type { RunManifest } from "../src/shared/run-trace";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "opt-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const AT = "2026-01-01T00:00:00.000Z";

function grader(over: Partial<GraderResult> = {}): GraderResult {
  return { type: "file", pass: true, required: true, weight: 1, why: "ok", ...over };
}

function trial(over: Partial<TrialResult> = {}): TrialResult {
  return {
    pass: true,
    score: 1,
    graders: [grader()],
    overBudget: false,
    harnessError: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    steps: 3,
    toolCalls: 2,
    durationMs: 1000,
    costUsd: 0.01,
    events: [],
    ...over,
  };
}

function task(id: string, trials: TrialResult[], over: Partial<TaskResult> = {}): TaskResult {
  return {
    id,
    tags: ["capability"],
    cacheKey: `ck-${id}`,
    cached: false,
    trials,
    passAtK: trials.some((t) => t.pass),
    passHatK: trials.every((t) => t.pass),
    ...over,
  };
}

function run(tasks: TaskResult[], meta: Partial<RunMeta> = {}): RunResult {
  return {
    meta: { tier: "smoke", agent: "native", model: "m", protocol: "native", harnessHash: "h1", startedAt: AT, durationMs: 1000, ...meta },
    tasks,
  };
}

function manifest(versions: Record<string, string>): RunManifest {
  return {
    version: 1,
    runId: "r1",
    origin: "eval",
    agent: "native",
    requestedModel: "m",
    model: "m",
    protocol: "native",
    effort: null,
    versions,
    price: null,
    budget: {},
    fidelity: "full",
    platform: "darwin",
    startedAt: AT,
  };
}

/** A SplitScore built directly from per-task pass counts, for the decide/paired tests. */
function score(perTask: Array<{ id: string; passed: number; trials: number }>, over: Partial<SplitScore> = {}): SplitScore {
  const counted = perTask.filter((t) => t.trials > 0);
  return {
    split: "validation",
    trials: counted.length ? Math.min(...counted.map((t) => t.trials)) : 0,
    perTask: perTask.map((t) => ({ id: t.id, passed: t.passed, trials: t.trials, costUsd: null, p50Ms: null })),
    passRate: counted.length ? counted.reduce((s, t) => s + t.passed / t.trials, 0) / counted.length : 0,
    costPerSuccess: null,
    p50Ms: 1000,
    identity: { graders: "", tasks: "" },
    costUsd: 0,
    ...over,
  };
}

const tenTasks = (passedFor: (i: number) => number): Array<{ id: string; passed: number; trials: number }> =>
  Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, passed: passedFor(i), trials: 3 }));

describe("scoreOf", () => {
  it("counts only status passed and never a harness-error trial's passing graders", () => {
    const r = run([
      task("a", [
        trial(),
        trial({ pass: true, status: "harness-error", harnessError: "boom", graders: [grader({ pass: true })] }),
        trial({ pass: false, status: "failed", score: 0 }),
      ]),
    ]);
    const s = scoreOf(r, "validation");
    expect(s.split).toBe("validation");
    expect(s.perTask[0]).toMatchObject({ id: "a", passed: 1, trials: 3 });
    expect(s.passRate).toBeCloseTo(1 / 3);
    expect(s.trials).toBe(3);
  });

  it("sums fresh spend, keeps per-task known cost and reads the manifest identity", () => {
    const r = run([task("a", [trial({ costUsd: 0.05 }), trial({ costUsd: 0.05, cached: true }), trial({ costUsd: null })])], {
      manifest: manifest({ graders: "g1", tasks: "t1" }),
    });
    const s = scoreOf(r, "train");
    expect(s.costUsd).toBeCloseTo(0.05); // cached trial is history, not this run's spend
    expect(s.perTask[0]!.costUsd).toBeCloseTo(0.1); // known costs add up, cached included
    expect(s.identity).toEqual({ graders: "g1", tasks: "t1" });
  });

  it("reports no cost when nothing is known and an empty identity without a manifest", () => {
    const s = scoreOf(run([task("a", [trial({ costUsd: null })])]), "holdout");
    expect(s.perTask[0]!.costUsd).toBeNull();
    expect(s.costPerSuccess).toBeNull();
    expect(s.identity).toEqual({ graders: "", tasks: "" });
  });
});

describe("pairedBootstrap", () => {
  const base = score(tenTasks(() => 0));
  const cand = score(tenTasks((i) => (i < 4 ? 3 : 0)));

  it("is deterministic for a seed and brackets the gain", () => {
    const a = pairedBootstrap(base, cand, 800, seededRng(1));
    const b = pairedBootstrap(base, cand, 800, seededRng(1));
    expect(a).toEqual(b);
    expect(a.gain).toBeCloseTo(0.4);
    expect(a.lo).toBeLessThanOrEqual(a.gain);
    expect(a.hi).toBeGreaterThanOrEqual(a.gain);
  });

  it("returns zeros when no tasks are paired", () => {
    expect(pairedBootstrap(score([{ id: "z", passed: 3, trials: 3 }]), base, 200, seededRng(1))).toEqual({ gain: 0, lo: 0, hi: 0 });
  });
});

describe("decide", () => {
  const clearBase = score(tenTasks(() => 0));
  const clearCand = score(tenTasks((i) => (i < 4 ? 3 : 0)));

  it("accepts a clear gain and is reproducible", () => {
    const d = decide(clearBase, clearCand, DEFAULT_CRITERIA);
    expect(d.verdict).toBe("accept");
    expect(d.gain).toBeCloseTo(0.4);
    expect(d.ci[0]).toBeGreaterThan(0);
    expect(decide(clearBase, clearCand, DEFAULT_CRITERIA)).toEqual(d);
  });

  it("calls a tiny gain noise", () => {
    const base = score(Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, passed: 0, trials: 3 })));
    const cand = score(Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, passed: i === 0 ? 3 : 0, trials: 3 })));
    const d = decide(base, cand, DEFAULT_CRITERIA);
    expect(d.verdict).toBe("noise");
    expect(d.gain).toBeCloseTo(0.02);
  });

  it("calls a task that flips 3/3 to 0/3 a regression", () => {
    const base = score([{ id: "flip", passed: 3, trials: 3 }, { id: "keep", passed: 0, trials: 3 }]);
    const cand = score([{ id: "flip", passed: 0, trials: 3 }, { id: "keep", passed: 3, trials: 3 }]);
    const d = decide(base, cand, DEFAULT_CRITERIA);
    expect(d.verdict).toBe("regression");
    expect(d.why).toContain("flip");
  });

  it("needs the minimum trials", () => {
    expect(decide(score([{ id: "a", passed: 1, trials: 1 }]), score([{ id: "a", passed: 1, trials: 1 }]), DEFAULT_CRITERIA).verdict).toBe("too-few-trials");
  });

  it("calls a changed grader version stale", () => {
    const base = score([{ id: "a", passed: 2, trials: 3 }], { identity: { graders: "g1", tasks: "" } });
    const cand = score([{ id: "a", passed: 3, trials: 3 }], { identity: { graders: "g2", tasks: "" } });
    const d = decide(base, cand, DEFAULT_CRITERIA);
    expect(d.verdict).toBe("stale");
    expect(d.why).toContain("re-evaluate");
  });

  it("rejects a doubled cost per success", () => {
    const d = decide({ ...clearBase, costPerSuccess: 0.02 }, { ...clearCand, costPerSuccess: 0.04 }, DEFAULT_CRITERIA);
    expect(d.verdict).toBe("too-costly");
  });

  it("rejects a candidate that is too slow", () => {
    const d = decide({ ...clearBase, p50Ms: 1000 }, { ...clearCand, p50Ms: 2000 }, DEFAULT_CRITERIA);
    expect(d.verdict).toBe("too-slow");
  });
});

describe("experiment", () => {
  const validation = score([{ id: "a", passed: 1, trials: 3 }]);

  it("addCandidate versions after the highest and parents the incumbent, without mutating", () => {
    const e0 = newExperiment({ id: "exp", surface: "prompt", budgetUsd: 5, now: () => AT });
    expect(e0.baseline).toMatchObject({ id: "c0", version: 0, settings: {}, parent: null, note: "baseline" });
    expect(e0.best).toBe("c0");

    const { experiment: e1, candidate: c1 } = addCandidate(e0, { guide: "v2" }, "try v2", () => AT);
    expect(c1).toMatchObject({ id: "c1", version: 1, parent: "c0", surface: "prompt", settings: { guide: "v2" } });
    expect(e1.candidates.map((c) => c.id)).toEqual(["c0", "c1"]);
    expect(e0.candidates).toHaveLength(1); // input untouched

    const { candidate: c2 } = addCandidate(e1, { guide: "v3" }, "try v3", () => AT);
    expect(c2).toMatchObject({ id: "c2", parent: "c0" });
  });

  it("applyRound charges the budget and promotes best only on accept", () => {
    const e = newExperiment({ id: "exp", surface: "prompt", budgetUsd: 5, now: () => AT });
    const noise: Round = { candidateId: "c0", validation, decision: { verdict: "noise", gain: 0.01, ci: [0, 0.02], why: "small" }, at: AT };
    const e1 = applyRound(e, noise, 0.25);
    expect(e1.best).toBe("c0");
    expect(e1.bestScore).toBeNull();
    expect(e1.spentUsd).toBeCloseTo(0.25);
    expect(e.rounds).toHaveLength(0); // pure

    const accept: Round = { candidateId: "c1", validation, decision: { verdict: "accept", gain: 0.4, ci: [0.1, 0.7], why: "good" }, at: AT };
    const e2 = applyRound(e1, accept, 0.3);
    expect(e2.best).toBe("c1");
    expect(e2.bestScore).toBe(validation);
    expect(e2.spentUsd).toBeCloseTo(0.55);
  });

  it("shouldStop on budget, regression, noise and stalled", () => {
    const e = newExperiment({ id: "exp", surface: "prompt", budgetUsd: 1, now: () => AT });
    expect(shouldStop(e)).toBeNull();
    expect(shouldStop({ ...e, spentUsd: 1 })).toBe("budget");

    const withRounds = (verdicts: Verdict[]): Experiment => ({
      ...e,
      rounds: verdicts.map((v, i): Round => ({ candidateId: `c${i}`, validation, decision: { verdict: v, gain: 0, ci: [0, 0], why: v }, at: AT })),
    });
    expect(shouldStop(withRounds(["accept"]))).toBeNull();
    expect(shouldStop(withRounds(["noise"]))).toBeNull();
    expect(shouldStop(withRounds(["regression"]))).toBe("regression");
    expect(shouldStop(withRounds(["accept", "noise", "noise"]))).toBe("noise");
    expect(shouldStop(withRounds(["noise", "too-costly"]))).toBe("stalled");
    expect(shouldStop(withRounds(["accept", "noise"]))).toBeNull();
  });
});

describe("trainFailures", () => {
  it("returns unique grader whys and nothing for passing tasks", () => {
    const r = run([
      task("fails", [
        trial({ pass: false, status: "failed", graders: [grader({ pass: false, why: "missing file" }), grader({ pass: true, why: "ok" })] }),
        trial({ pass: false, status: "failed", graders: [grader({ pass: false, why: "missing file" }), grader({ pass: false, why: "wrong answer" })] }),
      ]),
      task("ok", [trial()]),
    ]);
    expect(trainFailures(r)).toEqual([{ id: "fails", why: ["missing file", "wrong answer"] }]);
  });

  it("caps the reasons at five", () => {
    const graders = Array.from({ length: 7 }, (_, i) => grader({ pass: false, why: `reason ${i}` }));
    expect(trainFailures(run([task("x", [trial({ pass: false, status: "failed", graders })])]))[0]!.why).toHaveLength(5);
  });
});

describe("summary", () => {
  const validation = score([{ id: "a", passed: 1, trials: 3 }]);

  it("shows the CI and calls a gain that spans zero uncertain", () => {
    const e = newExperiment({ id: "exp", surface: "prompt", budgetUsd: 2, now: () => AT });
    const round: Round = { candidateId: "c0", validation, decision: { verdict: "accept", gain: 0, ci: [-0.1, 0.1], why: "spans zero" }, at: AT };
    const text = summary(applyRound(e, round, 0.5));
    expect(text).toContain("surface prompt");
    expect(text).toContain("CI");
    expect(text).toContain("uncertain");
    expect(text).toContain("Spent $0.5000 of $2.0000");
  });

  it("does not call a clearly positive gain uncertain", () => {
    const e = newExperiment({ id: "exp", surface: "prompt", budgetUsd: 2, now: () => AT });
    const round: Round = { candidateId: "c0", validation, decision: { verdict: "accept", gain: 0.4, ci: [0.1, 0.7], why: "clear" }, at: AT };
    const text = summary(applyRound(e, round, 0.5));
    expect(text).toContain("+0.40 (95% CI +0.10 … +0.70)");
    expect(text).not.toContain("uncertain");
  });

  it("lists each round and the release holdout line when present", () => {
    const e = newExperiment({ id: "exp", surface: "model-effort", budgetUsd: 2, now: () => AT });
    const noise: Round = { candidateId: "c1", validation, decision: { verdict: "noise", gain: 0.01, ci: [0, 0.02], why: "too small" }, at: AT };
    const text = summary({ ...applyRound(e, noise, 0.5), release: { candidateId: "c1", holdout: validation, baselineHoldout: validation } });
    expect(text).toContain("c1 noise: too small");
    expect(text).toContain("Release holdout c1");
  });
});

describe("saveExperiment / loadExperiment", () => {
  it("round-trips the experiment and writes every candidate", () => {
    const root = tmp();
    const e0 = newExperiment({ id: "exp-1", surface: "prompt", budgetUsd: 3, now: () => AT });
    const { experiment: e } = addCandidate(e0, { effort: "high" }, "try high", () => AT);
    const dir = saveExperiment(root, e);
    expect(dir).toBe(join(root, "exp-1"));
    expect(loadExperiment(root, "exp-1")).toEqual(e);

    expect(JSON.parse(readFileSync(join(dir, "candidates", "c1.json"), "utf8"))).toMatchObject({ id: "c1", settings: { effort: "high" } });
    expect(existsSync(join(dir, "candidates", "c0.json"))).toBe(true);
  });

  it("returns null for a missing or invalid file", () => {
    const root = tmp();
    expect(loadExperiment(root, "nope")).toBeNull();

    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(join(root, "bad", "experiment.json"), "{ not json");
    expect(loadExperiment(root, "bad")).toBeNull();

    mkdirSync(join(root, "bad2"), { recursive: true });
    writeFileSync(join(root, "bad2", "experiment.json"), "42");
    expect(loadExperiment(root, "bad2")).toBeNull();
  });
});
