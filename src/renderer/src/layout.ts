// The renderer's view of panel geometry: the shared bounds, defaults and
// sanitizer, plus the window-width clamp. Pure, no React, no DOM.

import type { PaneLayout } from "../../shared/types";
import { BOUNDS, chatFloor, clamp, inspectorCap } from "../../shared/layout";

export { BOUNDS, DEFAULT_LAYOUT, chatFloor, clamp, inspectorCap, sanitizeLayout } from "../../shared/layout";

/**
 * The widths to draw at this window width. The stored layout is never changed here. The panel is capped at 80% of
 * the space right of the sidebar (`inspectorMax`, also the splitter's max). The chat keeps its normal minimum (420)
 * unless the user dragged the panel wide (`inspectorWide`), when it may go down to its floor (260, or 20%). When the
 * chat would drop below that, the inspector first narrows toward its own minimum, then the sidebar gives way, and
 * only when even that can't fit does the inspector auto-collapse (inspector: null). It comes back at its stored width
 * when the window grows again. If the chat is still too narrow, the sidebar shrinks toward its minimum.
 */
export function clampLayout(
  windowWidth: number,
  layout: PaneLayout,
  inspectorOpen = true,
): { sidebar: number; inspector: number | null; main: number; inspectorAutoCollapsed: boolean; inspectorMax: number } {
  let sidebar = layout.sidebarCollapsed ? BOUNDS.rail : clamp(layout.sidebar, BOUNDS.sidebar.min, BOUNDS.sidebar.max);
  const inspectorMax = inspectorCap(windowWidth - sidebar);
  const floor = layout.inspectorWide ? chatFloor(windowWidth - sidebar) : BOUNDS.main;
  const wanted = inspectorOpen && !layout.inspectorCollapsed ? clamp(layout.inspector, BOUNDS.inspector.min, inspectorMax) : null;
  let inspector = wanted;
  let inspectorAutoCollapsed = false;
  if (wanted !== null && windowWidth - sidebar - wanted < floor) {
    const room = windowWidth - sidebar - floor;
    const sidebarRoom = windowWidth - floor - BOUNDS.inspector.min;
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
  if (windowWidth - sidebar - (inspector ?? 0) < floor && !layout.sidebarCollapsed) {
    sidebar = Math.max(BOUNDS.sidebar.min, windowWidth - floor - (inspector ?? 0));
  }
  const main = windowWidth - sidebar - (inspector ?? 0);
  return { sidebar, inspector, main, inspectorAutoCollapsed, inspectorMax };
}

/** Whether a panel width the user set leaves the chat under its normal minimum, which marks it as dragged wide. */
export function isWideInspector(windowWidth: number, sidebar: number, inspector: number): boolean {
  return inspector > 0 && windowWidth - sidebar - inspector < BOUNDS.main;
}
