/** An on/off switch (role="switch"): a 28×16 track with an ink thumb; the label is for screen readers. */
export function Toggle({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span className="toggle-thumb" aria-hidden />
    </button>
  );
}
