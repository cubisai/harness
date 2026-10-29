// The bounded optimizer CLI (roadmap P8.3): argument building, candidate
// selection, the sealed holdout and a budget stop. The split runner is injected,
// so no model call, child process or shell runs here.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadTasks } from "../evals/run";
import { forSplit } from "../evals/lib/splits";
import { loadExperiment } from "../evals/lib/optimize";
import { buildRunArgs, knownSurfaces, optimize, settingsError, surfaceError, wiredSurfaces, type OptimizeOptions, type RunSplit } from "../evals/optimize";
import type { RunResult, Split, TaskResult, TrialResult } from "../evals/lib/types";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-optimize-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Real split ids, so scoreOf sees the tasks it expects whatever id it keys on.
const tasks = loadTasks();
const IDS: Record<Split, string[]> = {
  train: forSplit(tasks, "train").map((t) => t.id),
  validation: forSplit(tasks, "validation").map((t) => t.id),
  holdout: forSplit(tasks, "holdout", { sealed: false }).map((t) => t.id),
};

function trial(pass: boolean, costUsd = 0.01): TrialResult {
  return {
    pass,
    score: pass ? 1 : 0,
    graders: [{ type: "answer", pass, required: true, weight: 1, why: pass ? "ok" : "missing" }],
    overBudget: false,
    harnessError: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    steps: 1,
    toolCalls: 0,
    durationMs: 100,
    costUsd,
    events: [],
  };
}

/** A synthetic run for one split: every task's trials all pass or all fail. */
function run(split: Split, pass: boolean, trials = 3): RunResult {
  const results: TaskResult[] = IDS[split].map((id) => {
    const ts = Array.from({ length: trials }, () => trial(pass));
    return { id, tags: ["capability"], cacheKey: `ck-${id}`, cached: false, trials: ts, passAtK: ts.some((t) => t.pass), passHatK: ts.every((t) => t.pass) };
  });
  return {
    meta: { tier: "full", agent: "native", model: "m", protocol: "native", harnessHash: "h", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1000 },
    tasks: results,
  };
}

/** Candidate settings (non-empty) win; the empty baseline loses. */
const winning: RunSplit = async (split, settings) => run(split, split !== "train" && Object.keys(settings).length > 0);

function opts(over: Partial<OptimizeOptions> = {}): OptimizeOptions {
  return { id: `opt-${Math.random().toString(36).slice(2, 8)}`, surface: "model-effort", candidates: [{ effort: "high" }], budgetUsd: 5, trials: 3, release: false, root: tmp(), ...over };
}

describe("buildRunArgs", () => {
  const base: OptimizeOptions = { id: "x", surface: "model-effort", candidates: [], budgetUsd: 5, trials: 3, release: false, root: "/tmp/x" };

  it("adds --effort/--model only when the settings carry them", () => {
    const plain = buildRunArgs("validation", {}, base);
    expect(plain).not.toContain("--effort");
    expect(plain).not.toContain("--model");
    const rich = buildRunArgs("validation", { effort: "high", model: "m2" }, base);
    expect(rich[rich.indexOf("--effort") + 1]).toBe("high");
    expect(rich[rich.indexOf("--model") + 1]).toBe("m2");
  });

  it("adds --guide only for a prompt candidate", () => {
    expect(buildRunArgs("validation", {}, base)).not.toContain("--guide");
    const prompt = buildRunArgs("validation", { guide: "guides/a.md" }, { ...base, surface: "prompt" });
    expect(prompt[prompt.indexOf("--guide") + 1]).toBe("guides/a.md");
  });

  it("repeats every task when more than one trial is asked, and passes a given price", () => {
    expect(buildRunArgs("validation", {}, base)).toContain("--trials-all");
    expect(buildRunArgs("train", {}, base, 1)).not.toContain("--trials-all");
    expect(buildRunArgs("validation", {}, base)).not.toContain("--price");
    const free = buildRunArgs("validation", {}, { ...base, price: "0,0" });
    expect(free[free.indexOf("--price") + 1]).toBe("0,0");
  });

  it("passes --release on the holdout and never on validation", () => {
    expect(buildRunArgs("validation", {}, base)).not.toContain("--release");
    expect(buildRunArgs("train", {}, base)).not.toContain("--release");
    expect(buildRunArgs("holdout", {}, base)).toContain("--release");
  });
});

describe("surface and settings checks", () => {
  it("accepts the wired surfaces and rejects the rest", () => {
    expect(surfaceError("prompt")).toBeNull();
    expect(surfaceError("model-effort")).toBeNull();
    expect(surfaceError("definitely-not-a-surface")).not.toBeNull();
    const wired = wiredSurfaces();
    const unwired = knownSurfaces().find((s) => !wired.includes(s));
    if (unwired) expect(surfaceError(unwired)).toMatch(/wired/);
  });

  it("rejects a key a surface doesn't take, and a missing guide file", () => {
    const root = tmp();
    writeFileSync(join(root, "g.md"), "guide\n");
    expect(settingsError("model-effort", { effort: "high" })).toBeNull();
    expect(settingsError("model-effort", { bogus: "1" })).toMatch(/bogus/);
    expect(settingsError("prompt", { guide: "g.md" }, root)).toBeNull();
    expect(settingsError("prompt", { guide: "missing.md" }, root)).toMatch(/guide/);
  });
});

describe("optimize", () => {
  it("stops after the train run when its trials report no cost, before any validation spend", async () => {
    const splits: string[] = [];
    const unpriced: RunSplit = async (split, settings, trials, maxUsd) => {
      splits.push(split);
      const r = await winning(split, settings, trials, maxUsd);
      return { ...r, tasks: r.tasks.map((t) => ({ ...t, trials: t.trials.map((x) => ({ ...x, costUsd: null })) })) };
    };
    const exp = await optimize(opts(), unpriced);
    expect(exp.stop).toBe("cost-unknown");
    expect(splits).toEqual(["train"]);
    expect(exp.rounds).toEqual([]);
  });

  it("stops on a fully cached train run whose stored trials have no cost (0 fresh trials isn't priced)", async () => {
    const splits: string[] = [];
    const cachedUnpriced: RunSplit = async (split, settings, trials, maxUsd) => {
      splits.push(split);
      const r = await winning(split, settings, trials, maxUsd);
      return { ...r, tasks: r.tasks.map((t) => ({ ...t, cached: true, trials: t.trials.map((x) => ({ ...x, costUsd: null })) })) };
    };
    const exp = await optimize(opts(), cachedUnpriced);
    expect(exp.stop).toBe("cost-unknown");
    expect(splits).toEqual(["train"]);
  });

  it("stops after a candidate whose model reports no cost, before the next round", async () => {
    const splits: string[] = [];
    const unpricedModel: RunSplit = async (split, settings, trials, maxUsd) => {
      splits.push(split);
      const r = await winning(split, settings, trials, maxUsd);
      if (settings.model !== "free") return r;
      return { ...r, tasks: r.tasks.map((t) => ({ ...t, trials: t.trials.map((x) => ({ ...x, costUsd: null })) })) };
    };
    const exp = await optimize(opts({ candidates: [{ model: "free" }, { effort: "high" }] }), unpricedModel);
    expect(exp.stop).toBe("cost-unknown");
    expect(exp.rounds).toHaveLength(1);
    expect(splits).toEqual(["train", "validation", "validation"]);
  });

  it("keeps a candidate that clearly wins as best, and requests no holdout", async () => {
    const splits: string[] = [];
    const fake: RunSplit = async (split, settings, trials, maxUsd) => {
      splits.push(split);
      return winning(split, settings, trials, maxUsd);
    };
    const exp = await optimize(opts(), fake);
    expect(exp.best).not.toBe("c0");
    expect(exp.candidates.some((c) => c.id === exp.best)).toBe(true);
    expect(splits).not.toContain("holdout");
  });

  it("runs the holdout only with --release", async () => {
    const without: string[] = [];
    await optimize(opts(), async (split, settings, trials, maxUsd) => (without.push(split), winning(split, settings, trials, maxUsd)));
    expect(without).not.toContain("holdout");

    const withRelease: string[] = [];
    await optimize(opts({ release: true }), async (split, settings, trials, maxUsd) => (withRelease.push(split), winning(split, settings, trials, maxUsd)));
    expect(withRelease.filter((s) => s === "holdout")).toHaveLength(2);
  });

  it("stops with budget below the first validation cost and still saves the record", async () => {
    const o = opts({ budgetUsd: 0.0001, id: "budget-stop" });
    const exp = await optimize(o, winning);
    expect(exp.stop).toBe("budget");
    expect(existsSync(join(o.root, o.id, "experiment.json"))).toBe(true);
    expect(loadExperiment(o.root, o.id)?.stop).toBe("budget");
  });
});
