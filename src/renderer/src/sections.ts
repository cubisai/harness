import type { Thread, ThreadKind } from "../../shared/types";

export interface InboxInput {
  running: Record<string, boolean>;
  /** Threads with a permission, plan or question waiting on the user. */
  waiting?: ReadonlySet<string>;
  /** Overrides each thread's own `pinned` (previews and tests). */
  pinned?: Record<string, boolean>;
  /** Show only threads of this kind (Chat or Design mode); Running still lists every kind. */
  kind?: ThreadKind;
}

/** The sidebar's inbox: live threads, pins, then everything else, across projects. */
export interface InboxModel {
  /** Running or waiting on the user, newest first. A pinned thread shows here while it runs. */
  running: Thread[];
  pinned: Thread[];
  /** The rest, newest first. */
  recent: Thread[];
  /** `recent` by project, in the projects' own order; projects without recent threads are kept (empty). */
  groups: { projectId: string; threads: Thread[] }[];
  /** Archived threads per project, newest first. */
  archived: Record<string, Thread[]>;
}

const newestFirst = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;

/** Sort every project's threads into the sidebar's Running / Pinned / Recent sections. */
export function inboxModel(projectIds: string[], threads: Record<string, Thread[]>, { running, waiting, pinned, kind }: InboxInput): InboxModel {
  const model: InboxModel = { running: [], pinned: [], recent: [], groups: [], archived: {} };
  for (const projectId of projectIds) {
    const group: Thread[] = [];
    for (const t of threads[projectId] ?? []) {
      const live = !t.archived && (running[t.id] || waiting?.has(t.id));
      // A running thread of the other kind is never hidden.
      if (kind && !live && threadKind(t) !== kind) continue;
      if (t.archived) (model.archived[projectId] ??= []).push(t);
      else if (live) model.running.push(t);
      else if (pinned?.[t.id] ?? t.pinned) model.pinned.push(t);
      else group.push(t);
    }
    group.sort(newestFirst);
    model.groups.push({ projectId, threads: group });
    model.recent.push(...group);
    model.archived[projectId]?.sort(newestFirst);
  }
  model.running.sort(newestFirst);
  model.pinned.sort(newestFirst);
  model.recent.sort(newestFirst);
  return model;
}

/** A thread's kind; older threads have none and are chats. */
export const threadKind = (t: Pick<Thread, "kind">): ThreadKind => t.kind ?? "chat";

/** The threads in the order the sidebar shows them (archived and collapsed groups left out). */
export function visibleThreads(model: InboxModel, opts: { groupByProject: boolean; collapsed?: Record<string, boolean> }): Thread[] {
  const recent = opts.groupByProject ? model.groups.filter((g) => !opts.collapsed?.[g.projectId]).flatMap((g) => g.threads) : model.recent;
  return [...model.running, ...model.pinned, ...recent];
}

/** The nth (1-based) thread in the sidebar's visible order, or null when there are fewer. */
export function nthVisibleThread(model: InboxModel, n: number, opts: { groupByProject: boolean; collapsed?: Record<string, boolean> }): Thread | null {
  return visibleThreads(model, opts)[n - 1] ?? null;
}

/** Threads with a permission, plan or question waiting on the user. */
export function waitingThreads(...pending: { threadId: string }[][]): Set<string> {
  return new Set(pending.flat().map((p) => p.threadId));
}

/** A row's time on the right: "now", "5m", "3h", "Yd" (yesterday), a weekday this week, else "Sep 4". */
export function shortTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  const then = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return `${Math.floor(s / 3600)}h`;
  if (at >= startOfToday - 86_400_000) return "Yd";
  if (at >= startOfToday - 6 * 86_400_000) return then.toLocaleDateString(undefined, { weekday: "short" });
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Elapsed time of a running turn: "12s", "4m", "1h 5m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
