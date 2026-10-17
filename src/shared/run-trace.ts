// Run traces: timed events folded into spans, and the versioned manifest that
// names everything a run's result depends on (roadmap 13 §5.2). Pure, so the
// eval runner and the app share it.

import type { ThreadEvent } from "./types";

export const RUN_MANIFEST_VERSION = 1;

/** Where a usage/cost figure came from; missing is "unavailable", never zero. */
export type UsageCoverage = "reported" | "estimated" | "unavailable";

export interface RunManifest {
  version: typeof RUN_MANIFEST_VERSION;
  runId: string;
  origin: "eval" | "thread" | "automation" | "background";
  agent: string;
  /** What was asked for and what ran ("default" can resolve to a concrete model). */
  requestedModel: string;
  model: string;
  protocol: string;
  effort: string | null;
  /** Hashes of the inputs that change behaviour: guide, harness code, graders, task set. */
  versions: Record<string, string>;
  /** USD per 1M tokens and where it came from; null = no price, so cost may be unknown. */
  price: { input: number; output: number; source: string } | null;
  budget: Record<string, number | null>;
  /** What the trace can and can't show for this engine. */
  fidelity: string;
  platform: string;
  startedAt: string;
}

/** An event with its offset from the trial's start, in ms. */
export interface TimedEvent {
  t: number;
  event: ThreadEvent;
}

export type SpanKind = "tool" | "child" | "compaction" | "check";

export interface Span {
  kind: SpanKind;
  id: string;
  name: string;
  start: number;
  /** null: never finished (cancelled, crashed or still running). */
  end: number | null;
  isError?: boolean;
  /** The Agent/task call a child span runs under. */
  parentId?: string;
}

const CHILD_TOOLS = new Set(["Agent", "Task", "task", "spawn_agent"]);

/** Tool calls (subagent calls as "child"), compactions and checks, in start order. */
export function spansOf(events: TimedEvent[]): Span[] {
  const spans: Span[] = [];
  const open = new Map<string, Span>();
  for (const { t, event: e } of events) {
    if (e.kind === "tool-use") {
      const span: Span = { kind: CHILD_TOOLS.has(e.name) ? "child" : "tool", id: e.toolUseId, name: e.name, start: t, end: null };
      if (e.parentId) span.parentId = e.parentId;
      open.set(e.toolUseId, span);
      spans.push(span);
    } else if (e.kind === "tool-result") {
      const span = open.get(e.toolUseId);
      if (!span) continue;
      span.end = t;
      span.isError = e.isError;
      open.delete(e.toolUseId);
    } else if (e.kind === "compaction") {
      spans.push({ kind: "compaction", id: `compaction-${spans.length}`, name: e.trigger, start: t, end: t });
    } else if (e.kind === "check") {
      spans.push({ kind: "check", id: `check-${e.round}`, name: e.command, start: Math.max(0, t - e.durationMs), end: t, isError: e.ok === false });
    }
  }
  return spans;
}

/**
 * The turn's own turn-end: a subagent's turn-end (parentId set) covers only
 * the child, so taking the last turn-end blindly could report a member's usage
 * as the whole turn's.
 */
export function rootTurnEnd(events: ThreadEvent[]): Extract<ThreadEvent, { kind: "turn-end" }> | undefined {
  return events.findLast((e): e is Extract<ThreadEvent, { kind: "turn-end" }> => e.kind === "turn-end" && !e.parentId);
}

/** Time spent in tools vs the rest (model + overhead), from spans; overlapping tool calls count once. */
export function timeSplit(spans: Span[], totalMs: number): { toolMs: number; otherMs: number } {
  const ranges = spans
    .filter((s) => (s.kind === "tool" || s.kind === "child") && s.end !== null && !s.parentId)
    .map((s) => [s.start, s.end!] as const)
    .sort((a, b) => a[0] - b[0]);
  let toolMs = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [a, b] of ranges) {
    if (a > curEnd) {
      if (curEnd > curStart) toolMs += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else curEnd = Math.max(curEnd, b);
  }
  if (curEnd > curStart) toolMs += curEnd - curStart;
  return { toolMs, otherMs: Math.max(0, totalMs - toolMs) };
}
