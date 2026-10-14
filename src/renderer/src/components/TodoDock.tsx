import { useMemo, useState } from "react";
import { useStore } from "../store";
import { IconCheck, IconChevronUp, IconTodo, IconTodoActive } from "../icons";
import { dockedPlan, todoProgress } from "../todo";

const EMPTY: never[] = [];
/** Collapsed choice per thread, for this session only. */
const collapsedByThread = new Map<string, boolean>();

/**
 * The agent's todo list, docked above the message box: one summary line when
 * collapsed, the full checklist (growing upward) when open.
 */
export function TodoDock({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]) ?? EMPTY;
  const plan = useMemo(() => dockedPlan(events), [events]);
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
        <button className="todo-head" aria-expanded={!collapsed} aria-controls={id} onClick={toggle}>
          <span className="todo-count">
            {done}/{total}
          </span>
          <span className="todo-summary">{done === total ? "All done" : (current ?? "Todo")}</span>
          <span className={`todo-chevron${collapsed ? "" : " open"}`}>
            <IconChevronUp />
          </span>
        </button>
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
