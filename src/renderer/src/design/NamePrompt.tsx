import { useState } from "react";

/** Asks for a name, for something saved with no agent turn. With warnings up, `Save anyway` is the only way on. */
export function NamePrompt({ title, hint, initial = "", warnings = [], busy = false, error = null, onSave, onCancel }: { title: string; hint?: string; initial?: string; warnings?: string[]; busy?: boolean; error?: string | null; onSave: (name: string, force: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0 && !busy;
  return (
    <form
      className="studio-name-prompt"
      role="dialog"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave(name.trim(), warnings.length > 0);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <h2 className="studio-name-title">{title}</h2>
      {hint && <p className="studio-name-hint">{hint}</p>}
      <input className="text-input" autoFocus value={name} aria-label="Name" placeholder="Name" maxLength={80} onChange={(e) => setName(e.target.value)} />
      {warnings.length > 0 && (
        <ul className="studio-name-warn">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="studio-name-error" role="alert">
          {error}
        </p>
      )}
      <div className="studio-name-actions">
        <button type="button" className="button ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!ok}>
          {warnings.length ? "Save anyway" : "Save"}
        </button>
      </div>
    </form>
  );
}
