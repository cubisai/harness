import { AppWindow, Check, ChevronDown, Layers, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TIERS, tierOf, type PrototypeTier } from "../../../shared/tiers";
import type { Thread } from "../../../shared/types";
import { useStore } from "../store";

/** Each tier's icon: what the chip shows when a narrow composer hides its label. */
const TIER_ICON: Record<PrototypeTier, typeof Zap> = { quick: Zap, working: Layers, "real-app": AppWindow };

/**
 * A design thread's prototype tier chip, beside its system chip: Quick, Working or Real app. The tier decides which
 * canvas tools show (tweaks, text editing, comments) and what the agent is told on the next turn.
 */
export function ThreadTier({ thread, running }: { thread: Thread; running: boolean }) {
  const setTier = useStore((s) => s.setPrototypeTier);
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
  const value = tierOf(thread);
  const current = TIERS.find((t) => t.value === value) ?? TIERS[1]!;
  const Icon = TIER_ICON[current.value];
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
        title={`Prototype tier: ${current.label}`}
        aria-label={`Prototype tier: ${current.label}`}
        disabled={running}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon size={13} aria-hidden />
        <span className="ds-chip-label">{current.label}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div className="model-menu up ds-menu" role="listbox" aria-label="Prototype tier">
          <div className="model-group">Prototype tier</div>
          {TIERS.map((t) => (
            <button
              key={t.value}
              role="option"
              aria-selected={t.value === value}
              className={`model-item two-line${t.value === value ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (t.value !== value) void setTier(thread.id, t.value);
              }}
            >
              <Check size={13} className="check" />
              <span className="label">
                <span className="ds-name">{t.label}</span>
                <span className="desc">{t.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
