// The board's pure parts: page naming, section grouping, layout and view maths. No React, no DOM.

import { isVariant, variantLabel } from "../../../shared/design";

/** The frame size a page's artboard is laid out at on the board. */
export type BoardKind = "mobile" | "tablet" | "desktop" | "slide";

export const BOARD_SIZES: Record<BoardKind, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
  slide: { width: 1920, height: 1080 },
};

/** The per-frame header band above an artboard. */
export const BOARD_HEADER = 28;
/** The section title band above a section's frames (frames start at TITLE_BAND + BOARD_HEADER). */
export const BOARD_TITLE_BAND = 56;

export interface BoardPage {
  rel: string;
  url: string;
  section: string;
  label: string;
  step: number | null;
  kind: BoardKind;
  variant: boolean;
}

/** A slug turned into a short title: "mobile-flow" -> "Mobile flow" (first word capitalised only). */
function titleCase(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  if (!words) return slug;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The artboard kind a page is drawn at, from its section and file name. */
function kindOf(section: string, raw: string): BoardKind {
  const hay = `${section} ${raw}`.toLowerCase();
  if (/mobile|phone/.test(hay)) return "mobile";
  if (/tablet|ipad/.test(hay)) return "tablet";
  if (/slide|deck/.test(hay)) return "slide";
  return "desktop";
}

/**
 * A page as the board shows it: its section, a human label, an optional flow step, the artboard kind it's drawn at.
 * `mobile-flow--01-create.html` is step 1 of the "Mobile flow" section; a `variant-*.html` is an option.
 */
export function parsePage(rel: string, url: string): BoardPage {
  const variant = isVariant(rel);
  const base = rel.replace(/\.html?$/i, "");
  let section: string;
  let raw: string;
  if (variant) {
    section = "Options";
    raw = base;
  } else {
    const sep = base.indexOf("--");
    if (sep >= 0) {
      section = titleCase(base.slice(0, sep));
      raw = base.slice(sep + 2);
    } else {
      section = "Pages";
      raw = base;
    }
  }
  let step: number | null = null;
  let label: string;
  if (variant) {
    label = `Option ${variantLabel(rel)}`;
  } else {
    const m = /^(\d+)-(.+)$/.exec(raw);
    if (m) {
      step = Number(m[1]);
      label = `${step} ${titleCase(m[2]!)}`;
    } else {
      label = titleCase(raw);
    }
  }
  return { rel, url, section, label, step, kind: kindOf(section, raw), variant };
}

/** The board's sections in first-seen order, with "Options" always last and stepped pages sorted by step. */
export function boardSections(pages: { rel: string; url: string }[]): { title: string; pages: BoardPage[] }[] {
  const map = new Map<string, BoardPage[]>();
  for (const p of pages) {
    const page = parsePage(p.rel, p.url);
    const list = map.get(page.section);
    if (list) list.push(page);
    else map.set(page.section, [page]);
  }
  const titles = [...map.keys()].filter((t) => t !== "Options");
  if (map.has("Options")) titles.push("Options");
  return titles.map((title) => {
    const list = map.get(title)!;
    const stepped = list.filter((p) => p.step !== null).sort((a, b) => a.step! - b.step!);
    const rest = list.filter((p) => p.step === null);
    return { title, pages: [...stepped, ...rest] };
  });
}

/** The board's pages in the order a viewer steps through them: sections top-to-bottom, frames left-to-right. */
export function flowOrder(pages: { rel: string; url: string }[]): string[] {
  return boardSections(pages).flatMap((s) => s.pages.map((p) => p.rel));
}

export interface BoardFrame {
  page: BoardPage;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardSectionLayout {
  title: string;
  x: number;
  y: number;
  frames: BoardFrame[];
}

export interface BoardLayout {
  width: number;
  height: number;
  sections: BoardSectionLayout[];
}

/**
 * Stacks the sections top-to-bottom at a 0,0 origin (one row per section, so the board stays as narrow as its widest
 * row and fits the canvas pane): frames inside a section run left-to-right with `gap`, each at the size its kind asks
 * for, under a 56px title band and a 28px per-frame header. `sectionGap` sits between sections. Frame x/y are
 * relative to their section's origin.
 */
export function boardLayout(sections: { title: string; pages: BoardPage[] }[], gap = 48, sectionGap = 120): BoardLayout {
  const framesY = BOARD_TITLE_BAND + BOARD_HEADER;
  const out: BoardLayout = { width: 0, height: 0, sections: [] };
  let y = 0;
  let maxWidth = 0;
  for (const s of sections) {
    const frames: BoardFrame[] = [];
    let fx = 0;
    let sectionBottom = framesY;
    for (const page of s.pages) {
      const size = BOARD_SIZES[page.kind];
      frames.push({ page, x: fx, y: framesY, width: size.width, height: size.height });
      fx += size.width + gap;
      sectionBottom = Math.max(sectionBottom, framesY + size.height);
    }
    out.sections.push({ title: s.title, x: 0, y, frames });
    y += sectionBottom + sectionGap;
    maxWidth = Math.max(maxWidth, fx - gap);
  }
  out.width = Math.max(0, maxWidth);
  out.height = sections.length ? Math.max(0, y - sectionGap) : 0;
  return out;
}

/** A zoom kept within what the board allows: 5% to 200%. */
export function clampZoom(z: number): number {
  return Math.min(2, Math.max(0.05, z));
}

/** Zooms a view by `factor` around the screen point (px, py), which stays fixed on screen. */
export function zoomAt(view: { x: number; y: number; zoom: number }, factor: number, px: number, py: number): { x: number; y: number; zoom: number } {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** A view that fits the whole board inside the stage, centred, with `pad` around it, never zoomed above 100%. */
export function fitView(layout: { width: number; height: number }, stage: { width: number; height: number }, pad = 48): { x: number; y: number; zoom: number } {
  const room = { width: Math.max(1, stage.width - 2 * pad), height: Math.max(1, stage.height - 2 * pad) };
  const zoom = clampZoom(Math.min(1, room.width / Math.max(1, layout.width), room.height / Math.max(1, layout.height)));
  return { x: (stage.width - layout.width * zoom) / 2, y: (stage.height - layout.height * zoom) / 2, zoom };
}

/** On-screen room a section needs above its frames for its title and the frame headers (they don't scale). */
export const BOARD_LABEL_ROOM = 72;

/**
 * Fits the board to the stage, widening the gap between sections until the titles and frame headers (kept at their
 * on-screen size) have BOARD_LABEL_ROOM pixels between one section's frames and the next's at the fitted zoom.
 */
export function fitBoard(
  sections: { title: string; pages: BoardPage[] }[],
  stage: { width: number; height: number },
  labelRoom = BOARD_LABEL_ROOM,
): { sectionGap: number; view: { x: number; y: number; zoom: number } } {
  let sectionGap = 120;
  let view = fitView(boardLayout(sections, 48, sectionGap), stage);
  for (let i = 0; i < 8; i++) {
    const need = Math.max(120, labelRoom / view.zoom - BOARD_TITLE_BAND - BOARD_HEADER);
    if (need <= sectionGap + 0.5) break;
    sectionGap = need;
    view = fitView(boardLayout(sections, 48, sectionGap), stage);
  }
  return { sectionGap, view };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The SVG path of a flow arrow between two artboards, routed so it doesn't cut through the board: forward along a row
 * goes right-edge to left-edge; back along a row arcs over the top; down to a later section goes bottom to top; up
 * to an earlier section loops around the board's left margin. `zoom` keeps the bends a constant size on screen.
 */
export function flowPath(from: Rect, to: Rect, zoom: number): string {
  const z = Math.max(0.05, zoom);
  const fc = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const tc = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const sameRow = Math.abs(fc.y - tc.y) < Math.min(from.height, to.height) / 2;
  if (sameRow && to.x >= from.x + from.width) {
    const a = { x: from.x + from.width, y: fc.y };
    const b = { x: to.x, y: tc.y };
    const k = Math.max(24 / z, (b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + k} ${a.y}, ${b.x - k} ${b.y}, ${b.x} ${b.y}`;
  }
  if (sameRow) {
    const lift = Math.min(from.y, to.y) - 96 / z;
    return `M ${fc.x} ${from.y} C ${fc.x} ${lift}, ${tc.x} ${lift}, ${tc.x} ${to.y}`;
  }
  if (to.y >= from.y + from.height) {
    const a = { x: fc.x, y: from.y + from.height };
    const b = { x: tc.x, y: to.y };
    const k = 64 / z;
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + k}, ${b.x} ${b.y - k}, ${b.x} ${b.y}`;
  }
  const left = Math.min(from.x, to.x) - 160 / z;
  return `M ${from.x} ${fc.y} C ${left} ${fc.y}, ${left} ${tc.y}, ${to.x} ${tc.y}`;
}
