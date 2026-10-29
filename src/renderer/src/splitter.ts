// The pane splitter's logic: which width it writes, and how keyboard and
// pointer input move it. Pure reducers, so a component is just the glue.

import { clamp } from "./layout";

export interface SplitterState {
  value: number;
  min: number;
  max: number;
  collapsed: boolean;
  defaultValue: number;
  /** Left widens (a divider on the pane's left edge, like the inspector's). */
  invert?: boolean;
}

export const STEP = 8;

/** The width a splitter writes and announces: 0 while collapsed. */
export const splitterValue = (s: SplitterState) => (s.collapsed ? 0 : s.value);

/** Keyboard, per the WAI-ARIA window-splitter pattern. Unknown keys return the same state object. */
export function splitterKeys(s: SplitterState, key: string): SplitterState {
  if (key === "Enter") return { ...s, collapsed: !s.collapsed };
  if (key === "ArrowRight" || key === "ArrowLeft") {
    const delta = (key === "ArrowRight" ? STEP : -STEP) * (s.invert ? -1 : 1);
    return { ...s, collapsed: false, value: clamp(s.value + delta, s.min, s.max) };
  }
  if (key === "Home") return { ...s, collapsed: false, value: s.min };
  if (key === "End") return { ...s, collapsed: false, value: s.max };
  return s;
}

/** Double-click: back to the default width, expanded. */
export const splitterReset = (s: SplitterState): SplitterState => ({ ...s, collapsed: false, value: s.defaultValue });

export interface DragState {
  dragging: boolean;
  startX: number;
  startValue: number;
  value: number;
  min: number;
  max: number;
  invert?: boolean;
}

export type DragAction = { type: "down"; x: number } | { type: "move"; x: number } | { type: "up" };

/** Pointer drag. Width follows every move; it is persisted once, on release (persist is non-null only for "up" after a drag). */
export function dragReducer(s: DragState, a: DragAction): { state: DragState; persist: number | null } {
  if (a.type === "down") return { state: { ...s, dragging: true, startX: a.x, startValue: s.value }, persist: null };
  if (!s.dragging) return { state: s, persist: null };
  if (a.type === "move") {
    const value = clamp(s.startValue + (a.x - s.startX) * (s.invert ? -1 : 1), s.min, s.max);
    return { state: { ...s, value }, persist: null };
  }
  return { state: { ...s, dragging: false }, persist: s.value };
}