import { useEffect, useRef } from "react";
import { MessageSquare } from "lucide-react";
import type { DesignComment } from "../../../shared/comments";

/**
 * The canvas's Comments button and popover (Real app tier): this page's open comments, numbered like their pins,
 * with Resolve and Delete, and one action that sends the unsent ones to the agent as a single message.
 */
export function CommentsPanel({
  comments,
  missing,
  open,
  busy,
  onOpen,
  onResolve,
  onDelete,
  onSend,
}: {
  /** This page's open comments, in pin order. */
  comments: DesignComment[];
  /** Pin numbers whose element isn't on the page any more. */
  missing: number[];
  open: boolean;
  /** The agent is working (or a send is going out): sending waits. */
  busy: boolean;
  onOpen: (open: boolean) => void;
  onResolve: (c: DesignComment) => void;
  onDelete: (c: DesignComment) => void;
  onSend: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
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

  const unsent = comments.filter((c) => !c.sentAt).length;
  return (
    <div className="artifact-menu-wrap" ref={wrapRef}>
      <button
        className={`icon-button${open ? " active" : ""}`}
        title={comments.length ? `${comments.length} open comment${comments.length === 1 ? "" : "s"}` : "Comments"}
        aria-label={comments.length ? `Comments (${comments.length} open)` : "Comments"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
      >
        <MessageSquare size={16} strokeWidth={1.75} aria-hidden />
        {comments.length > 0 && <span className="design-select-count">{comments.length}</span>}
      </button>
      {open && (
        <div className="design-tweaks design-comments" role="dialog" aria-label="Comments">
          {comments.length === 0 ? (
            <p className="design-comments-empty">No open comments on this page. Select an element and choose Comment.</p>
          ) : (
            <ol className="design-comments-list">
              {comments.map((c, i) => (
                <li key={c.id} className="design-comment">
                  <span className="design-comment-n" aria-hidden>
                    {i + 1}
                  </span>
                  <div className="design-comment-body">
                    <div className="design-comment-meta" title={c.target.selector}>
                      {c.label}
                      {missing.includes(i + 1) && <span className="design-comment-gone"> · not on the page</span>}
                      {c.sentAt && <span> · sent</span>}
                    </div>
                    <div className="design-comment-text">{c.text}</div>
                  </div>
                  <div className="design-comment-actions">
                    <button className="button ghost" onClick={() => onResolve(c)}>
                      Resolve
                    </button>
                    <button className="icon-button" aria-label={`Delete comment ${i + 1}`} title="Delete" onClick={() => onDelete(c)}>
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="design-tweaks-foot">
            <span className="design-tweaks-hint">{unsent ? `${unsent} not sent yet` : comments.length ? "All sent" : ""}</span>
            <button className="button" onClick={onSend} disabled={!unsent || busy} title={busy ? "The agent is working" : "Send the unsent comments as one message"}>
              Send to agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
