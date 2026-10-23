/** Overlays and popovers that own Escape; while one is open, Escape closes it instead of stopping the turn. */
export const ESCAPE_OWNERS = ".skill-menu, .palette, .search-dialog, .sheet, .library, .model-menu, .open-menu, .thread-menu, .artifact-menu, .design-drawer:not([hidden])";

/** The same owners without the design transcript drawer: while one of these is open, Escape is theirs, not the drawer's. */
export const ESCAPE_OWNERS_OVER_DRAWER = ESCAPE_OWNERS.replace(", .design-drawer:not([hidden])", "");

export interface EscapeTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?(selector: string): unknown;
}

/** Whether this Escape keypress should stop the running turn. */
export function escapeStopsTurn(e: { key: string; defaultPrevented: boolean; target: EscapeTarget | null }, running: boolean, overlayOpen: boolean): boolean {
  if (e.key !== "Escape" || !running || e.defaultPrevented || overlayOpen) return false;
  const target = e.target;
  if (target?.closest?.(".terminal-drawer, .xterm")) return false;
  const editable = Boolean(target?.isContentEditable) || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
  if (editable) return Boolean(target?.closest?.(".composer-wrap"));
  return true;
}
