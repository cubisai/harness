/**
 * Streamed text arrives in bursts; showing it at a steady pace reads better.
 * The backlog shrinks with a time constant of CATCH_UP_MS (a 2,000-character
 * burst is on screen in well under a second), and never slower than MIN_CPS
 * characters a second, so the tail doesn't crawl and a slow stream keeps up.
 */
export const CATCH_UP_MS = 150;
export const MIN_CPS = 300;

/** How many characters to show after `dtMs`, given `shown` of `target` so far. */
export function nextReveal(shown: number, target: number, dtMs: number): number {
  if (shown >= target) return target;
  const backlog = target - shown;
  const step = Math.max((backlog * dtMs) / CATCH_UP_MS, (MIN_CPS * dtMs) / 1000, 1);
  return Math.min(target, shown + Math.ceil(step));
}

/** Where a reveal should resume when the text changed under it: the common prefix, or the start. */
export function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
