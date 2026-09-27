import { useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../../../shared/types";

/**
 * The message box's agent picker. A styled menu rather than a native
 * <select>: on Windows Chromium draws a <select>'s popup in the system's
 * light colours even in the app's dark theme. Same classes as ModelPicker.
 */
export function AgentPicker({
  agents,
  current,
  disabled,
  onPick,
}: {
  agents: AgentInfo[];
  current: string;
  disabled?: boolean;
  onPick(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const label = agents.find((a) => a.id === current)?.label ?? current;

  useEffect(() => setIndex(Math.max(0, agents.findIndex((a) => a.id === current))), [agents, current, open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (id: string) => {
    setOpen(false);
    if (id !== current) onPick(id);
  };

  return (
    <div
      className="model-picker"
      ref={box}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setIndex((i) => Math.min(agents.length - 1, i + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setIndex((i) => Math.max(0, i - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const a = agents[index];
          if (a) pick(a.id);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className="select ghost-select model-picker-button"
        title={`Agent: ${label}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className="model-menu up">
          <div className="model-list" role="listbox" aria-label="Agent">
            {agents.map((a, i) => (
              <button
                key={a.id}
                role="option"
                aria-selected={a.id === current}
                className={`model-item${i === index ? " active" : ""}${a.id === current ? " current" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
