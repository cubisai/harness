// Panel geometry, shared by the main process (persistence) and the renderer
// (drawing). Pure math only: no React, no DOM.

import type { PaneLayout } from "./types";

export const BOUNDS = { sidebar: { min: 180, max: 360 }, rail: 48, inspector: { min: 320, max: 720 }, main: 420, terminal: { min: 120, max: 600 } } as const;

export const DEFAULT_LAYOUT: PaneLayout = { sidebar: 256, sidebarCollapsed: false, inspector: 460, inspectorCollapsed: false, terminal: 240, terminalOpen: false, browserWide: false };

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
  };
}