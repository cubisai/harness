// Panel geometry, shared by the main process (persistence) and the renderer
// (drawing). Pure math only: no React, no DOM.

import type { PaneLayout } from "./types";

/**
 * `inspector.max` is only a sanity bound for stored values: the real cap is relative to the window (`inspectorCap`).
 * `main` is the chat's normal minimum; a panel the user dragged wide lets it go down to `mainFloor` (or 20%).
 */
export const BOUNDS = {
  sidebar: { min: 180, max: 360 },
  rail: 48,
  inspector: { min: 320, max: 4000, share: 0.8 },
  main: 420,
  mainFloor: 260,
  terminal: { min: 120, max: 600 },
  /** A design thread's chat column; its real max leaves the canvas `designCanvas` (see designChatWidth). */
  designChat: { min: 260, max: 4000 },
  designCanvas: 480,
} as const;

export const DEFAULT_LAYOUT: PaneLayout = {
  sidebar: 256,
  sidebarCollapsed: false,
  inspector: 460,
  inspectorCollapsed: false,
  terminal: 240,
  terminalOpen: false,
  browserWide: false,
  inspectorWide: false,
  designChat: null,
};

/** The narrowest the chat gets beside a wide panel: 20% of the space right of the sidebar, never under `mainFloor`. */
export const chatFloor = (avail: number) => Math.max(BOUNDS.mainFloor, Math.ceil(avail * (1 - BOUNDS.inspector.share)));

/** The widest the side panel may be, given the space right of the sidebar: 80% of it, leaving the chat its floor. */
export const inspectorCap = (avail: number) => Math.max(BOUNDS.inspector.min, Math.min(Math.floor(avail * BOUNDS.inspector.share), avail - chatFloor(avail)));

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** A finite number clamped to its bounds, or the fallback when the value isn't one. */
const num = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback);

/** A boolean, or the fallback when the value isn't one. */
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** A stored paneLayout as a PaneLayout: each field clamped or defaulted, unknown shapes reset. */
export function sanitizeLayout(value: unknown): PaneLayout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_LAYOUT };
  const v = value as Record<string, unknown>;
  return {
    sidebar: num(v.sidebar, DEFAULT_LAYOUT.sidebar, BOUNDS.sidebar.min, BOUNDS.sidebar.max),
    sidebarCollapsed: bool(v.sidebarCollapsed, DEFAULT_LAYOUT.sidebarCollapsed),
    inspector: num(v.inspector, DEFAULT_LAYOUT.inspector, BOUNDS.inspector.min, BOUNDS.inspector.max),
    inspectorCollapsed: bool(v.inspectorCollapsed, DEFAULT_LAYOUT.inspectorCollapsed),
    terminal: num(v.terminal, DEFAULT_LAYOUT.terminal, BOUNDS.terminal.min, BOUNDS.terminal.max),
    terminalOpen: bool(v.terminalOpen, DEFAULT_LAYOUT.terminalOpen),
    browserWide: bool(v.browserWide, DEFAULT_LAYOUT.browserWide),
    inspectorWide: bool(v.inspectorWide, DEFAULT_LAYOUT.inspectorWide),
    designChat: typeof v.designChat === "number" && Number.isFinite(v.designChat) ? clamp(v.designChat, BOUNDS.designChat.min, BOUNDS.designChat.max) : null,
  };
}

/**
 * A design thread's chat width and its splitter's max, given the room right of the sidebar and left of the side
 * panel: the width the user dragged to (kept so the canvas has `designCanvas`), else 45% of the room within 260–420
 * (the CSS default in app.css's `.app.design-thread`).
 */
export function designChatWidth(room: number, dragged: number | null): { width: number; max: number } {
  const max = Math.max(BOUNDS.designChat.min, room - BOUNDS.designCanvas);
  if (dragged === null) return { width: clamp(Math.round(room * 0.45), BOUNDS.designChat.min, 420), max };
  return { width: clamp(dragged, BOUNDS.designChat.min, max), max };
}