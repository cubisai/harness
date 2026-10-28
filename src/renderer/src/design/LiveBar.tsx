import { useEffect, useRef, useState } from "react";
import { ArrowUp, Columns2, Eye, MessageSquareText, MousePointer2, Play, Plus, SwatchBook } from "lucide-react";
import { IconClose } from "../icons";

/** What Esc does next while picking: first it clears the selection, then it stops picking. */
export function escapeStep(hasSelection: boolean, picking: boolean): "clear-selection" | "stop-picking" | null {
  if (!picking) return null;
  return hasSelection ? "clear-selection" : "stop-picking";
}

/** True when Esc on this target may clear the canvas selection: not typed into a text field, dialog or menu. */
export function escClears(target: EventTarget | null): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null;
  if (!t) return true;
  if (t.isContentEditable) return false;
  const tag = (t.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return false;
  return !t.closest?.('[role="dialog"], [role="menu"], [role="listbox"]');
}

/** True for a bare `V` typed outside a text field: the Pick shortcut. */
export function isPickKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null }): boolean {
  if (e.key !== "v" && e.key !== "V") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null;
  if (!t) return true;
  if (t.isContentEditable) return false;
  const tag = (t.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return false;
  return !t.closest?.('[role="dialog"], [role="menu"]');
}

/** A Steer message: the user's words, scoped to the whole page (or, on the board, the whole design). */
export function steerMessage(text: string, scope: { page: string } | { design: string }): string {
  const body = text.trim();
  if (!body) return "";
  return "page" in scope ? `${body}\n\n(This is about the whole page ${scope.page}, not one element.)` : `${body}\n\n(This is about the whole design in ${scope.design}.)`;
}

/** The Detect button's tooltip for its state; `off` is why it can't run (null when it can). */
export function detectTitle(detect: number | "busy" | null, off: string | null): string {
  if (off) return off;
  if (detect === "busy") return "Checking the page…";
  if (detect === null) return "Detect: mark design issues on this page";
  if (detect === 0) return "No issues found. Click to hide";
  return `${detect} ${detect === 1 ? "issue" : "issues"} marked: click a pin to fix it. Click to hide`;
}

export type LiveBarProps = {
  /** One live page is shown (not the board, Compare or an old version): Pick works only then. */
  onPage: boolean;
  /** Why Pick is off when it is (null when it works). */
  pickWhy: string | null;
  picking: boolean;
  textEdit: boolean;
  onPick: () => void;
  /** Insert mode: hovering the page shows the gaps between blocks, a click picks one. Off with Pick (Pick ends it). */
  inserting: boolean;
  /** Why Insert is off when it is (null when it works). */
  insertWhy: string | null;
  onInsert: () => void;
  /** Detect: null while off, "busy" while the page is linted, else how many issues its pins show. */
  detect: number | "busy" | null;
  /** Why Detect is off when it is (null when it works). */
  detectWhy: string | null;
  onDetect: () => void;
  /** The inspector is open on its System tab. */
  systemOpen: boolean;
  onSystem: () => void;
  /** Steer sends here; false when the message couldn't go. Null when there's nothing to steer yet. */
  onSteer: ((text: string) => Promise<boolean>) | null;
  /** A turn is running: Steer waits for it. */
  busy: boolean;
  /** There are options to compare (null hides Compare). */
  comparing: boolean | null;
  onCompare: () => void;
  board: boolean;
  onPresent: (() => void) | null;
};

/**
 * The design canvas's one tool bar, floating at the bottom centre in both layouts: Pick (V), DESIGN.md (the inspector's
 * System tab), Steer (a page-level message into this thread), then Compare and Present. Insert (`+`) sits beside Pick:
 * new content at a gap between two blocks. Detect (the eye) pins the page's lint findings; a pin opens the element bar.
 */
export function LiveBar({ onPage, pickWhy, picking, textEdit, onPick, inserting, insertWhy, onInsert, detect, detectWhy, onDetect, systemOpen, onSystem, onSteer, busy, comparing, onCompare, board, onPresent }: LiveBarProps) {
  const [steering, setSteering] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (steering) inputRef.current?.focus();
  }, [steering]);
  // Nothing left to steer (the design went away) closes the field.
  useEffect(() => {
    if (!onSteer) setSteering(false);
  }, [onSteer]);

  const submit = async () => {
    if (!onSteer || !draft.trim() || busy || sending) return;
    setSending(true);
    try {
      if (await onSteer(draft)) {
        setDraft("");
        setSteering(false);
      }
    } finally {
      setSending(false);
    }
  };

  const pickTitle = pickWhy ?? (picking ? `Picking: click an element, Shift-click for more${textEdit ? ", double-click text to edit it" : ""}. Esc clears, then stops (V)` : "Pick an element (V)");
  return (
    <div className="design-live-bar" role="toolbar" aria-label="Canvas tools">
      <button className={`design-live-pick${picking && onPage ? " active" : ""}`} aria-pressed={picking && onPage} aria-keyshortcuts="V" title={pickTitle} disabled={!onPage} onClick={onPick}>
        <MousePointer2 size={16} strokeWidth={1.75} aria-hidden />
        <span>Pick</span>
      </button>
      <button
        className={`icon-button${inserting && onPage ? " active" : ""}`}
        aria-pressed={inserting && onPage}
        aria-label="Insert"
        title={insertWhy ?? (inserting ? "Inserting: click a gap between two blocks, then say what goes there. Esc clears, then stops" : "Insert: add something new between two blocks")}
        disabled={!onPage}
        onClick={onInsert}
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        className={`icon-button${detect !== null && onPage ? " active" : ""}`}
        aria-pressed={detect !== null && onPage}
        aria-label="Detect"
        title={detectTitle(detect, detectWhy)}
        disabled={!onPage || detect === "busy"}
        onClick={onDetect}
      >
        <Eye size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <button className={`icon-button${systemOpen ? " active" : ""}`} aria-pressed={systemOpen} aria-label="DESIGN.md" title="DESIGN.md: the design system's tokens and rules" disabled={!onPage} onClick={onSystem}>
        <SwatchBook size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {steering && onSteer ? (
        <form
          className="design-live-steer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={inputRef}
            className="design-live-steer-input"
            aria-label={board ? "Steer the whole design" : "Steer the whole page"}
            placeholder={board ? "Steer the whole design…" : "Steer the whole page…"}
            value={draft}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setSteering(false);
              }
            }}
          />
          <button type="submit" className="icon-button" aria-label="Send" title={busy ? "Wait for the current turn to finish" : "Send to this thread"} disabled={!draft.trim() || busy || sending}>
            <ArrowUp size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Close Steer" title="Close (Esc)" onClick={() => setSteering(false)}>
            <IconClose />
          </button>
        </form>
      ) : (
        <button className="design-live-steer-open" title={onSteer ? (board ? "Steer: tell the agent what to change across the design" : "Steer: tell the agent what to change across this page") : "Nothing to steer yet"} disabled={!onSteer} onClick={() => setSteering(true)}>
          <MessageSquareText size={16} strokeWidth={1.75} aria-hidden />
          <span>Steer</span>
        </button>
      )}
      <span className="design-float-divider" aria-hidden />
      {comparing !== null && (
        <button className={`icon-button${comparing ? " active" : ""}`} title={comparing ? "Back to one page" : "Compare options side by side"} aria-label="Compare options" aria-pressed={comparing} onClick={onCompare}>
          <Columns2 size={16} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      <button className="icon-button" aria-label="Present" title={board ? "Present from the first screen" : "Present this page"} disabled={!onPresent} onClick={() => onPresent?.()}>
        <Play size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
