import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { MODES } from "./ThreadControls";

/**
 * A design thread's access: always Full, fenced to its folder, so there is nothing to pick. The chip still opens (it
 * sits where the mode menu does) to say what that means. The tier is the agent's; the style chip beside it picks the
 * style (Auto until the user picks one).
 */
export function DesignFenceChip() {
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
        className="chip-button mode-chip design-fence-chip"
        aria-label="Full access, fenced to this design's folder"
        title="Full access, fenced to this design's folder"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MODES.full.Icon size={13} />
      </button>
      {open && (
        <div className="model-menu up mode-menu" role="dialog" aria-label="Permissions">
          <div className="model-group">Permissions</div>
          <div className="model-item two-line current">
            <Check size={13} className="check" />
            <span className="label">
              Full access, fenced
              <span className="desc">Edits and commands run without asking, inside this design's folder only. Writes outside it and destructive commands are blocked.</span>
            </span>
          </div>
          <div className="model-hint">Ask in chat for a different look</div>
        </div>
      )}
    </div>
  );
}
