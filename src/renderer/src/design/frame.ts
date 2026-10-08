// The design canvas's pure parts: frame sizes, zoom, and the bridge messages. No React, no DOM.

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

export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
}

export type BridgeMessage =
  | { type: "ready" }
  | { type: "scroll"; x: number; y: number }
  | { type: "picked"; element: PickedElement }
  | { type: "pick-cancel" };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** A message from the design page's bridge, checked field by field (the page is untrusted); null otherwise. */
export function readBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.source !== "cubiq-design") return null;
  if (d.type === "ready" || d.type === "pick-cancel") return { type: d.type };
  if (d.type === "scroll") return num(d.x) && num(d.y) ? { type: "scroll", x: d.x, y: d.y } : null;
  if (d.type === "picked") {
    const e = d.element as Record<string, unknown> | null | undefined;
    const r = e?.rect as Record<string, unknown> | null | undefined;
    if (!e || !r || !str(e.selector, 2000) || !e.selector || !str(e.tag, 64) || !str(e.text, 300) || !str(e.html, 1200)) return null;
    if (!num(r.x) || !num(r.y) || !num(r.width) || !num(r.height)) return null;
    return { type: "picked", element: { selector: e.selector, tag: e.tag, text: e.text, html: e.html, rect: { x: r.x, y: r.y, width: r.width, height: r.height } } };
  }
  return null;
}

/** What a picked element puts in the message box: the browser pick's format, so the chip shows its selector. */
export function pickChipText(el: PickedElement, page: string): string {
  const r = el.rect;
  const lines = [`Element \`${el.selector}\` in ${page}`];
  if (el.text) lines.push(`Text: "${el.text}"`);
  lines.push("```html", el.html + (el.html.length >= 1200 ? "…" : ""), "```");
  lines.push(`Box: ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)}`);
  return lines.join("\n");
}
