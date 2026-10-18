/** P2.3 windowed transcript: which display segments to mount for a scroll position. */

/** Below this many segments a thread renders everything, exactly as it always has. */
export const WINDOW_MIN_SEGMENTS = 200;
/** A segment's height before it has been measured; it only feeds the spacers. */
export const ESTIMATE_PX = 120;
/** Rows this far outside the viewport stay mounted, so a fast scroll doesn't flash. */
export const OVERSCAN_PX = 1200;

export interface SegmentWindow {
  /** Half-open [start, end) of segments to mount. */
  start: number;
  end: number;
  /** px above `start` and below `end`: the two spacer heights. */
  before: number;
  after: number;
}

/**
 * The segments intersecting [scrollTop − overscan, scrollTop + viewport + overscan].
 * `heights[i]` is segment i's measured height (or ESTIMATE_PX when unknown). Always
 * returns at least one segment when `heights` is non-empty, clamped at both ends.
 */
export function computeWindow(heights: number[], scrollTop: number, viewport: number, overscan = OVERSCAN_PX): SegmentWindow {
  const n = heights.length;
  if (n === 0) return { start: 0, end: 0, before: 0, after: 0 };
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + heights[i]!;
  const top = scrollTop - overscan;
  const bottom = scrollTop + viewport + overscan;
  // First segment whose bottom edge is past `top`.
  let start = 0;
  while (start < n && prefix[start + 1]! <= top) start++;
  // First segment whose top edge is at/after `bottom` ends the range.
  let end = start;
  while (end < n && prefix[end]! < bottom) end++;
  if (start > n - 1) start = n - 1;
  if (end <= start) end = Math.min(n, start + 1);
  return { start, end, before: prefix[start]!, after: prefix[n]! - prefix[end]! };
}
