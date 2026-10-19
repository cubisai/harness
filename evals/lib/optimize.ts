// Bounded optimizer (roadmap P8.3): score a split, compare a candidate against
// the incumbent with a paired bootstrap over the tasks both runs share, and
// decide accept/noise/regression/…. Pure: no process spawning and no model
// calls; the CLI (evals/optimize.ts) wires it to the runner. Plans:
// .ai/plans/eval-framework.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costPerSuccess, spend, statusOf } from "./accounting";
import { percentile } from "./report";
import type { RunResult } from "./types";

export const SURFACES = ["prompt", "model-effort", "skill-description", "retrieval-profile"] as const;
export type Surface = (typeof SURFACES)[number];

/** Surfaces the CLI can apply today; the others are rejected with a clear message. */
export const WIRED: Surface[] = ["prompt", "model-effort"];

export interface Candidate {
  id: string;
  version: number;
  surface: Surface;
  /** e.g. { effort: "medium" } or { guide: "evals/guides/v2.md" }; {} = the baseline. */
  settings: Record<string, string>;
  parent: string | null;
  note: string;
  createdAt: string;
}

export type SplitName = "train" | "validation" | "holdout";

export interface TaskScore {
  id: string;
  passed: number;
  trials: number;
  costUsd: number | null;
  p50Ms: number | null;
}

export interface SplitScore {
  split: SplitName;
  trials: number;
  perTask: TaskScore[];
  passRate: number;
  costPerSuccess: number | null;
  p50Ms: number | null;
  identity: { graders: string; tasks: string };
  costUsd: number;
}

export interface Criteria {
  minGain: number;
  maxCostRatio: number;
  maxLatencyRatio: number;
  minTrials: number;
  iterations: number;
  confidence: number;
}

export const DEFAULT_CRITERIA: Criteria = { minGain: 0.05, maxCostRatio: 1.25, maxLatencyRatio: 1.5, minTrials: 3, iterations: 2000, confidence: 0.95 };

export type Verdict = "accept" | "noise" | "regression" | "too-costly" | "too-slow" | "too-few-trials" | "stale";

export interface Decision {
  verdict: Verdict;
  gain: number;
  ci: [number, number];
  why: string;
}

export interface Round {
  candidateId: string;
  validation: SplitScore;
  decision: Decision;
  at: string;
}

export type StopReason = "budget" | "stalled" | "noise" | "regression" | "done";

export interface Experiment {
  id: string;
  surface: Surface;
  criteria: Criteria;
  budgetUsd: number;
  spentUsd: number;
  baseline: Candidate;
  baselineScore: SplitScore | null;
  candidates: Candidate[];
  rounds: Round[];
  /** The incumbent: the best accepted candidate, or the baseline. Always runnable. */
  best: string;
  bestScore: SplitScore | null;
  trainFailures: { id: string; why: string[] }[];
  stop: StopReason | null;
  release: { candidateId: string; holdout: SplitScore; baselineHoldout: SplitScore } | null;
  createdAt: string;
  updatedAt: string;
}

/** mulberry32: a small, fast, seeded PRNG so runs are reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank quantile of an already-sorted array, q in [0, 1]. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const confidencePct = (c: number): string => `${Math.round(c * 100)}%`;

/** A split's score: one TaskScore per task, pass rate, cost per success, p50 and identity. */
export function scoreOf(run: RunResult, split: SplitName): SplitScore {
  const perTask: TaskScore[] = run.tasks.map((task) => {
    const known = task.trials.map((t) => t.costUsd).filter((c): c is number => c !== null);
    return {
      id: task.id,
      passed: task.trials.filter((t) => statusOf(t) === "passed").length,
      trials: task.trials.length,
      costUsd: known.length ? known.reduce((a, b) => a + b, 0) : null,
      p50Ms: percentile(task.trials.map((t) => t.durationMs), 50),
    };
  });
  const counted = perTask.filter((t) => t.trials > 0);
  const versions = run.meta.manifest?.versions ?? {};
  return {
    split,
    trials: counted.length ? Math.min(...counted.map((t) => t.trials)) : 0,
    perTask,
    passRate: counted.length ? counted.reduce((s, t) => s + t.passed / t.trials, 0) / counted.length : 0,
    costPerSuccess: costPerSuccess(run.tasks).usd ?? null,
    p50Ms: percentile(run.tasks.flatMap((t) => t.trials.map((x) => x.durationMs)), 50),
    identity: { graders: versions.graders ?? "", tasks: versions.tasks ?? "" },
    costUsd: spend(run.tasks).spent.usd,
  };
}

/**
 * Paired bootstrap over the tasks both scores share: resample the per-task pass
 * rate deltas with replacement and report the confidence interval of the mean.
 */
export function pairedBootstrap(base: SplitScore, cand: SplitScore, iterations: number, rng: () => number, confidence = 0.95): { gain: number; lo: number; hi: number } {
  const baseById = new Map(base.perTask.map((t) => [t.id, t]));
  const deltas: number[] = [];
  for (const c of cand.perTask) {
    const b = baseById.get(c.id);
    if (!b || b.trials <= 0 || c.trials <= 0) continue;
    deltas.push(c.passed / c.trials - b.passed / b.trials);
  }
  if (deltas.length === 0) return { gain: 0, lo: 0, hi: 0 };
  const gain = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < deltas.length; j++) sum += deltas[Math.floor(rng() * deltas.length)]!;
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return { gain, lo: quantile(means, alpha), hi: quantile(means, 1 - alpha) };
}

/** Tasks the baseline aced but the candidate never passed: a real regression, not noise. */
function flippedTasks(base: SplitScore, cand: SplitScore): string[] {
  const baseById = new Map(base.perTask.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const c of cand.perTask) {
    const b = baseById.get(c.id);
    if (b && b.trials > 0 && c.trials > 0 && b.passed === b.trials && c.passed === 0) out.push(c.id);
  }
  return out;
}

/**
 * Judge a candidate against the incumbent, in a fixed order: stale identity,
 * too few trials, regression, noise, cost, latency, else accept. Reproducible
 * by default (seededRng(1)).
 */
export function decide(base: SplitScore, cand: SplitScore, criteria: Criteria, rng: () => number = seededRng(1)): Decision {
  const { gain, lo, hi } = pairedBootstrap(base, cand, criteria.iterations, rng, criteria.confidence);
  const ci: [number, number] = [lo, hi];

  const gradersStale = base.identity.graders !== "" && cand.identity.graders !== "" && base.identity.graders !== cand.identity.graders;
  const tasksStale = base.identity.tasks !== "" && cand.identity.tasks !== "" && base.identity.tasks !== cand.identity.tasks;
  if (gradersStale || tasksStale) return { verdict: "stale", gain, ci, why: "the grader or task version changed: re-evaluate both on the new version" };

  if (base.trials < criteria.minTrials || cand.trials < criteria.minTrials)
    return { verdict: "too-few-trials", gain, ci, why: `need at least ${criteria.minTrials} trials per task (baseline ${base.trials}, candidate ${cand.trials})` };

  const flipped = flippedTasks(base, cand);
  if (hi < 0 || flipped.length)
    return { verdict: "regression", gain, ci, why: flipped.length ? `regressed on ${flipped.join(", ")}` : `gain ${signed(gain)} with the whole CI below zero` };

  if (gain < criteria.minGain || lo <= 0)
    return { verdict: "noise", gain, ci, why: `gain ${signed(gain)} (${confidencePct(criteria.confidence)} CI ${signed(lo)} … ${signed(hi)}) is below the ${criteria.minGain} bar` };

  if (base.costPerSuccess !== null && cand.costPerSuccess !== null && base.costPerSuccess > 0 && cand.costPerSuccess / base.costPerSuccess > criteria.maxCostRatio)
    return { verdict: "too-costly", gain, ci, why: `cost per success is ${(cand.costPerSuccess / base.costPerSuccess).toFixed(2)}× the baseline (limit ${criteria.maxCostRatio}×)` };

  if (base.p50Ms !== null && cand.p50Ms !== null && base.p50Ms > 0 && cand.p50Ms / base.p50Ms > criteria.maxLatencyRatio)
    return { verdict: "too-slow", gain, ci, why: `p50 latency is ${(cand.p50Ms / base.p50Ms).toFixed(2)}× the baseline (limit ${criteria.maxLatencyRatio}×)` };

  return { verdict: "accept", gain, ci, why: `accepted: gain ${signed(gain)} (${confidencePct(criteria.confidence)} CI ${signed(lo)} … ${signed(hi)})` };
}

export function newExperiment(o: { id: string; surface: Surface; budgetUsd: number; criteria?: Partial<Criteria>; now?: () => string }): Experiment {
  const now = o.now ?? (() => new Date().toISOString());
  const at = now();
  const baseline: Candidate = { id: "c0", version: 0, surface: o.surface, settings: {}, parent: null, note: "baseline", createdAt: at };
  return {
    id: o.id,
    surface: o.surface,
    criteria: { ...DEFAULT_CRITERIA, ...o.criteria },
    budgetUsd: o.budgetUsd,
    spentUsd: 0,
    baseline,
    baselineScore: null,
    candidates: [baseline],
    rounds: [],
    best: "c0",
    bestScore: null,
    trainFailures: [],
    stop: null,
    release: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Append a candidate, versioned after the highest so far and fathered by the incumbent. Pure. */
export function addCandidate(e: Experiment, settings: Record<string, string>, note: string, now: () => string = () => new Date().toISOString()): { experiment: Experiment; candidate: Candidate } {
  const at = now();
  const version = Math.max(...e.candidates.map((c) => c.version)) + 1;
  const candidate: Candidate = { id: `c${version}`, version, surface: e.surface, settings, parent: e.best, note, createdAt: at };
  return { experiment: { ...e, candidates: [...e.candidates, candidate], updatedAt: at }, candidate };
}

/** Record a round's cost and, when accepted, promote the candidate to incumbent. Pure. */
export function applyRound(e: Experiment, round: Round, costUsd: number): Experiment {
  const next: Experiment = { ...e, rounds: [...e.rounds, round], spentUsd: e.spentUsd + costUsd, updatedAt: round.at };
  if (round.decision.verdict === "accept") {
    next.best = round.candidateId;
    next.bestScore = round.validation;
  }
  return next;
}

/** Whether the loop should stop: out of budget, a regression, or two rounds without an accept. */
export function shouldStop(e: Experiment): StopReason | null {
  if (e.spentUsd >= e.budgetUsd) return "budget";
  const n = e.rounds.length;
  if (n === 0) return null;
  const last = e.rounds[n - 1]!.decision.verdict;
  if (last === "regression") return "regression";
  if (n >= 2) {
    const prev = e.rounds[n - 2]!.decision.verdict;
    if (last !== "accept" && prev !== "accept") return last === "noise" && prev === "noise" ? "noise" : "stalled";
  }
  return null;
}

/** Tasks with any non-passing trial, and the unique grader reasons they failed for. */
export function trainFailures(run: RunResult): { id: string; why: string[] }[] {
  const out: { id: string; why: string[] }[] = [];
  for (const task of run.tasks) {
    if (!task.trials.some((t) => statusOf(t) !== "passed")) continue;
    const why: string[] = [];
    for (const trial of task.trials) {
      for (const g of trial.graders) {
        if (g.pass || why.includes(g.why)) continue;
        why.push(g.why);
        if (why.length >= 5) break;
      }
      if (why.length >= 5) break;
    }
    out.push({ id: task.id, why });
  }
  return out;
}

const fmtSettings = (s: Record<string, string>): string => `{${Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(", ")}}`;

function pairedCount(base: SplitScore | null, cand: SplitScore | null): number {
  if (!base || !cand) return 0;
  const ids = new Set(base.perTask.filter((t) => t.trials > 0).map((t) => t.id));
  return cand.perTask.filter((t) => t.trials > 0 && ids.has(t.id)).length;
}

/** Multi-line plain text: what changed, how sure, what it cost, and every round. */
export function summary(e: Experiment): string {
  const lines: string[] = [];
  const best = e.candidates.find((c) => c.id === e.best);
  const pct = confidencePct(e.criteria.confidence);
  lines.push(`Experiment ${e.id} · surface ${e.surface} · ${e.stop ?? "running"}`);
  lines.push(`Best ${e.best}${best && Object.keys(best.settings).length ? ` ${fmtSettings(best.settings)}` : " (baseline)"}`);

  const bestRound = [...e.rounds].reverse().find((r) => r.candidateId === e.best);
  const gain = bestRound?.decision.gain ?? 0;
  const [lo, hi] = bestRound ? bestRound.decision.ci : ([0, 0] as [number, number]);
  const uncertain = lo <= 0 && hi >= 0;
  lines.push(`Validation gain vs baseline ${signed(gain)} (${pct} CI ${signed(lo)} … ${signed(hi)})${uncertain ? " — uncertain, the CI includes 0" : ""}`);

  lines.push(`Coverage ${pairedCount(e.baselineScore, e.bestScore)} tasks paired · min ${Math.min(e.baselineScore?.trials ?? 0, e.bestScore?.trials ?? 0)} trials`);
  lines.push(`Spent $${e.spentUsd.toFixed(4)} of $${e.budgetUsd.toFixed(4)}`);
  if (e.rounds.length === 0) lines.push("Rounds: none");
  else for (const r of e.rounds) lines.push(`  ${r.candidateId} ${r.decision.verdict}: ${r.decision.why}`);

  if (e.release) {
    const { candidateId, holdout, baselineHoldout } = e.release;
    const rel = pairedBootstrap(baselineHoldout, holdout, e.criteria.iterations, seededRng(1), e.criteria.confidence);
    const relUncertain = rel.lo <= 0 && rel.hi >= 0;
    lines.push(`Release holdout ${candidateId} gain ${signed(rel.gain)} (${pct} CI ${signed(rel.lo)} … ${signed(rel.hi)})${relUncertain ? " — uncertain, the CI includes 0" : ""}`);
  }
  return lines.join("\n");
}

/** Write `<root>/<id>/experiment.json` and one file per candidate; returns the experiment dir. */
export function saveExperiment(root: string, e: Experiment): string {
  const dir = join(root, e.id);
  mkdirSync(join(dir, "candidates"), { recursive: true });
  writeFileSync(join(dir, "experiment.json"), `${JSON.stringify(e, null, 2)}\n`);
  for (const c of e.candidates) writeFileSync(join(dir, "candidates", `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
  return dir;
}

/** Read an experiment back; null when the file is missing or unreadable. */
export function loadExperiment(root: string, id: string): Experiment | null {
  const path = join(root, id, "experiment.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && typeof (parsed as Experiment).id === "string" ? (parsed as Experiment) : null;
  } catch {
    return null;
  }
}
