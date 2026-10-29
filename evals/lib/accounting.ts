// Eval accounting: measured task cost vs this run's spend, coverage, and cost
// per success (roadmap 13 §2.1, §2.3). Missing cost stays unknown, never zero.

import type { Coverage, TaskResult, TrialResult, TrialStatus } from "./types";

/** A stored trial's status; old run files have none, so derive it from their fields. */
export function statusOf(t: TrialResult): TrialStatus {
  if (t.status) return t.status;
  if (t.harnessError) return "harness-error";
  if (t.pass) return "passed";
  return t.overBudget ? "budget-stop" : "failed";
}

/** A trial counts as a quality pass only with status "passed". */
export const passed = (t: TrialResult): boolean => statusOf(t) === "passed";

/** Old run files carry costUsd without a coverage label: a number is treated as reported. */
export function costCoverageOf(t: TrialResult): Coverage {
  return t.costCoverage ?? (t.costUsd === null ? "unavailable" : "reported");
}

export interface CostTotal {
  usd: number;
  /** Trials with a known cost, out of `trials`. */
  known: number;
  trials: number;
}

const total = (trials: TrialResult[]): CostTotal => ({
  usd: trials.reduce((s, t) => s + (t.costUsd ?? 0), 0),
  known: trials.filter((t) => t.costUsd !== null).length,
  trials: trials.length,
});

const fresh = (task: TaskResult, t: TrialResult): boolean => !t.cached && !task.cached;

export interface Spend {
  /** What the task attempts cost when they ran, cached ones included. */
  measured: CostTotal;
  /** What this run paid: fresh trials only. */
  spent: CostTotal;
}

export function spend(tasks: TaskResult[]): Spend {
  const all = tasks.flatMap((task) => task.trials);
  const now = tasks.flatMap((task) => task.trials.filter((t) => fresh(task, t)));
  return { measured: total(all), spent: total(now) };
}

export interface CostPerSuccess {
  /** Weighted mean cost per case ÷ weighted mean pass rate; null when unknown or nothing passed. */
  usd: number | null;
  passRate: number;
  /** Mean attempt cost over the cases, weighted; null when any attempt's cost is unknown. */
  meanCost: number | null;
  /** Cases whose every attempt has a known cost. */
  covered: number;
  cases: number;
}

/**
 * Cost per success over a task distribution: mean cost and pass rate per case
 * first, then a weighted average over cases, so a case run more often doesn't
 * dominate. Every attempt counts, failures included.
 */
export function costPerSuccess(tasks: TaskResult[], weights: Record<string, number> = {}): CostPerSuccess {
  const cases = tasks.filter((t) => t.trials.length > 0);
  let wSum = 0;
  let passSum = 0;
  let costSum = 0;
  let covered = 0;
  for (const task of cases) {
    const w = weights[task.id] ?? 1;
    wSum += w;
    passSum += (w * task.trials.filter(passed).length) / task.trials.length;
    if (task.trials.every((t) => t.costUsd !== null)) {
      covered++;
      costSum += (w * task.trials.reduce((s, t) => s + (t.costUsd ?? 0), 0)) / task.trials.length;
    }
  }
  const passRate = wSum === 0 ? 0 : passSum / wSum;
  const meanCost = wSum === 0 || covered < cases.length ? null : costSum / wSum;
  return { usd: meanCost === null || passRate === 0 ? null : meanCost / passRate, passRate, meanCost, covered, cases: cases.length };
}

/** Why a run can't stand as a quality result: harness errors, short trials, tasks never run. */
export function incomplete(tasks: TaskResult[], expectedTasks: number): string[] {
  const out: string[] = [];
  const errored = tasks.filter((task) => task.trials.some((t) => statusOf(t) === "harness-error" || statusOf(t) === "cancelled"));
  if (errored.length) out.push(`harness error or cancel in ${errored.map((t) => t.id).join(", ")}`);
  const short = tasks.filter((task) => task.requestedTrials !== undefined && task.trials.length < task.requestedTrials);
  if (short.length) out.push(`fewer trials than requested in ${short.map((t) => `${t.id} (${t.trials.length}/${t.requestedTrials})`).join(", ")}`);
  const ungraded = tasks.filter((task) => task.trials.some((t) => statusOf(t) === "ungraded"));
  if (ungraded.length) out.push(`ungraded trials in ${ungraded.map((t) => t.id).join(", ")}`);
  if (tasks.length < expectedTasks) out.push(`${expectedTasks - tasks.length} of ${expectedTasks} tasks not run`);
  return out;
}

/** "$0.1234", "$0.1234+ (3/5 costed)" when partly known, "unknown" when nothing is. */
export function formatCost(c: CostTotal): string {
  if (c.trials > 0 && c.known === 0) return "unknown";
  return c.known < c.trials ? `$${c.usd.toFixed(4)}+ (${c.known}/${c.trials} costed)` : `$${c.usd.toFixed(4)}`;
}

/** One-line accounting footer: measured cost, this run's spend, cost per success. */
export function accountingLine(tasks: TaskResult[]): string {
  const s = spend(tasks);
  const cps = costPerSuccess(tasks);
  const per = cps.usd === null ? (cps.passRate === 0 ? "none passed" : "unknown") : `$${cps.usd.toFixed(4)}`;
  return `measured ${formatCost(s.measured)} · spent now ${formatCost(s.spent)} · cost/success ${per} (pass rate ${(cps.passRate * 100).toFixed(0)}%, ${cps.covered}/${cps.cases} cases costed)`;
}
