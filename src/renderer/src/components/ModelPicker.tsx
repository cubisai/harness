import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption } from "../../../shared/types";
import { filterModels } from "../models";

/**
 * The header's model picker: a button that opens a searchable list, grouped
 * by provider. Arrow keys move, Return picks, Esc closes.
 */
export function ModelPicker({
  models,
  current,
  disabled,
  placement = "down",
  onPick,
}: {
  models: ModelOption[];
  current: string;
  disabled?: boolean;
  /** Open below the button, or above it (from the message box). */
  placement?: "down" | "up";
  onPick(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => filterModels(models, query), [models, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.models), [groups]);
  const currentLabel = models.find((m) => m.id === current)?.label ?? current;

  useEffect(() => setIndex(Math.max(0, flat.findIndex((m) => m.id === current))), [flat, current]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // Keep the highlighted row in view while moving with the keyboard.
  useEffect(() => {
    if (open) box.current?.querySelector(".model-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  const pick = (id: string) => {
    setOpen(false);
    setQuery("");
    if (id !== current) onPick(id);
  };

  let row = -1;
  return (
    <div className="model-picker" ref={box}>
      <button className="select ghost-select model-picker-button" title={`Model: ${currentLabel}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {currentLabel.includes("/") ? currentLabel.slice(currentLabel.indexOf("/") + 1) : currentLabel}
      </button>
      {open && (
        <div className={`model-menu ${placement}`}>
          <input
            className="model-search"
            autoFocus
            placeholder={`Search ${models.length} models`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(flat.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const m = flat[index];
                if (m) pick(m.id);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div className="model-list" role="listbox">
            {flat.length === 0 && <div className="model-empty">No model matches “{query}”</div>}
            {groups.map((g) => (
              <div key={g.group || "-"}>
                {g.group && <div className="model-group">{g.group}</div>}
                {g.models.map((m) => {
                  row += 1;
                  const i = row;
                  return (
                    <button
                      key={m.id}
                      role="option"
                      aria-selected={m.id === current}
                      className={`model-item${i === index ? " active" : ""}${m.id === current ? " current" : ""}`}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => pick(m.id)}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
