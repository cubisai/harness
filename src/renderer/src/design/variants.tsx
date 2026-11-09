import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { FrameRect, InsertGap, PageMarks } from "./frame";

/** What a set of 3 variants pushes on. */
export type ActionId = "freeform" | "bolder" | "quieter" | "distill" | "polish" | "typeset" | "colorize" | "layout" | "adapt" | "animate" | "delight" | "overdrive";

/** Each direction's name in the message the agent gets. */
export const ACTION_LABELS: Record<ActionId, string> = {
  freeform: "Freeform",
  bolder: "Bolder",
  quieter: "Quieter",
  distill: "Distill",
  polish: "Polish",
  typeset: "Typeset",
  colorize: "Colorize",
  layout: "Layout",
  adapt: "Adapt",
  animate: "Animate",
  delight: "Delight",
  overdrive: "Overdrive",
};

/** The message an Explore action sends (the canvas adds the selection scope and the capture). */
export function goMessage(action: ActionId, prompt: string, marks: PageMarks): string {
  const lines = [action === "freeform" ? "Make 3 variants of the selected element." : `Make 3 variants of the selected element: ${ACTION_LABELS[action]}.`];
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
 * Where a floating bar (the variant cycler) goes inside the stage: under the element, centred on it; above it when there's no room
 * below; docked to the visible frame's top or bottom edge when the element has scrolled off (or fills the view).
 * All boxes are in the same coordinates (the stage wrapper's); `view` is the part of the frame that shows.
 */
export function placeFloatingBar(
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

/** True when Esc on this target may clear the canvas selection: not typed into a text field, dialog or menu. */
export function escClears(target: EventTarget | null): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null;
  if (!t) return true;
  if (t.isContentEditable) return false;
  const tag = (t.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return false;
  return !t.closest?.('[role="dialog"], [role="menu"], [role="listbox"]');
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
 * The variant cycler, under the variant set: `‹ n / 3 ›`, × (back to the original) and Accept. Both choices are
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
