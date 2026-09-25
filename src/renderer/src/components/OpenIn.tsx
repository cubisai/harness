import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { IconChevron } from "../icons";
import { useStore } from "../store";

export const fileManagerName = () => (api().platform === "darwin" ? "Finder" : api().platform === "win32" ? "File Explorer" : "Files");

/**
 * "Open in <editor>" with a menu of the other installed editors. Picking
 * one opens the project there and makes it the default.
 */
export function OpenIn() {
  const editors = useStore((s) => s.editors);
  const preferred = useStore((s) => s.settings?.editor ?? null);
  const project = useStore((s) => s.projects.find((p) => p.id === s.selectedProjectId) ?? null);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!project) return null;
  const current = editors.find((e) => e.id === preferred) ?? editors[0];
  const openWith = (id?: string) => {
    setOpen(false);
    void useStore.getState().openInEditor({}, id);
  };
  return (
    <div className="open-in" ref={menu}>
      {current ? (
        <button className="button ghost open-main" title={`Open ${project.name} in ${current.label}`} onClick={() => openWith(current.id)}>
          Open in {current.label}
        </button>
      ) : (
        <button className="button ghost open-main" onClick={() => void api().revealPath(project.path)}>
          Show in {fileManagerName()}
        </button>
      )}
      <button className="button ghost open-more" aria-label="Other editors" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconChevron open />
      </button>
      {open && (
        <div className="open-menu" role="menu">
          {editors.map((e) => (
            <button key={e.id} role="menuitem" className={e.id === current?.id ? "on" : ""} onClick={() => openWith(e.id)}>
              {e.label}
            </button>
          ))}
          {editors.length > 0 && <div className="sep" />}
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void api().revealPath(project.path);
            }}
          >
            Show in {fileManagerName()}
          </button>
          {editors.length === 0 && <div className="hint">No editors found. VS Code, Cursor, Zed, JetBrains IDEs and others show up here once installed.</div>}
        </div>
      )}
    </div>
  );
}
