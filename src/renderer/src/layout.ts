// The renderer's view of panel geometry: the shared bounds, defaults and
// sanitizer, plus the window-width clamp. Pure, no React, no DOM.

import type { PaneLayout } from "../../shared/types";
import { BOUNDS, clamp } from "../../shared/layout";

export { BOUNDS, DEFAULT_LAYOUT, clamp, sanitizeLayout } from "../../shared/layout";

/**
 * The widths to draw at this window width. The stored layout is never changed here: when the main pane would drop
 * below its minimum the inspector first narrows toward its own minimum, then the sidebar gives way, and only when
 * even that can't fit does the inspector auto-collapse (inspector: null). It comes back at its stored width when the
 * window grows again. If the main pane is still too narrow, the sidebar shrinks toward its minimum.
 */
export function clampLayout(windowWidth: number, layout: PaneLayout, inspectorOpen = true): { sidebar: number; inspector: number | null; main: number; inspectorAutoCollapsed: boolean } {
  let sidebar = layout.sidebarCollapsed ? BOUNDS.rail : clamp(layout.sidebar, BOUNDS.sidebar.min, BOUNDS.sidebar.max);
  const wanted = inspectorOpen && !layout.inspectorCollapsed ? clamp(layout.inspector, BOUNDS.inspector.min, BOUNDS.inspector.max) : null;
  let inspector = wanted;
  let inspectorAutoCollapsed = false;
  if (wanted !== null && windowWidth - sidebar - wanted < BOUNDS.main) {
    const room = windowWidth - sidebar - BOUNDS.main;
    const sidebarRoom = windowWidth - BOUNDS.main - BOUNDS.inspector.min;
    if (room >= BOUNDS.inspector.min) {
      inspector = room;
    } else if (!layout.sidebarCollapsed && sidebarRoom >= BOUNDS.sidebar.min) {
      sidebar = sidebarRoom;
      inspector = BOUNDS.inspector.min;
    } else {
      inspector = null;
      inspectorAutoCollapsed = true;
    }
  }
  if (windowWidth - sidebar - (inspector ?? 0) < BOUNDS.main && !layout.sidebarCollapsed) {
    sidebar = Math.max(BOUNDS.sidebar.min, windowWidth - BOUNDS.main - (inspector ?? 0));
  }
  const main = windowWidth - sidebar - (inspector ?? 0);
  return { sidebar, inspector, main, inspectorAutoCollapsed };
}