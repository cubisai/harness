import { useEffect, useRef, useState } from "react";
import type { AgentInfo, Thread } from "../../../shared/types";
import { IconMore, IconPin } from "../icons";
import { useStore } from "../store";
import { UnsupportedChip } from "./UnsupportedChip";

/**
 * One thread in the sidebar: open it, or from its ⋯ menu rename, pin,
 * archive or delete it. Delete asks once, in the menu itself (a native
 * dialog would block the window).
 */
export function ThreadRow({
  thread,
  agent,
  branch,
  selected,
  running,
  onOpen,
}: {
  thread: Thread;
  agent: AgentInfo | undefined;
  branch: string | null | undefined;
  selected: boolean;
  running: boolean;
  onOpen(): void;
}) {
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const box = useRef<HTMLDivElement>(null);
  const { togglePin, renameThread, setArchived, deleteThread } = useStore.getState();

  // A click anywhere else, or Esc, closes the menu.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) {
        setMenu(false);
        setConfirming(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const act = (fn: () => Promise<void> | void) => () => {
    setMenu(false);
    setConfirming(false);
    void fn();
  };

  const finishRename = (save: boolean) => {
    setRenaming(false);
    if (save && title.trim() && title.trim() !== thread.title) void renameThread(thread.id, title);
    else setTitle(thread.title);
  };

  return (
    <div ref={box} className={`thread-row${selected ? " selected" : ""}${menu ? " menu-open" : ""}`}>
      {renaming ? (
        <input
          className="thread-rename"
          aria-label="Thread name"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finishRename(true);
            if (e.key === "Escape") finishRename(false);
          }}
        />
      ) : (
        <button className="thread-open" onClick={onOpen} onDoubleClick={() => setRenaming(true)} title={thread.title}>
          <span className="thread-text">
            <span className="title">
              {thread.pinned && <IconPin size={11} />}
              {thread.title}
            </span>
            <span className="thread-meta">
              <span>{agent?.label ?? thread.agent}</span>
              {agent?.unsupported && <UnsupportedChip note={agent.unsupported} compact />}
              {branch && (
                <span className="branch-chip" title={`Branch ${branch}`}>
                  {branch}
                </span>
              )}
            </span>
          </span>
          {running && <span className="spinner" />}
        </button>
      )}
      {!renaming && (
        <button className="icon-button thread-more" aria-haspopup="menu" aria-expanded={menu} title="More" onClick={() => setMenu((m) => !m)}>
          <IconMore />
        </button>
      )}
      {menu && (
        <div className="thread-menu" role="menu">
          {confirming ? (
            <>
              <p className="thread-menu-note">Delete “{thread.title}” and its history? This can't be undone.</p>
              <button role="menuitem" className="danger" onClick={act(() => deleteThread(thread.id))}>
                Delete for Good
              </button>
              <button role="menuitem" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={act(() => setRenaming(true))}>
                Rename
              </button>
              {!thread.archived && (
                <button role="menuitem" onClick={act(() => togglePin(thread.id))}>
                  {thread.pinned ? "Unpin" : "Pin to Top"}
                </button>
              )}
              <button role="menuitem" onClick={act(() => setArchived(thread.id, !thread.archived))}>
                {thread.archived ? "Unarchive" : "Archive"}
              </button>
              <button role="menuitem" className="danger" onClick={() => setConfirming(true)}>
                Delete…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
