// The design canvas's pure parts: frame sizes, zoom, and the bridge messages. No React, no DOM.

import { MAX_SELECTED, readSelected, type SelectedElement } from "../../../shared/selection";

export type Viewport = "fit" | "mobile" | "tablet" | "desktop" | "slide";
export type Zoom = "fit" | 0.5 | 0.75 | 1 | 1.5;

/** The device chrome drawn around a sized frame; Fit and Slide have none. */
export type DeviceKind = "phone" | "tablet" | "browser";

const DEVICE_OF: Partial<Record<Viewport, DeviceKind>> = { mobile: "phone", tablet: "tablet", desktop: "browser" };

/** The device a viewport is shown in, or null when it has none. */
export function deviceFor(viewport: Viewport): DeviceKind | null {
  return DEVICE_OF[viewport] ?? null;
}

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
export function frameLayout(
  viewport: Viewport,
  zoom: Zoom,
  stage: { width: number; height: number },
  /** Fit the whole frame (width and height), as a device frame does; otherwise Fit matches the width and the stage scrolls. */
  whole = false,
): { width: number; height: number; scale: number } {
  const size = VIEWPORTS.find((v) => v.value === viewport)?.size ?? null;
  if (!size) return { width: Math.max(0, stage.width), height: Math.max(0, stage.height), scale: zoom === "fit" ? 1 : zoom };
  if (zoom !== "fit") return { ...size, scale: zoom };
  const room = { width: Math.max(1, stage.width - 2 * STAGE_PAD), height: Math.max(1, stage.height - 2 * STAGE_PAD) };
  const byWidth = room.width / size.width;
  const scale = Math.min(1, viewport === "slide" || whole ? Math.min(byWidth, room.height / size.height) : byWidth);
  return { ...size, scale };
}

export type BridgeMessage =
  | { type: "ready"; path?: string }
  | { type: "scroll"; x: number; y: number }
  | { type: "selection"; elements: SelectedElement[]; lost: number }
  | { type: "text-edit"; id: string; before: string; after: string }
  | { type: "edit-refused"; reason: string }
  | { type: "pins"; missing: number[] }
  | { type: "pick-cancel" }
  | { type: "tweaks"; manifest: string; attrs: Record<string, string>; vars: Record<string, string> }
  | { type: "outline"; nodes: OutlineNode[] };

/** One node of the design page's outline (layer tree), as reported by the bridge. Duplicated from main: no cross-import. */
export interface OutlineNode {
  id?: string;
  tag: string;
  cls: string;
  selector: string;
  label: string;
  depth: number;
}

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
  if (d.type === "text-edit") {
    if (!str(d.id, 64) || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(d.id) || !str(d.before, 4000) || !str(d.after, 2000)) return null;
    return { type: "text-edit", id: d.id, before: d.before, after: d.after };
  }
  if (d.type === "pins") {
    if (!Array.isArray(d.missing) || d.missing.length > 100) return null;
    const missing = d.missing.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 999);
    return { type: "pins", missing };
  }
  if (d.type === "edit-refused") return str(d.reason, 200) && d.reason ? { type: "edit-refused", reason: d.reason } : null;
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
  if (d.type === "outline") {
    if (!Array.isArray(d.nodes) || d.nodes.length > 400) return null;
    const nodes: OutlineNode[] = [];
    for (const raw of d.nodes) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      if (!str(n.tag, 32) || !/^[a-z][a-z0-9-]{0,31}$/.test(n.tag)) continue;
      if (!str(n.cls, 60) || !str(n.selector, 1000) || !str(n.label, 40)) continue;
      if (typeof n.depth !== "number" || !Number.isInteger(n.depth) || n.depth < 0 || n.depth > 8) continue;
      const node: OutlineNode = { tag: n.tag, cls: n.cls, selector: n.selector, label: n.label, depth: n.depth };
      if (str(n.id, 64) && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(n.id)) node.id = n.id;
      nodes.push(node);
    }
    return { type: "outline", nodes };
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
