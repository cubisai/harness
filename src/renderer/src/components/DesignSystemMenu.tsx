import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesignSystemOption, Thread } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";

/** The system a thread uses when it names none (or one that's gone): the project's own, else Clean, else the first. */
export function shownSystem(options: DesignSystemOption[], id: string | undefined): DesignSystemOption | undefined {
  return (id ? options.find((o) => o.id === id) : undefined) ?? options.find((o) => o.id === "project") ?? options.find((o) => o.id === "clean") ?? options[0];
}

function Swatches({ colors }: { colors: string[] }) {
  if (!colors.length) return null;
  return (
    <span className="ds-swatches" aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} className="ds-swatch" style={{ backgroundColor: c }} />
      ))}
    </span>
  );
}

/**
 * A design thread's design-system chip, beside the mode chip: shows the active
 * system and opens a menu of the project's own systems and the built-ins.
 */
export function DesignSystemMenu({ projectId, value, disabled, onPick }: { projectId: string | null; value: string | undefined; disabled?: boolean; onPick(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DesignSystemOption[]>([]);
  const box = useRef<HTMLDivElement>(null);
  // Re-read on open too: a system the agent just extracted into .agents/design-systems shows up without a restart.
  useEffect(() => {
    let live = true;
    void api()
      .designSystems(projectId)
      .then((list) => live && setOptions(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const current = shownSystem(options, value);
  if (!current) return null;
  return (
    <div
      className="model-picker"
      ref={box}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className="chip-button ds-chip"
        title={`Design system: ${current.name}`}
        aria-label={`Design system: ${current.name}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Swatches colors={current.swatches.slice(0, 3)} />
        <span className="ds-chip-label">{current.name}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div className="model-menu up ds-menu" role="listbox" aria-label="Design system">
          <div className="model-group">Design system</div>
          {options.map((o) => (
            <button
              key={o.id}
              role="option"
              aria-selected={o.id === current.id}
              className={`model-item two-line${o.id === current.id ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (o.id !== current.id) onPick(o.id);
              }}
            >
              <Check size={13} className="check" />
              <span className="label">
                <span className="ds-name">
                  {o.name}
                  <Swatches colors={o.swatches} />
                </span>
                <span className="desc">{o.description}</span>
              </span>
            </button>
          ))}
          <div className="model-hint">Your own: .agents/design-systems</div>
        </div>
      )}
    </div>
  );
}

/** The open design thread's system chip. */
export function ThreadDesignSystem({ thread, running }: { thread: Thread; running: boolean }) {
  const setDesignSystem = useStore((s) => s.setDesignSystem);
  return <DesignSystemMenu projectId={thread.projectId} value={thread.designSystem} disabled={running} onPick={(id) => void setDesignSystem(thread.id, id)} />;
}

/** The system a design thread about to start will use. */
export function DraftDesignSystem() {
  const projectId = useStore((s) => s.selectedProjectId);
  const value = useStore((s) => s.draft.designSystem);
  const setDraft = useStore((s) => s.setDraft);
  return <DesignSystemMenu projectId={projectId} value={value} onPick={(id) => setDraft({ designSystem: id })} />;
}
