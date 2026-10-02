import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentInfo, Thread } from "../../../shared/types";
import { IconArchive, IconMore, IconPin } from "../icons";
import { useStore } from "../store";
import { UnsupportedChip } from "./UnsupportedChip";

/** The dot before a thread's title. */
export type ThreadStatus = "running" | "waiting" | "unread" | null;

const STATUS_LABEL: Record<Exclude<ThreadStatus, null>, string> = { running: "Running", waiting: "Needs approval", unread: "Finished, not seen yet" };

/**
 * One thread in the sidebar: a status dot, the title, and the time on the
 * right; open it, or from its ⋯ menu rename, pin, archive or delete it.
 * Delete asks once, in the menu itself (a native dialog would block the window).
 */
export function ThreadRow({
  thread,
  agent,
  branch,
  selected,
  status,
  time,
  sub,
  onOpen,
}: {
  thread: Thread;
  agent: AgentInfo | undefined;
  /** The thread's own worktree branch, shown in the tooltip. */
  branch: string | null | undefined;
  selected: boolean;
  status: ThreadStatus;
  time: string;
  /** A second line (Running rows: project · agent, or Needs approval). */
  sub?: ReactNode;
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
    <div ref={box} className={`thread-row${selected ? " selected" : ""}${menu ? " menu-open" : ""}${sub ? " has-sub" : ""}`}>
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
        <button
          className="thread-open"
          onClick={onOpen}
          onDoubleClick={() => setRenaming(true)}
          title={[thread.title, agent?.label ?? thread.agent, branch ? `⎇ ${branch}` : null].filter(Boolean).join(" · ")}
        >
          <span className={`thread-dot${status ? ` ${status}` : ""}`} role={status ? "img" : undefined} aria-label={status ? STATUS_LABEL[status] : undefined} />
          <span className="title">
            {thread.pinned && <IconPin size={11} />}
            {thread.title}
          </span>
          <span className="thread-time">
            {agent?.unsupported && <UnsupportedChip note={agent.unsupported} compact />}
            {time}
          </span>
          {sub && <span className="thread-sub">{sub}</span>}
        </button>
      )}
      {!renaming && (
        <span className="thread-actions">
          {!thread.archived && (
            <button className="icon-button" title="Archive" onClick={() => void setArchived(thread.id, true)}>
              <IconArchive />
            </button>
          )}
          <button className="icon-button thread-more" aria-haspopup="menu" aria-expanded={menu} title="More" onClick={() => setMenu((m) => !m)}>
            <IconMore />
          </button>
        </span>
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
