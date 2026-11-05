import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Funnel,
  LayoutTemplate,
  MessageSquarePlus,
  Mic,
  MonitorSmartphone,
  Orbit,
  Palette,
  PartyPopper,
  PenLine,
  Sparkles,
  Type,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { FrameRect, InsertGap, PageMarks } from "./frame";
import { IconClose } from "../icons";
import { DICTATION_HINT } from "../components/StudioComposer";

export type ActionId = "freeform" | "bolder" | "quieter" | "distill" | "polish" | "typeset" | "colorize" | "layout" | "adapt" | "animate" | "delight" | "overdrive";

/** The element bar's actions, in palette order (4 × 3). Each one says what its 3 variants push on. */
export const ACTIONS: { id: ActionId; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "freeform", label: "Freeform", hint: "Your words decide", icon: PenLine },
  { id: "bolder", label: "Bolder", hint: "More scale, contrast and presence", icon: ChevronsUp },
  { id: "quieter", label: "Quieter", hint: "Calmer, less shouting", icon: ChevronsDown },
  { id: "distill", label: "Distill", hint: "Cut noise and nesting", icon: Funnel },
  { id: "polish", label: "Polish", hint: "Fix the details", icon: Sparkles },
  { id: "typeset", label: "Typeset", hint: "Type scale, pairing, rhythm", icon: Type },
  { id: "colorize", label: "Colorize", hint: "A stronger colour role", icon: Palette },
  { id: "layout", label: "Layout", hint: "Rearrange the structure", icon: LayoutTemplate },
  { id: "adapt", label: "Adapt", hint: "Fit other screen sizes", icon: MonitorSmartphone },
  { id: "animate", label: "Animate", hint: "One purposeful motion", icon: Orbit },
  { id: "delight", label: "Delight", hint: "A moment of personality", icon: PartyPopper },
  { id: "overdrive", label: "Overdrive", hint: "Push it as far as it goes", icon: Zap },
];
const COLUMNS = 4;
/** The palette's height plus its gap, in px: it opens upward only with this much room above the bar. */
const PALETTE_ROOM = 190;

/** The message Go sends (the canvas adds the selection scope and the capture). */
export function goMessage(action: ActionId, prompt: string, marks: PageMarks): string {
  const a = ACTIONS.find((x) => x.id === action) ?? ACTIONS[0]!;
  const lines = [a.id === "freeform" ? "Make 3 variants of the selected element." : `Make 3 variants of the selected element: ${a.label}.`];
  if (prompt.trim()) lines.push(prompt.trim());
  if (marks.notes.length) lines.push("Notes on the page:", ...marks.notes.map((n) => `- ${n.near ? `near ${n.near}: ` : ""}${n.text}`));
  if (marks.strokes.length) lines.push(`The reference image shows the element with ${marks.strokes.length === 1 ? "my mark" : `my ${marks.strokes.length} marks`} on it.`);
  return lines.join("\n");
}

/** The message Insert's Go sends: new content at a gap beside an anchor element, which itself stays as it is. */
export function insertMessage(page: string, gap: InsertGap, prompt: string): string {
  const a = gap.anchor;
  const lines = [`Insert 3 variants of a new block ${gap.position} the selected element.`];
  if (prompt.trim()) lines.push(prompt.trim());
  lines.push(
    `Selected in ${page}: <${a.tag}>${a.id ? ` data-agent-id="${a.id}"` : ""} · selector \`${a.selector}\`${gap.size.width > 0 ? ` · ${gap.size.width}px wide` : ""}. Leave it unchanged: write the set right ${gap.position} it, with an empty original.`,
  );
  return lines.join("\n");
}

/**
 * Where the element bar goes inside the stage: under the element, centred on it; above it when there's no room
 * below; docked to the visible frame's top or bottom edge when the element has scrolled off (or fills the view).
 * All boxes are in the same coordinates (the stage wrapper's); `view` is the part of the frame that shows.
 */
export function placeElementBar(
  el: FrameRect,
  view: FrameRect,
  bar: { width: number; height: number },
  gap = 8,
): { left: number; top: number; side: "below" | "above" | "dock-top" | "dock-bottom" } {
  const viewBottom = view.y + view.height;
  const minTop = view.y + gap;
  const maxTop = Math.max(minTop, viewBottom - bar.height - gap);
  const elBottom = el.y + el.height;
  let top: number;
  let side: "below" | "above" | "dock-top" | "dock-bottom";
  if (elBottom >= view.y && elBottom + gap + bar.height <= viewBottom - gap) {
    top = elBottom + gap;
    side = "below";
  } else if (el.y <= viewBottom && el.y - gap - bar.height >= minTop) {
    top = el.y - gap - bar.height;
    side = "above";
  } else if (elBottom < view.y) {
    top = minTop;
    side = "dock-top";
  } else {
    top = maxTop;
    side = "dock-bottom";
  }
  const maxLeft = Math.max(view.x + gap, view.x + view.width - bar.width - gap);
  const left = Math.min(maxLeft, Math.max(view.x + gap, el.x + el.width / 2 - bar.width / 2));
  return { left, top: Math.min(maxTop, Math.max(minTop, top)), side };
}

/** The next cell in the 4 × 3 palette for an arrow key (wrapping within the row or column), or null for any other key. */
export function paletteStep(index: number, key: string): number | null {
  const n = ACTIONS.length;
  const row = Math.floor(index / COLUMNS);
  const col = index % COLUMNS;
  const rows = Math.ceil(n / COLUMNS);
  if (key === "ArrowRight") return row * COLUMNS + ((col + 1) % COLUMNS);
  if (key === "ArrowLeft") return row * COLUMNS + ((col + COLUMNS - 1) % COLUMNS);
  if (key === "ArrowDown") return ((row + 1) % rows) * COLUMNS + col;
  if (key === "ArrowUp") return ((row + rows - 1) % rows) * COLUMNS + col;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}


/**
 * The element bar under the picked element: its tag, a prompt, the action (×3), dictation and Go; Edit text and
 * Comment when they apply; Clear when marks are down. While a Go turn runs it's a "Generating variants…" pill. As the
 * insert bar (at a gap picked in Insert mode) it's the tag, a prompt, dictation and Go: there's no action to pick.
 */
export function ElementBar({
  insert = false,
  tag,
  place,
  onSize,
  prompt,
  onPrompt,
  action,
  onAction,
  marks,
  onClearMarks,
  canGo,
  goWhy,
  onGo,
  generating,
  onEditText,
  onComment,
  repick,
  onRepick,
  onClose,
}: {
  /** The insert bar: new content at a gap, so no action chip. */
  insert?: boolean;
  tag: string;
  place: { left: number; top: number; side: "below" | "above" | "dock-top" | "dock-bottom" } | null;
  onSize: (size: { width: number; height: number }) => void;
  prompt: string;
  onPrompt: (text: string) => void;
  action: ActionId;
  onAction: (id: ActionId) => void;
  marks: PageMarks;
  onClearMarks: () => void;
  canGo: boolean;
  /** Why Go is off (null when it works). */
  goWhy: string | null;
  onGo: () => void;
  generating: boolean;
  /** Null hides Edit text (the element isn't editable here). */
  onEditText: (() => void) | null;
  /** Null hides Comment (not the Real app tier, or several elements). */
  onComment: (() => void) | null;
  /** An element clicked while marks are down, waiting for a yes or no. */
  repick: string | null;
  onRepick: (ok: boolean) => void;
  /** × (and Esc): let the element, or the insert gap, go. */
  onClose: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  // Measured every render (its content changes with the marks, the repick question and the pill), so the canvas can place it.
  const size = useRef({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    if (next.width !== size.current.width || next.height !== size.current.height) {
      size.current = next;
      onSize(next);
    }
  });

  useEffect(() => {
    if (!paletteOpen) return;
    cells.current[focusIndex]?.focus();
  }, [paletteOpen, focusIndex]);
  // The palette closes on a click outside the bar.
  useEffect(() => {
    if (!paletteOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setPaletteOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [paletteOpen]);

  const current = ACTIONS.find((a) => a.id === action) ?? ACTIONS[0]!;
  const openPalette = () => {
    setFocusIndex(Math.max(0, ACTIONS.findIndex((a) => a.id === action)));
    setPaletteOpen(true);
  };
  const choose = (id: ActionId) => {
    onAction(id);
    setPaletteOpen(false);
    inputRef.current?.focus();
  };
  const onPaletteKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen(false);
      return;
    }
    const next = paletteStep(focusIndex, e.key);
    if (next !== null) {
      e.preventDefault();
      setFocusIndex(next);
    }
  };
  const markCount = marks.strokes.length + marks.notes.length;
  // The palette opens over the element (upward from a bar under it) when there's room above the bar; otherwise downward.
  const paletteUp = place !== null && place.side !== "above" && place.side !== "dock-top" && place.top >= PALETTE_ROOM;

  const style: CSSProperties = place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" };
  return (
    <div className="design-element-bar" ref={barRef} style={style} role="toolbar" aria-label={insert ? `Insert ${tag}` : `Change ${tag}`}>
      {generating ? (
        <span className="design-element-generating" role="status">
          <span className="design-element-dot" aria-hidden />
          Generating variants…
        </span>
      ) : repick ? (
        <>
          <span className="design-element-ask">Pick {repick}? Your marks will be cleared.</span>
          <button className="button ghost" onClick={() => onRepick(false)}>
            Keep
          </button>
          <button className="button" autoFocus onClick={() => onRepick(true)}>
            Pick it
          </button>
        </>
      ) : (
        <>
          <span className="design-element-tag" title={tag}>
            {tag}
          </span>
          {onEditText && (
            <button className="icon-button" aria-label="Edit text" title="Edit its text in place (or double-click it)" onClick={onEditText}>
              <Type size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          {onComment && (
            <button className="icon-button" aria-label="Comment" title="Comment on this element" onClick={onComment}>
              <MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <span className="design-float-divider" aria-hidden />
          <input
            ref={inputRef}
            className="design-element-prompt"
            aria-label={insert ? "What goes here" : "What to change"}
            placeholder={insert ? "What goes here?" : markCount ? "Anything else?" : "Refine further…"}
            title={insert ? "Say what to add at this spot." : "Say what to change. On the page: drag to mark it, click to leave a note."}
            value={prompt}
            maxLength={2000}
            onChange={(e) => onPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canGo) onGo();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
          />
          {markCount > 0 && (
            <button className="design-element-clear" title="Clear the marks and notes on the page" onClick={onClearMarks}>
              Clear {markCount}
            </button>
          )}
          {!insert && <div className="design-element-action-wrap">
            <button
              className={`design-element-action${paletteOpen ? " open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={paletteOpen}
              title={`${current.label}: ${current.hint}. Always 3 variants.`}
              onClick={() => (paletteOpen ? setPaletteOpen(false) : openPalette())}
            >
              <current.icon size={14} strokeWidth={1.75} aria-hidden />
              <span>{current.label.toLowerCase()}</span>
              <span className="design-element-times">×3</span>
            </button>
            {paletteOpen && (
              <div className={`design-action-palette${paletteUp ? " up" : ""}`} role="menu" aria-label="Actions" onKeyDown={onPaletteKey}>
                {ACTIONS.map((a, i) => (
                  <button
                    key={a.id}
                    ref={(el) => {
                      cells.current[i] = el;
                    }}
                    role="menuitemradio"
                    aria-checked={a.id === action}
                    tabIndex={i === focusIndex ? 0 : -1}
                    className={`design-action-cell${a.id === action ? " on" : ""}`}
                    title={a.hint}
                    onClick={() => choose(a.id)}
                  >
                    <a.icon size={16} strokeWidth={1.75} aria-hidden />
                    <span>{a.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>}
          <button className="icon-button" aria-label="Dictate" title={DICTATION_HINT} onClick={() => inputRef.current?.focus()}>
            <Mic size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            className="design-element-go"
            aria-label={insert ? "Make 3 options for this spot" : "Make 3 variants"}
            title={goWhy ?? (insert ? "Make 3 options for this spot" : `Make 3 variants (${current.label})`)}
            disabled={!canGo}
            onClick={onGo}
          >
            <ArrowRight size={16} strokeWidth={2} aria-hidden />
          </button>
          <button className="icon-button" aria-label={insert ? "Close Insert" : "Clear the selection"} title={insert ? "Close (Esc)" : "Clear the selection (Esc)"} onClick={onClose}>
            <IconClose />
          </button>
        </>
      )}
    </div>
  );
}

/** The next variant to show for ← or → (wrapping through 1…count), or null for any other key. */
export function cycleStep(shown: number, count: number, key: string): number | null {
  if (count < 1) return null;
  const at = shown >= 1 && shown <= count ? shown : 1;
  if (key === "ArrowRight") return (at % count) + 1;
  if (key === "ArrowLeft") return ((at + count - 2) % count) + 1;
  return null;
}

/**
 * The variant cycler, where the element bar was: `‹ n / 3 ›`, × (back to the original) and Accept. Both choices are
 * made by the main process with no agent turn. A malformed set offers only the way back.
 */
export function VariantCycler({
  shown,
  count,
  malformed,
  place,
  onSize,
  onShow,
  onAccept,
  onDiscard,
  busy,
}: {
  shown: number;
  count: number;
  malformed: string | null;
  place: { left: number; top: number } | null;
  onSize: (size: { width: number; height: number }) => void;
  onShow: (n: number) => void;
  onAccept: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const size = useRef({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    if (next.width !== size.current.width || next.height !== size.current.height) {
      size.current = next;
      onSize(next);
    }
  });
  const style: CSSProperties = place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" };
  const at = shown >= 1 && shown <= count ? shown : 1;
  return (
    <div className="design-element-bar design-variant-cycler" ref={barRef} style={style} role="toolbar" aria-label="Variants">
      {malformed ? (
        <span className="design-element-ask" role="status">
          Variants came back malformed: {malformed}.
        </span>
      ) : (
        <>
          <button className="icon-button" aria-label="Previous variant" title="Previous variant (←)" disabled={busy} onClick={() => onShow(cycleStep(at, count, "ArrowLeft") ?? 1)}>
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <span className="design-variant-count" aria-live="polite">
            {at} / {count}
          </span>
          <button className="icon-button" aria-label="Next variant" title="Next variant (→)" disabled={busy} onClick={() => onShow(cycleStep(at, count, "ArrowRight") ?? 1)}>
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <span className="design-float-divider" aria-hidden />
        </>
      )}
      <button className="icon-button" aria-label="Discard the variants" title="Back to the original (the variants are saved as a version)" disabled={busy} onClick={onDiscard}>
        <X size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {!malformed && (
        <button className="design-variant-accept" disabled={busy} onClick={onAccept} title={`Keep variant ${at} in the page`}>
          <Check size={14} strokeWidth={2} aria-hidden />
          Accept
        </button>
      )}
    </div>
  );
}
