import type { PermissionRequest, Thread } from "../../shared/types";
import type { AutomationNotice } from "../../shared/automations";

/** A turn that ended while its thread wasn't the one on screen. */
export interface FinishedTurn {
  threadId: string;
  durationMs: number;
  endedAt: number;
}

/** One Message Center row: something waiting on the user, or a turn that finished out of sight. */
export type InboxRow =
  | { kind: "permission"; threadId: string; requestId: string; thread: Thread | null; summary: string }
  | { kind: "finished"; threadId: string; thread: Thread | null; durationMs: number; endedAt: number; automation?: AutomationNotice }
  | { kind: "automation"; threadId: string | null; thread: Thread | null; notice: AutomationNotice };

export interface InboxInput {
  permissions: PermissionRequest[];
  finished: FinishedTurn[];
  threads: Record<string, Thread[]>;
  selectedThreadId: string | null;
  automations?: AutomationNotice[];
}

/** A run that wants the user: it stopped at its budget, failed, was interrupted, or only partly delivered. */
const ALERT_STATUSES = new Set<AutomationNotice["status"]>(["paused-budget", "failed", "interrupted", "partial"]);

/**
 * The Message Center: permissions pending on threads other than the open one
 * (the open one shows its own card), then runs that need the user, then turns
 * that finished unseen, newest first. Transient notices never land here.
 */
export function inboxRows({ permissions, finished, threads, selectedThreadId, automations = [] }: InboxInput): { needsYou: InboxRow[]; finished: InboxRow[] } {
  const byId = new Map<string, Thread>();
  for (const list of Object.values(threads)) for (const t of list) byId.set(t.id, t);
  // A no-thread notice is never the selected thread's; a threaded one hides while its thread is open.
  const alerts = automations.filter((n) => ALERT_STATUSES.has(n.status) && (n.threadId === null || n.threadId !== selectedThreadId));
  const byThread = new Map<string, AutomationNotice>();
  for (const n of automations) if (n.threadId !== null) byThread.set(n.threadId, n);
  return {
    needsYou: [
      ...permissions
        .filter((p) => p.threadId !== selectedThreadId)
        .map((p) => ({ kind: "permission" as const, threadId: p.threadId, requestId: p.requestId, thread: byId.get(p.threadId) ?? null, summary: p.summary })),
      ...alerts.map((n) => ({ kind: "automation" as const, threadId: n.threadId, thread: n.threadId ? (byId.get(n.threadId) ?? null) : null, notice: n })),
    ],
    finished: finished
      .filter((f) => f.threadId !== selectedThreadId)
      .sort((a, b) => b.endedAt - a.endedAt)
      .map((f) => ({
        kind: "finished" as const,
        threadId: f.threadId,
        thread: byId.get(f.threadId) ?? null,
        durationMs: f.durationMs,
        endedAt: f.endedAt,
        ...(byThread.has(f.threadId) ? { automation: byThread.get(f.threadId) } : {}),
      })),
  };
}

/** How an automation run ended, for a Message Center row's meta. */
export function automationText(n: AutomationNotice): string {
  const outcome =
    n.status === "paused-budget"
      ? "paused at its budget"
      : n.status === "failed"
        ? n.error
          ? `failed: ${n.error.slice(0, 80)}`
          : "failed"
        : n.status === "interrupted"
          ? "was interrupted"
          : n.status === "partial"
            ? "finished, but its result may not have been delivered"
            : "finished";
  return n.costUsd === null ? outcome : `${outcome} · $${n.costUsd.toFixed(2)}`;
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
