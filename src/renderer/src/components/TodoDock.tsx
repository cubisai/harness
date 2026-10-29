import { useMemo, useState } from "react";
import { create } from "zustand";
import { useStore } from "../store";
import { IconCheck, IconChevronUp, IconClose, IconTodo, IconTodoActive } from "../icons";
import { dockedPlan, todoProgress } from "../todo";

/** The list the user dismissed, per thread, for this session: the dock and the timeline both read it. */
export const useDismissedPlans = create<{ seqs: Record<string, number>; dismiss: (threadId: string, seq: number) => void }>((set) => ({
  seqs: {},
  dismiss: (threadId, seq) => set((s) => ({ seqs: { ...s.seqs, [threadId]: seq } })),
}));

const EMPTY: never[] = [];
/** Collapsed choice per thread, for this session only. */
const collapsedByThread = new Map<string, boolean>();

/**
 * The agent's todo list, docked above the message box: one summary line when
 * collapsed, the full checklist (growing upward) when open.
 */
export function TodoDock({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]) ?? EMPTY;
  const dismissed = useDismissedPlans((s) => s.seqs[threadId]);
  const plan = useMemo(() => dockedPlan(events, dismissed), [events, dismissed]);
  const [collapsed, setCollapsed] = useState(() => collapsedByThread.get(threadId) ?? false);
  if (!plan) return null;
  const { done, total, current } = todoProgress(plan.entries);
  const toggle = () => {
    collapsedByThread.set(threadId, !collapsed);
    setCollapsed(!collapsed);
  };
  const id = `todo-${threadId}`;
  return (
    <div className="todo-dock">
      <section className="todo-card" aria-label="Todo list">
        <div className="todo-head-row">
          <button className="todo-head" aria-expanded={!collapsed} aria-controls={id} onClick={toggle}>
            <span className="todo-count">
              {done}/{total}
            </span>
            {plan.paused && <span className="todo-paused">Paused</span>}
            <span className="todo-summary">{done === total ? "All done" : (current ?? "Todo")}</span>
            <span className={`todo-chevron${collapsed ? "" : " open"}`}>
              <IconChevronUp />
            </span>
          </button>
          {/* Any list can go: a newer one from the agent docks again. */}
          <button className="todo-dismiss" title="Dismiss this list" aria-label="Dismiss this list" onClick={() => useDismissedPlans.getState().dismiss(threadId, plan.seq)}>
            <IconClose size={12} />
          </button>
        </div>
        {!collapsed && (
          <ul id={id} className="todo-list">
            {plan.entries.map((p, i) => (
              <li key={i} className={`todo-item ${p.status}`}>
                <span className="todo-mark" aria-hidden>
                  {p.status === "completed" ? <IconCheck /> : p.status === "in_progress" ? <IconTodoActive /> : <IconTodo />}
                </span>
                <span className="todo-text">{p.content}</span>
                <span className="todo-state">{p.status === "completed" ? "done" : p.status === "in_progress" ? "in progress" : "to do"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
