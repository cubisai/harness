import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";

/**
 * The reasoning-effort picker: a brain button after the model picker, opening
 * upward. Only the current model's levels are listed, with "Default" first.
 */
export function EffortPicker({
  options,
  current,
  defaultEffort,
  disabled,
  onPick,
}: {
  options: string[];
  current: string | null;
  defaultEffort?: string;
  disabled?: boolean;
  onPick(effort: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!options.length) return null;

  const pick = (effort: string | null) => {
    setOpen(false);
    if (effort !== current) onPick(effort);
  };

  return (
    <div className="model-picker" ref={box}>
      <button
        className="select ghost-select model-picker-button effort-picker"
        title="Reasoning effort (Ctrl+Alt+, / Ctrl+Alt+.)"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Brain size={14} />
        {current ?? "Default"}
      </button>
      <div className="model-menu up" role="listbox" hidden={!open}>
        <button
          role="option"
          aria-selected={current === null}
          className={`model-item${current === null ? " current" : ""}`}
          onClick={() => pick(null)}
        >
          Default{defaultEffort ? <span className="effort-default"> ({defaultEffort})</span> : null}
        </button>
        {options.map((effort) => (
          <button
            key={effort}
            role="option"
            aria-selected={effort === current}
            className={`model-item${effort === current ? " current" : ""}`}
            onClick={() => pick(effort)}
          >
            {effort}
          </button>
        ))}
      </div>
    </div>
  );
}
