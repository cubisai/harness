import type { Thread } from "../../shared/types";

/** A thread idle longer than this, and not running, is Settled. */
export const SETTLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export type SectionName = "Pinned" | "Active" | "Settled";

export interface ThreadSection {
  name: SectionName;
  threads: Thread[];
}

export interface SectionInput {
  running: Record<string, boolean>;
  pinned: Record<string, boolean>;
  now: number;
}

/**
 * A project's threads in lifecycle sections: Pinned, then Active, then
 * Settled (idle over three days and not running). Newest first within a
 * section; empty sections are left out.
 */
export function sectionThreads(threads: Thread[], { running, pinned, now }: SectionInput): ThreadSection[] {
  const byName: Record<SectionName, Thread[]> = { Pinned: [], Active: [], Settled: [] };
  for (const t of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (pinned[t.id]) byName.Pinned.push(t);
    else if (!running[t.id] && now - t.updatedAt > SETTLE_AFTER_MS) byName.Settled.push(t);
    else byName.Active.push(t);
  }
  return (["Pinned", "Active", "Settled"] as const).filter((name) => byName[name].length).map((name) => ({ name, threads: byName[name] }));
}

/** The nth (1-based) thread in the sidebar's visible order, or null when there are fewer. */
export function nthVisibleThread(threads: Thread[], n: number, input: SectionInput): Thread | null {
  return sectionThreads(threads, input).flatMap((s) => s.threads)[n - 1] ?? null;
}
