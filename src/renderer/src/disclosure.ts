/** The transcript's disclosures that a click inside their open body folds again (tool rows, the work group, thinking, a subagent's prompt/report). */
export const BODY_COLLAPSIBLE = "details.tool, details.work, details.thinking, details.subagent-fold";

/** What a click acts on by itself, so it never folds the block around it. */
const INTERACTIVE = "summary, a, button, input, textarea, select, label, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable], iframe, video, audio, canvas";

/**
 * The open disclosure a plain click inside its body should fold: the innermost one around the target,
 * or null when the click lands on something interactive, inside a disclosure that doesn't fold this
 * way, or while the user has text selected (they were selecting, not dismissing).
 */
export function collapseTarget(target: Element | null, selection: string): HTMLDetailsElement | null {
  if (!target || selection.trim()) return null;
  if (target.closest(INTERACTIVE)) return null;
  const details = target.closest("details");
  if (!details || !details.open || !details.matches(BODY_COLLAPSIBLE)) return null;
  return details as HTMLDetailsElement;
}

/** Where a toggled disclosure's header must stay: where it is now, or the scroller's top edge when it sits above it (a long block folded from its bottom). */
export interface ScrollAnchor {
  node: Element;
  top: number;
}

export function anchorFor(summary: Element, scroller: Element, margin = 8): ScrollAnchor {
  const top = summary.getBoundingClientRect().top;
  const edge = scroller.getBoundingClientRect().top + margin;
  return { node: summary, top: Math.max(top, edge) };
}

/** How far to scroll so the anchored header is back where the anchor says. */
export function anchorDelta(anchor: ScrollAnchor): number {
  return anchor.node.getBoundingClientRect().top - anchor.top;
}

/** How close to the bottom counts as "at the bottom", so the transcript follows new content. */
export const PIN_SLACK_PX = 80;

/**
 * Whether the transcript still follows new content after a scroll from `prevTop`. Moving up away
 * from the bottom unpins at once: a wheel scroll is animated, and its first frames are only a few
 * px from the bottom, where streaming text would otherwise pull the view back down every frame.
 * Reaching the bottom again (or a clamp that leaves it there) pins it.
 */
export function stillPinned(prevTop: number, el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (el.scrollTop < prevTop - 0.5 && distance > 1) return false;
  return distance < PIN_SLACK_PX;
}
