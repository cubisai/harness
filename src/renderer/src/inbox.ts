import type { PermissionRequest, Thread } from "../../shared/types";

/** A turn that ended while its thread wasn't the one on screen. */
export interface FinishedTurn {
  threadId: string;
  durationMs: number;
  endedAt: number;
}

/** One Message Center row: something waiting on the user, or a turn that finished out of sight. */
export type InboxRow =
  | { kind: "permission"; threadId: string; requestId: string; thread: Thread | null; summary: string }
  | { kind: "finished"; threadId: string; thread: Thread | null; durationMs: number; endedAt: number };

export interface InboxInput {
  permissions: PermissionRequest[];
  finished: FinishedTurn[];
  threads: Record<string, Thread[]>;
  selectedThreadId: string | null;
}

/**
 * The Message Center: permissions pending on threads other than the open one
 * (the open one shows its own card), then turns that finished unseen, newest
 * first. Transient notices never land here.
 */
export function inboxRows({ permissions, finished, threads, selectedThreadId }: InboxInput): { needsYou: InboxRow[]; finished: InboxRow[] } {
  const byId = new Map<string, Thread>();
  for (const list of Object.values(threads)) for (const t of list) byId.set(t.id, t);
  return {
    needsYou: permissions
      .filter((p) => p.threadId !== selectedThreadId)
      .map((p) => ({ kind: "permission", threadId: p.threadId, requestId: p.requestId, thread: byId.get(p.threadId) ?? null, summary: p.summary })),
    finished: finished
      .filter((f) => f.threadId !== selectedThreadId)
      .sort((a, b) => b.endedAt - a.endedAt)
      .map((f) => ({ kind: "finished", threadId: f.threadId, thread: byId.get(f.threadId) ?? null, durationMs: f.durationMs, endedAt: f.endedAt })),
  };
}

/**
 * Record a turn's end: a Finished row when its thread isn't on screen (one row
 * per thread, the latest turn), nothing when it is.
 */
export function turnEnded(finished: FinishedTurn[], threadId: string, startedAt: number | undefined, now: number, selectedThreadId: string | null): FinishedTurn[] {
  if (threadId === selectedThreadId) return finished;
  const rest = finished.filter((f) => f.threadId !== threadId);
  return [...rest, { threadId, durationMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt), endedAt: now }];
}

/** Opening a thread clears its Finished row. */
export function threadSeen(finished: FinishedTurn[], threadId: string | null): FinishedTurn[] {
  return threadId && finished.some((f) => f.threadId === threadId) ? finished.filter((f) => f.threadId !== threadId) : finished;
}

/** "42s", "3m 04s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
