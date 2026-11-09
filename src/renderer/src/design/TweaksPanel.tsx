import type { Tweak, TweakValues } from "../../../shared/tweaks";
import { Select } from "../components/Select";

/** The tweak controls a page declares in its `cubiq-tweaks` manifest, with Reset and Keep: the Customize panel's Tweaks section. */
export function TweaksBody({
  tweaks,
  values,
  dirty,
  keeping,
  onChange,
  onReset,
  onKeep,
}: {
  tweaks: Tweak[];
  values: TweakValues;
  dirty: boolean;
  keeping: boolean;
  onChange: (tweak: Tweak, raw: string) => void;
  onReset: () => void;
  onKeep: () => void;
}) {
  return (
    <>
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
    </>
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
