import type { StoredEvent } from "../../shared/types";

export type Todo = { seq: number; entries: Extract<StoredEvent["event"], { kind: "plan" }>["entries"] };

/**
 * The plan the todo dock shows: the thread's latest `plan` row, while it is
 * still open or was written after the last top-level user message. Agents
 * resend the whole list on each update, so only the latest one matters.
 */
export function dockedPlan(events: StoredEvent[]): Todo | null {
  let plan: Todo | null = null;
  let fresh = false;
  for (const e of events) {
    const ev = e.event;
    if (ev.kind === "user" && !ev.parentId) fresh = false;
    else if (ev.kind === "plan" && !ev.parentId) {
      plan = { seq: e.seq, entries: ev.entries };
      fresh = true;
    }
  }
  if (!plan || plan.entries.length === 0) return null;
  const open = plan.entries.some((p) => p.status !== "completed");
  return open || fresh ? plan : null;
}

export function todoProgress(entries: Todo["entries"]): { done: number; total: number; current: string | null } {
  const done = entries.filter((p) => p.status === "completed").length;
  const current = entries.find((p) => p.status === "in_progress") ?? entries.find((p) => p.status !== "completed");
  return { done, total: entries.length, current: current?.content ?? null };
}
