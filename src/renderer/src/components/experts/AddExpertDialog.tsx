import { useEffect, useId, useRef, useState } from "react";
import { FileArchive, FolderOpen, X } from "lucide-react";
import type { ExpertImportResult } from "../../../../shared/experts";
import { api } from "../../api";

/** A thrown IPC error's own text: Electron wraps it in "Error invoking remote method '…': Error: ". */
export const ipcError = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

type Candidate = ExpertImportResult["candidates"][number];
type Skipped = ExpertImportResult["skipped"][number];

/**
 * The Add expert sheet: import expert packages from a GitHub link, a folder or
 * a .zip. A link or a single package installs straight away; a marketplace with
 * several packages asks which to install first. Nothing in a package is run.
 * Follows ExpertDetail's modal pattern: role="dialog", a backdrop that closes
 * on click, Escape, and focus moved into the sheet on open.
 */
export function AddExpertDialog({ onClose, onInstalled }: { onClose(): void; onInstalled(ids: string[]): void }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<"import" | "folder" | "zip" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"input" | "pick" | "done">("input");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState(0);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  /** The source the running import started from, so the pick step installs from the same place. */
  const sourceRef = useRef("");
  const inputId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const run = async (src: string, pick?: string[]) => {
    sourceRef.current = src;
    setError(null);
    try {
      const result = await api().importExperts(src, pick);
      if (result.installed.length > 0) onInstalled(result.installed);
      // A marketplace with nothing installed yet and no pick: ask which packages to install.
      if (result.installed.length === 0 && result.candidates.length > 0 && !pick) {
        setCandidates(result.candidates);
        setChecked(new Set());
        setStep("pick");
      } else {
        setInstalled(result.installed.length);
        setSkipped(result.skipped);
        setStep("done");
      }
    } catch (err) {
      setError(ipcError(err));
    } finally {
      setBusy(null);
    }
  };

  const importSource = () => {
    const src = source.trim();
    if (!src || busy) return;
    setBusy("import");
    void run(src);
  };

  const pickSource = async (kind: "folder" | "zip") => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const path = await api().pickExpertSource(kind);
      if (path) {
        await run(path);
        return;
      }
    } catch (err) {
      setError(ipcError(err));
    }
    setBusy(null);
  };

  const installChecked = () => {
    const pick = [...checked];
    if (!pick.length || busy) return;
    setBusy("install");
    void run(sourceRef.current, pick);
  };

  const toggle = (name: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const installing = busy !== null;

  return (
    <div className="sheet-backdrop xc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet xc-add" role="dialog" aria-modal="true" aria-label="Add expert">
        <div className="xc-add-head">
          <h3>Add expert</h3>
          <button className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        {step === "input" && (
          <>
            <form
              className="xc-add-field"
              onSubmit={(e) => {
                e.preventDefault();
                importSource();
              }}
            >
              <label className="xc-add-label" htmlFor={inputId}>
                GitHub link
              </label>
              <div className="xc-add-row">
                <input
                  id={inputId}
                  className="text-input"
                  placeholder="https://github.com/owner/repo or …/tree/main/path"
                  value={source}
                  spellCheck={false}
                  autoFocus
                  disabled={installing}
                  onChange={(e) => setSource(e.target.value)}
                />
                <button type="submit" className="button primary" disabled={!source.trim() || installing}>
                  {busy === "import" ? "Importing…" : "Import"}
                </button>
              </div>
            </form>

            <p className="xc-add-or">or import from</p>
            <div className="xc-add-sources">
              <button type="button" className="button ghost" disabled={installing} onClick={() => void pickSource("folder")}>
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden />
                {busy === "folder" ? "Importing…" : "Folder…"}
              </button>
              <button type="button" className="button ghost" disabled={installing} onClick={() => void pickSource("zip")}>
                <FileArchive size={14} strokeWidth={1.75} aria-hidden />
                {busy === "zip" ? "Importing…" : ".zip file…"}
              </button>
            </div>
          </>
        )}

        {step === "pick" && (
          <div className="xc-add-pick">
            <p className="xc-add-lead">This package has several experts. Pick the ones to install.</p>
            <div className="xc-add-candidates">
              {candidates.map((c) => (
                <label key={c.name} className="xc-add-candidate">
                  <input type="checkbox" checked={checked.has(c.name)} disabled={installing} onChange={() => toggle(c.name)} />
                  <span className="xc-add-candidate-text">
                    <span className="xc-add-candidate-name">{c.name}</span>
                    {c.description ? <span className="xc-add-candidate-desc">{c.description}</span> : null}
                  </span>
                </label>
              ))}
            </div>
            <div className="xc-add-actions">
              <button type="button" className="button ghost" disabled={installing} onClick={() => setStep("input")}>
                Back
              </button>
              <button type="button" className="button primary" disabled={checked.size === 0 || installing} onClick={installChecked}>
                {busy === "install" ? "Importing…" : `Install ${checked.size}`}
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="xc-add-done">
            <p className="xc-add-done-line">
              Installed {installed} expert{installed === 1 ? "" : "s"}.
            </p>
            {skipped.length > 0 && (
              <ul className="xc-add-skipped">
                {skipped.map((s) => (
                  <li key={`${s.name}:${s.reason}`}>
                    {s.name}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
            <div className="xc-add-actions">
              <button type="button" className="button primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {error ? (
          <p className="xc-add-error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="xc-add-note">Experts are imported as prompts and skills only; nothing in a package is run. Check a package&apos;s license before you share what it makes.</p>
      </div>
    </div>
  );
}
