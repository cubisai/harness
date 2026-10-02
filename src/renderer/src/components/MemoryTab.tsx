import { useCallback, useEffect, useState } from "react";
import { Brain } from "lucide-react";
import type { MemoryOverview, MemoryType } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";
import { Select } from "./Select";
import "../styles/memory.css";

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

interface Draft {
  file?: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/**
 * The Library's Memory tab: one project's shared notes, an editor, the two
 * enable switches, and the import/folder actions. `overview` is a test seam
 * for a static render; the app passes nothing and fetches on open.
 */
export function MemoryTab({ overview: initial }: { overview?: MemoryOverview | null } = {}) {
  const projectId = useStore((s) => s.selectedProjectId);
  const [data, setData] = useState<MemoryOverview | null>(initial ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(() => {
    if (initial !== undefined || !projectId) return;
    void api().memoryOverview(projectId).then(setData);
  }, [projectId, initial]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The two-step Delete falls back to "Delete" on its own after a few seconds.
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete, selected]);

  if (!projectId) {
    return (
      <div className="wb-content-pad" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingTop: 60 }}>
        <Brain size={32} strokeWidth={1.5} aria-hidden style={{ color: "var(--text-tertiary)", marginBottom: 12 }} />
        <h3 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--text)" }}>No project memory</h3>
        <p style={{ maxWidth: 460, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>Pick a project to see its memory.</p>
      </div>
    );
  }

  if (!data) return <div className="library-pad" />;

  const open = async (file: string) => {
    setError(null);
    setNotice(null);
    setSelected(file);
    const note = await api().memoryRead(projectId, file);
    if (!note) return;
    const next: Draft = { file: note.file, name: note.name, description: note.description, type: note.type, body: note.body };
    setDraft(next);
    setSaved(next);
  };

  const newNote = () => {
    setError(null);
    setNotice(null);
    setSelected(null);
    setDraft({ name: "", description: "", type: "project", body: "" });
    setSaved(null);
    setConfirmDelete(false);
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const file = await api().memoryWrite(projectId, draft);
      const next = { ...draft, file };
      setDraft(next);
      setSaved(next);
      setSelected(file);
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async () => {
    if (!draft?.file) return;
    setError(null);
    try {
      await api().memoryDelete(projectId, draft.file);
      setDraft(null);
      setSaved(null);
      setSelected(null);
      setConfirmDelete(false);
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const doImport = async () => {
    setError(null);
    try {
      const n = await api().memoryImport(projectId);
      setNotice(n > 0 ? `Imported ${n} notes.` : "Nothing new to import.");
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const on = data.enabled && data.projectOn;
  const q = query.trim().toLowerCase();
  const shown = data.notes.filter((n) => !q || n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q));
  const dirty =
    draft !== null &&
    (saved === null
      ? draft.name !== "" || draft.description !== "" || draft.body !== ""
      : draft.name !== saved.name || draft.description !== saved.description || draft.type !== saved.type || draft.body !== saved.body);

  return (
    <div className="library-split memory-tab">
      <div className="library-list">
        <div className="skill-toolbar">
          <button className="button" onClick={newNote}>
            New note
          </button>
          <button className="button" onClick={() => void doImport()}>
            Import
          </button>
          <button className="button" onClick={() => void api().revealPath(data.dir)}>
            Folder
          </button>
        </div>
        <label className="memory-switch">
          <span>Shared memory (all projects)</span>
          <input
            type="checkbox"
            className="skill-switch"
            checked={data.enabled}
            onChange={(e) => void api().memorySetEnabled(null, e.target.checked).then(reload)}
          />
        </label>
        <label className="memory-switch">
          <span>This project</span>
          <input
            type="checkbox"
            className="skill-switch"
            checked={data.projectOn}
            disabled={!data.enabled}
            onChange={(e) => void api().memorySetEnabled(projectId, e.target.checked).then(reload)}
          />
        </label>
        <p className="note">{on ? `${data.index.lines} index lines · ~${data.index.tokens} tokens at the start of each new session` : "Off: agents use their own memory for this project."}</p>
        {notice && <p className="note">{notice}</p>}
        <input className="text-input" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        {shown.length === 0 ? (
          <p className="note" style={{ padding: "8px 10px" }}>
            No notes yet. Agents add notes as you work, or create one.
          </p>
        ) : (
          shown.map((n) => (
            <div
              key={n.file}
              role="button"
              tabIndex={0}
              className={`library-item${n.file === selected ? " selected" : ""}`}
              onClick={() => void open(n.file)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void open(n.file);
                }
              }}
            >
              <span className="n">{n.name}</span>
              <span className="d">{n.type} · {n.description}</span>
            </div>
          ))
        )}
      </div>
      <div className="library-detail">
        {draft ? (
          <form
            className={`memory-form${dirty ? " editing" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="memory-row">
              <span className="label">Name</span>
              <input className="text-input" autoFocus value={draft.name} placeholder="How we name things" spellCheck={false} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="memory-row">
              <span className="label">Description</span>
              <input className="text-input" value={draft.description} placeholder="One line the index shows" spellCheck={false} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            <div className="memory-row">
              <span className="label">Type</span>
              <Select
                className="block"
                value={draft.type}
                options={TYPES.map((t) => ({ value: t, label: t }))}
                onChange={(v) => setDraft({ ...draft, type: v })}
                ariaLabel="Type"
              />
            </div>
            <textarea className="text-input memory-body" rows={14} value={draft.body} placeholder="The note itself" onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            {error && <p className="form-error">{error}</p>}
            <div className="memory-actions">
              {draft.file && (
                <button type="button" className="button ghost danger" onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>
                  {confirmDelete ? "Confirm delete" : "Delete"}
                </button>
              )}
              <span className="grow" />
              <button type="submit" className="button primary">
                Save
              </button>
            </div>
          </form>
        ) : error ? (
          <p className="form-error" style={{ margin: 0 }}>
            {error}
          </p>
        ) : (
          <p className="note">Pick a note to edit it, or create one.</p>
        )}
      </div>
    </div>
  );
}
