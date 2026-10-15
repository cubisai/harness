// S1, the live scorecard: pure rules that turn one finished turn's facts into
// signals and a health. Zero tokens: everything here reads what the turn did.

import type { Health, TurnSignal } from "../../shared/learn";

/** A next message that pushes back on the last answer. */
const CORRECTION =
  /^\s*(?:no\b|nope\b|wrong\b|revert\b|undo\b)|\b(?:that'?s (?:not|wrong)|that is (?:not|wrong)|you didn'?t|didn'?t (?:work|fix|help)|doesn'?t work|still (?:fails?|broken|wrong|failing)|not what i (?:asked|wanted|meant)|i said\b|why did you|you (?:broke|deleted|removed))/i;

/** Whether the user's next message corrects the turn before it. */
export function isCorrection(text: string): boolean {
  const first = text.trim().split(/\n/)[0] ?? "";
  return CORRECTION.test(first.slice(0, 300));
}

/** Commands that failed at least `min` times this turn, with their counts. */
export function failingRepeats(failed: readonly string[], min = 3): { command: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of failed) {
    const key = c.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= min).map(([command, count]) => ({ command, count }));
}

/** The middle value; 0 for none. */
export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Whether a turn ran far past the project's norm: more than 3× the median
 * steps or tokens of its recent healthy turns, once there are at least 5.
 */
export function overNorm(turn: { steps: number; tokens: number }, healthy: readonly { steps: number; tokens: number }[]): string | null {
  if (healthy.length < 5) return null;
  const steps = median(healthy.map((h) => h.steps));
  const tokens = median(healthy.map((h) => h.tokens));
  if (steps >= 2 && turn.steps > 3 * steps) return `${turn.steps} tool calls (usual ${Math.round(steps)})`;
  if (tokens >= 1000 && turn.tokens > 3 * tokens) return `${Math.round(turn.tokens / 1000)}k tokens (usual ${Math.round(tokens / 1000)}k)`;
  return null;
}

/** An evidence-gate flag as a signal: deleted or loosened tests and unbacked claims fail; edited tests warn. */
export function evidenceSignal(flag: string): TurnSignal {
  const warn = /^Changed existing tests/.test(flag);
  return { kind: "evidence", level: warn ? "warn" : "fail", detail: flag };
}

/** What one round of a turn did, as the scorecard reads it. */
export interface TurnFacts {
  evidence: string[];
  /** The project check this round: null when it didn't run. */
  check: { ok: boolean; command: string } | null;
  /** This round is an automatic fix round (round > 0). */
  fixRound: boolean;
  denied: number;
  stopped: boolean;
  failedCommands: string[];
  steps: number;
  tokens: number;
}

/** The signals one round raises (corrections and reverts arrive later, from outside the turn). */
export function roundSignals(f: TurnFacts, healthy: readonly { steps: number; tokens: number }[]): TurnSignal[] {
  const out: TurnSignal[] = f.evidence.map(evidenceSignal);
  if (f.check && !f.check.ok) out.push({ kind: "check-failed", level: "fail", detail: `${f.check.command} failed` });
  if (f.check?.ok && f.fixRound) out.push({ kind: "check-fixed", level: "warn", detail: `${f.check.command} passed after a fix round` });
  if (f.denied) out.push({ kind: "denied", level: "warn", detail: f.denied === 1 ? "You denied a call" : `You denied ${f.denied} calls` });
  if (f.stopped) out.push({ kind: "stopped", level: "warn", detail: "You pressed Stop" });
  for (const r of failingRepeats(f.failedCommands)) out.push({ kind: "loop", level: "warn", detail: `Ran a failing command ${r.count}×: ${clip(r.command, 80)}` });
  const norm = overNorm(f, healthy);
  if (norm) out.push({ kind: "over-norm", level: "warn", detail: `Ran long: ${norm}` });
  return out;
}

/**
 * Fold a later round's signals into the turn's: a fix round that made the check
 * pass replaces the earlier failure; anything else adds up, without repeats.
 */
export function mergeSignals(prev: readonly TurnSignal[], next: readonly TurnSignal[]): TurnSignal[] {
  const fixed = next.some((s) => s.kind === "check-fixed");
  const kept = fixed ? prev.filter((s) => s.kind !== "check-failed") : [...prev];
  for (const s of next) if (!kept.some((k) => k.kind === s.kind && k.detail === s.detail)) kept.push(s);
  return kept;
}

/** The worst level among the signals. */
export function healthOf(signals: readonly TurnSignal[]): Health {
  if (signals.some((s) => s.level === "fail")) return "fail";
  if (signals.length) return "warn";
  return "ok";
}

function clip(text: string, max: number): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
