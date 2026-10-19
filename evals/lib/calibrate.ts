// Grader stability (roadmap P8.2): run the same grader validation N times and
// flag a verdict that flips between runs (a non-deterministic grader). Zero
// model calls: it only re-runs validateTask, which grades the no-op and the
// reference solution.

import { percentile } from "./report";
import type { Task } from "./types";
import type { Validation } from "./validate";

export interface Stability {
  id: string;
  runs: number;
  /** Each run's no-op verdict; a no-op should always fail. */
  noop: boolean[];
  /** Each run's reference verdict, or null when the task has no reference. */
  reference: (boolean | null)[];
  /** Human-readable flip descriptions; empty when every verdict agreed. */
  flips: string[];
  /** Each run's duration in ms. */
  ms: number[];
}

/** A series whose verdicts disagree, described with its pass counts, else null. */
function verdictFlips(label: string, verdicts: boolean[]): string | null {
  if (verdicts.length === 0 || !verdicts.some((v) => v !== verdicts[0])) return null;
  const passed = verdicts.filter(Boolean).length;
  return `${label} verdict flips (${passed}/${verdicts.length} passed)`;
}

export async function stability(
  task: Task,
  n: number,
  validate: (task: Task) => Promise<Validation>,
  now: () => number = () => performance.now(),
): Promise<Stability> {
  const noop: boolean[] = [];
  const reference: (boolean | null)[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const started = now();
    const v = await validate(task);
    ms.push(now() - started);
    // A skipped task can't be graded at all: one call is enough, report no runs.
    if (v.skipped) return { id: task.id, runs: 0, noop: [], reference: [], flips: [], ms: [] };
    noop.push(v.noop.pass);
    reference.push(v.reference ? v.reference.pass : null);
  }
  const refVerdicts = reference.filter((r): r is boolean => r !== null);
  const flips = [verdictFlips("no-op", noop), verdictFlips("reference", refVerdicts)].filter((f): f is string => f !== null);
  return { id: task.id, runs: n, noop, reference, flips, ms };
}

export function formatStability(s: Stability): string {
  const p50 = percentile(s.ms, 50);
  const max = s.ms.length ? Math.max(...s.ms) : null;
  return `${s.flips.length ? "FLAKY" : "OK   "} ${s.id.padEnd(24)} ${s.runs}x  p50 ${p50 === null ? "-" : Math.round(p50)}ms  max ${max === null ? "-" : Math.round(max)}ms  ${s.flips.join("; ")}`;
}
