// The design canvas's pure parts: frame sizes, zoom, and the bridge messages. No React, no DOM.

import { MAX_SELECTED, readSelected, type SelectedElement } from "../../../shared/selection";
import type { DesignDevice } from "../../../shared/types";

export type Viewport = "fit" | "mobile" | "tablet" | "desktop" | "slide";
export type Zoom = "fit" | 0.5 | 0.75 | 1 | 1.5;

/** The device chrome drawn around a sized frame; Fit and Slide have none. */
export type DeviceKind = "phone" | "tablet" | "browser";

const DEVICE_OF: Partial<Record<Viewport, DeviceKind>> = { mobile: "phone", tablet: "tablet", desktop: "browser" };

/**
 * The viewport a page opens in before the user picks one: the phone, tablet or slide it declares
 * (`<meta name="cubiq-device">`, or a one-screen phone page), else Fit. A desktop page stays Fit, as before.
 */
export function viewportForDevice(device: DesignDevice | undefined): Viewport {
  return device === "mobile" || device === "tablet" || device === "slide" ? device : "desktop";
}

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
  /** Design v2's stage: the page keeps its width at any scale, and its frame reaches the foot of the stage instead of stopping at the preset's height. */
  fill = false,
): { width: number; height: number; scale: number } {
  const size = VIEWPORTS.find((v) => v.value === viewport)?.size ?? null;
  if (!size) return { width: Math.max(0, stage.width), height: Math.max(0, stage.height), scale: zoom === "fit" ? 1 : zoom };
  if (zoom !== "fit") return { ...size, scale: zoom };
  const room = { width: Math.max(1, stage.width - 2 * STAGE_PAD), height: Math.max(1, stage.height - 2 * STAGE_PAD) };
  const byWidth = room.width / size.width;
  const scale = Math.min(1, viewport === "slide" || whole ? Math.min(byWidth, room.height / size.height) : byWidth);
  return fill ? { width: size.width, height: Math.floor(room.height / scale), scale } : { ...size, scale };
}

export type BridgeMessage =
  /** `loaded`: the fingerprint of the page text the frame loaded (absent when unknown). */
  | { type: "ready"; path?: string; loaded?: string }
  | { type: "scroll"; x: number; y: number }
  | { type: "selection"; elements: SelectedElement[]; lost: number }
  | { type: "text-commit"; target: { id: string } | { locator: { tag: string; path: number[]; text: string } }; before: string; after: string; live: boolean }
  | { type: "history-key"; action: "undo" | "redo" }
  | { type: "pointer" }
  | { type: "theme"; tokens: Record<string, string>; scheme?: "light" | "dark" }
  | { type: "edit-refused"; reason: string }
  | { type: "pins"; missing: number[] }
  | { type: "pick-cancel" }
  | { type: "tweaks"; manifest: string; attrs: Record<string, string>; vars: Record<string, string> }
  | { type: "outline"; nodes: OutlineNode[] }
  | { type: "anchor"; anchor: FrameAnchor | null }
  | { type: "variants"; sets: VariantSetInfo[] }
  | { type: "variant-rect"; set: string; rect: FrameRect | null }
  | { type: "finding"; n: number }
  | { type: "context-menu"; x: number; y: number }
  | { type: "seam"; seam: PageSeam | null }
  | { type: "canvas-key"; key: string; mod: boolean; shift: boolean; alt: boolean }
  | { type: "hit-result"; element: SelectedElement | null }
  /** The page took a patch in place (`ok`), or the canvas must reload it. `n` is the patch it answers. */
  | { type: "patched"; ok: boolean; n: number };

/** A gap between two blocks the pointer is at, in the frame's viewport. */
export type PageSeam = { position: "before" | "after"; anchor: SelectedElement; rect: FrameRect };

/** Where new content goes: before or after the anchor element, and the anchor's size (a hint for what fits there). */
export type InsertGap = { position: "before" | "after"; anchor: SelectedElement; size: { width: number; height: number } };

/** An in-place variant set on the page: how many variants it has, which one shows, and what's wrong with it if anything. */
export type VariantSetInfo = { set: string; count: number; shown: number; malformed: string | null };

/** A box in the frame's viewport, in CSS pixels. */
export type FrameRect = { x: number; y: number; width: number; height: number };

/** Where the picked element is in the frame (`bounds`: all of the selection), and whether its text can be edited. */
export type FrameAnchor = { rect: FrameRect; bounds: FrameRect; editable: boolean; view: { width: number; height: number } };


/** One node of the design page's outline (layer tree), as reported by the bridge. Duplicated from main: no cross-import. */
export interface OutlineNode {
  id?: string;
  tag: string;
  cls: string;
  selector: string;
  label: string;
  depth: number;
  /** Its kit part, from `data-ui`. */
  ui?: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const strMap = (v: unknown, maxKeys: number): v is Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length <= maxKeys && entries.every(([k, val]) => str(k, 64) && str(val, 64));
};

const rect = (v: unknown): v is FrameRect => {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return num(r.x) && num(r.y) && num(r.width) && num(r.height) && r.width >= 0 && r.height >= 0;
};

/** The most one frame may send: any message over the size, or any past the rate, is dropped. */
export const BRIDGE_LIMITS = { bytes: 256 * 1024, perSecond: 300 };

/** The messages that change the file or its history: they must carry this frame load's token. */
const NEEDS_NONCE = new Set(["text-commit", "history-key", "canvas-key", "patched"]);

/**
 * Design v2's door for one frame: drops oversize messages and floods, and drops a file-changing message that doesn't
 * carry the token sent to this load. The page shares a realm with the bridge, so the token doesn't stop its own
 * scripts; what they can reach is limited by readBridgeMessage and the mutation service, which only touch this page.
 */
export function createBridgeGate(newNonce: () => string, now: () => number = () => Date.now()) {
  let nonce = newNonce();
  let windowStart = 0;
  let count = 0;
  return {
    /** A new frame load gets a new token. */
    renew(): string {
      nonce = newNonce();
      return nonce;
    },
    admit(data: unknown): boolean {
      if (!data || typeof data !== "object") return false;
      const t = now();
      if (t - windowStart >= 1000) {
        windowStart = t;
        count = 0;
      }
      if (++count > BRIDGE_LIMITS.perSecond) return false;
      let size = Infinity;
      try {
        size = JSON.stringify(data).length;
      } catch {
        return false;
      }
      if (size > BRIDGE_LIMITS.bytes) return false;
      const d = data as Record<string, unknown>;
      return !NEEDS_NONCE.has(String(d.type)) || d.nonce === nonce;
    },
  };
}

/** A message from the design page's bridge, checked field by field (the page is untrusted); null otherwise. */
export function readBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.source !== "cubiq-design") return null;
  if (d.type === "pick-cancel") return { type: "pick-cancel" };
  if (d.type === "finding") return typeof d.n === "number" && Number.isInteger(d.n) && d.n >= 1 && d.n <= 99 ? { type: "finding", n: d.n } : null;
  if (d.type === "context-menu") return num(d.x) && num(d.y) ? { type: "context-menu", x: d.x, y: d.y } : null;
  if (d.type === "hit-result") {
    if (d.element === null) return { type: "hit-result", element: null };
    const element = readSelected(d.element);
    return element ? { type: "hit-result", element } : null;
  }
  if (d.type === "canvas-key") return typeof d.key === "string" && d.key.length <= 16 ? { type: "canvas-key", key: d.key, mod: d.mod === true, shift: d.shift === true, alt: d.alt === true } : null;
  if (d.type === "seam") {
    if (d.seam === null) return { type: "seam", seam: null };
    const s = d.seam as Record<string, unknown> | undefined;
    if (!s || (s.position !== "before" && s.position !== "after") || !rect(s.rect)) return null;
    const anchor = readSelected(s.anchor);
    return anchor ? { type: "seam", seam: { position: s.position, anchor, rect: s.rect as FrameRect } } : null;
  }
  if (d.type === "patched") return num(d.n) ? { type: "patched", ok: d.ok === true, n: d.n } : null;
  if (d.type === "ready") {
    const loaded = typeof d.loaded === "string" && /^[a-z0-9-]{1,40}$/.test(d.loaded) ? { loaded: d.loaded } : {};
    return str(d.path, 2000) ? { type: "ready", path: d.path, ...loaded } : { type: "ready", ...loaded };
  }
  if (d.type === "scroll") return num(d.x) && num(d.y) ? { type: "scroll", x: d.x, y: d.y } : null;
  if (d.type === "text-commit") {
    if (!str(d.before, 4000) || !str(d.after, 4000) || !d.target || typeof d.target !== "object") return null;
    const live = d.live === true;
    const t = d.target as Record<string, unknown>;
    if (str(t.id, 64) && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(t.id)) return { type: "text-commit", target: { id: t.id }, before: d.before, after: d.after, live };
    const l = t.locator as Record<string, unknown> | undefined;
    if (!l || !str(l.tag, 64) || l.tag === "" || !str(l.text, 80) || !Array.isArray(l.path) || l.path.length > 64 || !l.path.every((n) => Number.isInteger(n) && (n as number) >= 0)) return null;
    return { type: "text-commit", target: { locator: { tag: l.tag, path: l.path as number[], text: l.text } }, before: d.before, after: d.after, live };
  }
  if (d.type === "pointer") return { type: "pointer" };
  if (d.type === "history-key") return d.action === "undo" || d.action === "redo" ? { type: "history-key", action: d.action } : null;
  if (d.type === "theme") {
    if (!d.tokens || typeof d.tokens !== "object" || Array.isArray(d.tokens)) return null;
    const entries = Object.entries(d.tokens as Record<string, unknown>);
    if (!(entries.length <= 200 && entries.every(([k, v]) => /^--[a-z0-9-]{1,48}$/.test(k) && str(v, 120)))) return null;
    const tokens = d.tokens as Record<string, string>;
    return d.scheme === "light" || d.scheme === "dark" ? { type: "theme", tokens, scheme: d.scheme } : { type: "theme", tokens };
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
  if (d.type === "anchor") {
    if (d.rect === null) return { type: "anchor", anchor: null };
    const view = d.view as Record<string, unknown> | undefined;
    if (!rect(d.rect) || !rect(d.bounds) || !view || !num(view.width) || !num(view.height)) return null;
    return { type: "anchor", anchor: { rect: d.rect, bounds: d.bounds, editable: d.editable === true, view: { width: view.width, height: view.height } } };
  }
  if (d.type === "variants") {
    if (!Array.isArray(d.sets) || d.sets.length > 8) return null;
    const sets: VariantSetInfo[] = [];
    for (const raw of d.sets) {
      if (!raw || typeof raw !== "object") return null;
      const v = raw as Record<string, unknown>;
      const int = (x: unknown, max: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;
      if (!str(v.set, 24) || !/^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(v.set) || !int(v.count, 99) || !int(v.shown, 99)) return null;
      if (v.malformed !== null && !(str(v.malformed, 120) && v.malformed)) return null;
      sets.push({ set: v.set, count: v.count, shown: v.shown, malformed: v.malformed as string | null });
    }
    return { type: "variants", sets };
  }
  if (d.type === "variant-rect") {
    if (!str(d.set, 16) || !/^[a-z][a-z0-9]{0,15}$/.test(d.set)) return null;
    if (d.rect === null) return { type: "variant-rect", set: d.set, rect: null };
    return rect(d.rect) ? { type: "variant-rect", set: d.set, rect: d.rect } : null;
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
      if (str(n.ui, 48) && /^[a-z0-9][a-z0-9-]{0,47}$/.test(n.ui)) node.ui = n.ui;
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
