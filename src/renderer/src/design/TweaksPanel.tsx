import { useEffect, useRef } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { Tweak, TweakValues } from "../../../shared/tweaks";
import { Select } from "../components/Select";

/**
 * The canvas's Tweaks button and popover: the controls a design page declares in its `cubiq-tweaks` manifest.
 * Changes apply live in the frame (no agent turn); Keep writes them into the file, Reset reloads it.
 */
export function TweaksPanel({
  tweaks,
  values,
  dirty,
  keeping,
  open,
  onOpen,
  onChange,
  onReset,
  onKeep,
}: {
  tweaks: Tweak[];
  values: TweakValues;
  dirty: boolean;
  keeping: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (tweak: Tweak, raw: string) => void;
  onReset: () => void;
  onKeep: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  // Closes on a click outside it or Esc, like the Export menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpen]);

  return (
    <div className="artifact-menu-wrap" ref={wrapRef}>
      <button
        className={`icon-button design-tweaks-toggle${open ? " active" : ""}`}
        title={dirty ? "Tweaks (changed, not kept)" : "Tweaks"}
        aria-label="Tweaks"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
      >
        <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />
        {dirty && <span className="design-tweaks-dot" aria-hidden />}
      </button>
      {open && (
        <div className="design-tweaks" role="dialog" aria-label="Tweaks">
          {tweaks.map((t) => (
            <div key={t.id} className="design-tweak-row">
              <span className="design-tweak-label" id={`tweak-${t.id}`}>
                {t.label}
              </span>
              <TweakControl tweak={t} value={values[t.id] ?? ""} onChange={(raw) => onChange(t, raw)} />
            </div>
          ))}
          <div className="design-tweaks-foot">
            <span className="design-tweaks-hint">{dirty ? "Not kept yet" : "Live in the canvas"}</span>
            <button className="button ghost" onClick={onReset} disabled={!dirty || keeping}>
              Reset
            </button>
            <button className="button" onClick={onKeep} disabled={!dirty || keeping} title="Write these values into the page">
              {keeping ? "Keeping…" : "Keep"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TweakControl({ tweak: t, value, onChange }: { tweak: Tweak; value: string; onChange: (raw: string) => void }) {
  const labelled = `tweak-${t.id}`;
  if (t.type === "choice" || t.type === "toggle") {
    const options = t.type === "toggle" ? ["on", "off"] : t.options;
    if (options.length > 3) {
      return <Select<string> value={value} options={options.map((o) => ({ value: o, label: o }))} onChange={onChange} ariaLabel={t.label} className="ghost-select" />;
    }
    return (
      <div className="segmented compact" role="group" aria-labelledby={labelled}>
        {options.map((o) => (
          <button key={o} className={value === o ? "on" : undefined} aria-pressed={value === o} onClick={() => onChange(o)}>
            {t.type === "toggle" ? (o === "on" ? "On" : "Off") : o}
          </button>
        ))}
      </div>
    );
  }
  if (t.type === "color") {
    return (
      <span className="design-tweak-value">
        <input type="color" className="design-tweak-color" aria-labelledby={labelled} value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="design-tweak-num">{value}</span>
      </span>
    );
  }
  return (
    <span className="design-tweak-value">
      <input
        type="range"
        className="design-tweak-range"
        aria-labelledby={labelled}
        min={t.min}
        max={t.max}
        step={t.step}
        value={Number(value)}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="design-tweak-num">
        {value}
        {t.unit}
      </span>
    </span>
  );
}
