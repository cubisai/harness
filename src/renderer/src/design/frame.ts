// The design canvas's pure parts: frame sizes, zoom, and the bridge messages. No React, no DOM.

import { MAX_SELECTED, readSelected, type SelectedElement } from "../../../shared/selection";

export type Viewport = "fit" | "mobile" | "tablet" | "desktop" | "slide";
export type Zoom = "fit" | 0.5 | 0.75 | 1 | 1.5;

export const VIEWPORTS: { value: Viewport; label: string; detail: string; size: { width: number; height: number } | null }[] = [
  { value: "fit", label: "Fit", detail: "The canvas's own size", size: null },
  { value: "mobile", label: "Mobile", detail: "390 × 844", size: { width: 390, height: 844 } },
  { value: "tablet", label: "Tablet", detail: "768 × 1024", size: { width: 768, height: 1024 } },
  { value: "desktop", label: "Desktop", detail: "1440 × 900", size: { width: 1440, height: 900 } },
  { value: "slide", label: "Slide", detail: "1920 × 1080", size: { width: 1920, height: 1080 } },
];

export const ZOOMS: { value: Zoom; label: string }[] = [
  { value: "fit", label: "Fit" },
  { value: 0.5, label: "50%" },
  { value: 0.75, label: "75%" },
  { value: 1, label: "100%" },
  { value: 1.5, label: "150%" },
];

/** The room kept around a sized frame inside the stage. */
export const STAGE_PAD = 24;

/**
 * The frame's own size and its scale on the stage. "Fit" fills the stage at 100%; a preset keeps its size and, on
 * zoom Fit, scales down (never up) so it fits the stage's width, and its height too for a slide.
 */
export function frameLayout(viewport: Viewport, zoom: Zoom, stage: { width: number; height: number }): { width: number; height: number; scale: number } {
  const size = VIEWPORTS.find((v) => v.value === viewport)?.size ?? null;
  if (!size) return { width: Math.max(0, stage.width), height: Math.max(0, stage.height), scale: zoom === "fit" ? 1 : zoom };
  if (zoom !== "fit") return { ...size, scale: zoom };
  const room = { width: Math.max(1, stage.width - 2 * STAGE_PAD), height: Math.max(1, stage.height - 2 * STAGE_PAD) };
  const byWidth = room.width / size.width;
  const scale = Math.min(1, viewport === "slide" ? Math.min(byWidth, room.height / size.height) : byWidth);
  return { ...size, scale };
}

export type BridgeMessage =
  | { type: "ready"; path?: string }
  | { type: "scroll"; x: number; y: number }
  | { type: "selection"; elements: SelectedElement[]; lost: number }
  | { type: "pick-cancel" }
  | { type: "tweaks"; manifest: string; attrs: Record<string, string>; vars: Record<string, string> };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const strMap = (v: unknown, maxKeys: number): v is Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length <= maxKeys && entries.every(([k, val]) => str(k, 64) && str(val, 64));
};

/** A message from the design page's bridge, checked field by field (the page is untrusted); null otherwise. */
export function readBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.source !== "cubiq-design") return null;
  if (d.type === "pick-cancel") return { type: "pick-cancel" };
  if (d.type === "ready") return str(d.path, 2000) ? { type: "ready", path: d.path } : { type: "ready" };
  if (d.type === "scroll") return num(d.x) && num(d.y) ? { type: "scroll", x: d.x, y: d.y } : null;
  if (d.type === "selection") {
    if (!Array.isArray(d.elements) || d.elements.length > MAX_SELECTED) return null;
    const elements: SelectedElement[] = [];
    for (const raw of d.elements) {
      const el = readSelected(raw);
      if (el) elements.push(el);
    }
    const rawLost = d.lost;
    const lost = typeof rawLost === "number" && Number.isInteger(rawLost) && rawLost >= 0 && rawLost <= MAX_SELECTED ? rawLost : 0;
    return { type: "selection", elements, lost };
  }
  if (d.type === "tweaks") {
    if (!str(d.manifest, 8000) || !strMap(d.attrs, 32) || !strMap(d.vars, 32)) return null;
    return { type: "tweaks", manifest: d.manifest, attrs: d.attrs, vars: d.vars };
  }
  return null;
}

/** The design page a frame's `location.pathname` names, or null when it is not this thread's own path. */
export function pageFromPath(pathname: string, threadId: string): string | null {
  const parts = pathname.replace(/^\/+/, "").split("/");
  const segs: string[] = [];
  for (const part of parts) {
    try {
      segs.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  if (segs[0] !== threadId || segs.length < 2) return null;
  const rest = segs.slice(1);
  for (const s of rest) {
    if (s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0")) return null;
  }
  return rest.join("/");
}
