// A team's runs: one per member handoff, folded out of a thread's stored
// events with its status, latency and cost. Pure, so the strip and a test
// share the same reading of the log.

import type { RunUsage, StoredEvent } from "./types";

export interface MemberRun {
  memberId: string;
  toolUseId: string;
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  summary: string;
  usage: RunUsage | null;
}

/**
 * Every member handoff in a thread, in event order. A run starts at an `Agent`
 * tool-use whose summary ends in ` · <id>` for a known member (the roster in
 * expertBlock), keyed by its toolUseId. Its tool-result ends it: done, or
 * failed when isError. A run still open when a later user event, a root
 * turn-end or an error arrives is stopped (a member's own child events carry
 * parentId, so they never close it); one still open at the end is running.
 */
export function memberRuns(events: StoredEvent[], memberIds: string[]): MemberRun[] {
  const runs: MemberRun[] = [];
  const open = new Map<string, MemberRun>();
  const stop = (at: number): void => {
    for (const run of open.values()) {
      run.status = "stopped";
      run.endedAt = at;
      run.durationMs = at - run.startedAt;
      run.summary = "";
    }
    open.clear();
  };
  for (const stored of events) {
    const e = stored.event;
    if (e.kind === "tool-use" && e.name === "Agent") {
      const id = memberIds.find((m) => e.summary.endsWith(` · ${m}`));
      if (!id) continue;
      const run: MemberRun = { memberId: id, toolUseId: e.toolUseId, status: "running", startedAt: stored.createdAt, endedAt: null, durationMs: null, summary: "", usage: null };
      runs.push(run);
      open.set(e.toolUseId, run);
    } else if (e.kind === "tool-result") {
      const run = open.get(e.toolUseId);
      if (!run) continue;
      run.status = e.isError ? "failed" : "done";
      run.endedAt = stored.createdAt;
      run.durationMs = stored.createdAt - run.startedAt;
      run.summary = e.summary.slice(0, 160);
      run.usage = e.runUsage ?? null;
      open.delete(e.toolUseId);
    } else if (e.kind === "error") {
      stop(stored.createdAt);
    } else if (!e.parentId && (e.kind === "user" || e.kind === "turn-end")) {
      stop(stored.createdAt);
    }
  }
  return runs;
}

export interface MemberTotals {
  runs: number;
  failed: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when no finished run reported a cost. */
  costUsd: number | null;
  /** Finished runs without a cost. */
  unpriced: number;
}

/** One member's totals over its finished (non-running) runs. */
export function memberTotals(runs: MemberRun[], memberId: string): MemberTotals {
  const totals: MemberTotals = { runs: 0, failed: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: null, unpriced: 0 };
  let cost = 0;
  for (const run of runs) {
    if (run.memberId !== memberId || run.status === "running") continue;
    totals.runs++;
    if (run.status === "failed") totals.failed++;
    totals.durationMs += run.durationMs ?? 0;
    totals.inputTokens += run.usage?.inputTokens ?? 0;
    totals.outputTokens += run.usage?.outputTokens ?? 0;
    const c = run.usage?.costUsd;
    if (c != null) cost += c;
    else totals.unpriced++;
  }
  if (totals.unpriced < totals.runs) totals.costUsd = cost;
  return totals;
}

/** "850 ms", "4.2 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.floor((ms % 60000) / 1000)} s`;
}

/** "12.3k" past a thousand, else the number. */
function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One run as a single line: its status, latency and, when reported, tokens and cost. */
export function runLine(r: MemberRun): string {
  if (r.status === "running") return "working";
  const head = `${r.status} · ${formatDuration(r.durationMs ?? 0)}`;
  if (!r.usage) return head;
  const tokens = `${k(r.usage.inputTokens + r.usage.outputTokens)} tokens`;
  const cost = r.usage.costUsd !== null ? ` · $${r.usage.costUsd.toFixed(4)}` : "";
  return `${head} · ${tokens}${cost}`;
}
