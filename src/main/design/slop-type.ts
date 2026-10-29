/// <reference lib="dom" />

import type { LintFinding } from "./lint";

/** One text-bearing element's typography and line metrics. */
export interface TypeSlopNode {
  selector: string;
  tag: string;
  text: string;
  textLen: number;
  fontPx: number;
  lineHeightPx: number;
  letterSpacingPx: number;
  fontStyle: string;
  fontFamily: string;
  textAlign: string;
  textTransform: string;
  textWrap: string;
  rectX: number;
  rectY: number;
  rectWidth: number;
  rectHeight: number;
  radius: number;
  paintedBackground: boolean;
  hasBorder: boolean;
  insideFooter: boolean;
  insideNav: boolean;
  nextTag: string | null;
  prevTag: string | null;
  hasOwnText: boolean;
  visible: boolean;
  lineCount: number;
  lastWordAlone: boolean;
  /** Inside a slide (a `.slide` ancestor), where display type is meant to be huge. */
  inSlide?: boolean;
}

/** A plain-data snapshot of the page's typography for the type slop rules. */
export interface TypeSlopSnapshot {
  nodes: TypeSlopNode[];
  viewportHeight: number;
  /** The design system's `--text-display` in px, when it sets one (a style may set display type past 96px on purpose). */
  displayTokenPx?: number;
}

/** Snapshot text-bearing elements for the type slop rules; runs inside the page. */
export function collectTypeSlop(selectorFor: (el: Element) => string): TypeSlopSnapshot {
  const skipTags: Record<string, boolean> = {
    script: true,
    style: true,
    path: true,
    g: true,
    defs: true,
    use: true,
    circle: true,
    rect: true,
    line: true,
    polyline: true,
    polygon: true,
    ellipse: true,
  };
  const textTags: Record<string, boolean> = {
    h1: true,
    h2: true,
    h3: true,
    h4: true,
    h5: true,
    h6: true,
    p: true,
    li: true,
    a: true,
    button: true,
    label: true,
    input: true,
    select: true,
    span: true,
    small: true,
    blockquote: true,
  };

  /** True when a computed background-color paints something. */
  const painted = (value: string): boolean => {
    const text = value.trim().toLowerCase();
    if (!text || text === "transparent") return false;
    const fn = /^rgba?\(([^)]*)\)$/.exec(text);
    if (!fn) return true;
    const body = fn[1]!.trim();
    const parts = body.includes(",") ? body.split(",").map((p) => p.trim()) : body.split(/[\s/]+/).filter(Boolean);
    if (parts.length < 4) return true;
    const alpha = Number.parseFloat(parts[3]!);
    return !Number.isFinite(alpha) || alpha > 0;
  };

  const nodes: TypeSlopNode[] = [];
  const body = document.body;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const displayToken = /^\s*([\d.]+)px\s*$/.exec(getComputedStyle(document.documentElement).getPropertyValue("--text-display"));
  const displayTokenPx = displayToken ? Number.parseFloat(displayToken[1]!) : undefined;
  if (!body) return { nodes, viewportHeight, displayTokenPx };
  const elements = body.querySelectorAll("*");
  const limit = Math.min(elements.length, 3000);
  for (let i = 0; i < limit; i += 1) {
    const el = elements[i];
    if (!el) continue;
    const tag = el.tagName.toLowerCase();
    if (skipTags[tag]) continue;
    // An unresolved variant set: only the shown variant is on the page.
    if (el.closest("[data-cubiq-variant][hidden]")) continue;
    let hasOwnText = false;
    for (let j = 0; j < el.childNodes.length; j += 1) {
      const child = el.childNodes[j];
      if (child && child.nodeType === 3 && (child.textContent ?? "").trim() !== "") {
        hasOwnText = true;
        break;
      }
    }
    if (!textTags[tag] && !hasOwnText) continue;
    try {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const borderTop = Number.parseFloat(cs.getPropertyValue("border-top-width")) || 0;
      const borderRight = Number.parseFloat(cs.getPropertyValue("border-right-width")) || 0;
      const borderBottom = Number.parseFloat(cs.getPropertyValue("border-bottom-width")) || 0;
      const borderLeft = Number.parseFloat(cs.getPropertyValue("border-left-width")) || 0;
      const letterSpacing = cs.letterSpacing;
      const insideFooter = Boolean(el.closest("footer, small, figcaption, sup, sub"));
      let text = (el.textContent ?? "").trim();
      if ((tag === "input" || tag === "select") && text === "") {
        const field = el as HTMLInputElement;
        text = (field.value || el.getAttribute("placeholder") || "").trim();
      }
      const textLen = text.length;
      const stored = text.slice(0, 80);
      const textWrap =
        (cs as unknown as { textWrap?: string }).textWrap ||
        cs.getPropertyValue("text-wrap-style") ||
        cs.getPropertyValue("text-wrap") ||
        cs.getPropertyValue("-webkit-text-wrap") ||
        "";
      const next = el.nextElementSibling;
      const prev = el.previousElementSibling;
      const visible = cs.display !== "none" && cs.visibility !== "hidden" && rect.width > 0 && rect.height > 0;

      // Line boxes of the last text node, for headings and body paragraphs that might end on one word.
      let lineCount = 0;
      let lastWordAlone = false;
      // Headings only: a ragged last line in running text is normal.
      const headingRun = tag === "h1" || tag === "h2" || tag === "h3";
      const words = text.split(/\s+/).filter(Boolean);
      if (headingRun && words.length >= 4) {
        let lastText: Text | null = null;
        for (let j = el.childNodes.length - 1; j >= 0; j -= 1) {
          const child = el.childNodes[j];
          if (child && child.nodeType === 3 && (child.textContent ?? "").trim() !== "") {
            lastText = child as Text;
            break;
          }
        }
        if (lastText) {
          // Lines of the whole element: the last text node alone may be one word after an inline child.
          const range = document.createRange();
          range.selectNodeContents(el);
          const rects = range.getClientRects();
          // A line is every box whose vertical middle falls inside it (inline children with padding sit a little off).
          const lines: { top: number; bottom: number; left: number; right: number }[] = [];
          for (let j = 0; j < rects.length; j += 1) {
            const r = rects[j];
            if (!r || r.width < 1 || r.height < 1) continue;
            const mid = (r.top + r.bottom) / 2;
            let placed = false;
            for (const line of lines) {
              if (mid >= line.top && mid <= line.bottom) {
                line.left = Math.min(line.left, r.left);
                line.right = Math.max(line.right, r.right);
                placed = true;
                break;
              }
            }
            if (!placed) lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
          }
          lineCount = lines.length;
          if (lineCount >= 2) {
            let lastLine = lines[0]!;
            for (const line of lines) if (line.top > lastLine.top) lastLine = line;
            const raw = lastText.textContent ?? "";
            const match = /(\S+)\s*$/.exec(raw);
            if (match) {
              const word = match[1] ?? "";
              const start = match.index;
              const wordRange = document.createRange();
              wordRange.setStart(lastText, start);
              wordRange.setEnd(lastText, start + word.length);
              const wordRect = wordRange.getBoundingClientRect();
              // Alone: the word spans the whole last line.
              lastWordAlone = wordRect.left - lastLine.left <= 2 && lastLine.right - wordRect.right <= 2;
            }
          }
        }
      }

      nodes.push({
        selector: selectorFor(el),
        tag,
        text: stored,
        textLen,
        fontPx: Number.parseFloat(cs.fontSize) || 0,
        lineHeightPx: cs.lineHeight === "normal" ? 0 : Number.parseFloat(cs.lineHeight) || 0,
        letterSpacingPx: letterSpacing === "normal" ? 0 : Number.parseFloat(letterSpacing) || 0,
        fontStyle: cs.fontStyle || "normal",
        fontFamily: cs.fontFamily || "",
        textAlign: cs.textAlign || "",
        textTransform: cs.textTransform || "none",
        textWrap,
        rectX: rect.left,
        rectY: rect.top,
        rectWidth: rect.width,
        rectHeight: rect.height,
        radius: Number.parseFloat(cs.borderTopLeftRadius) || 0,
        paintedBackground: painted(cs.backgroundColor),
        hasBorder: borderTop >= 1 || borderRight >= 1 || borderBottom >= 1 || borderLeft >= 1,
        insideFooter,
        insideNav: Boolean(el.closest("nav")),
        nextTag: next ? next.tagName.toLowerCase() : null,
        prevTag: prev ? prev.tagName.toLowerCase() : null,
        hasOwnText,
        visible,
        lineCount,
        lastWordAlone,
        inSlide: Boolean(el.closest(".slide")),
      });
    } catch {
      // One element never aborts the snapshot.
    }
  }
  return { nodes, viewportHeight, displayTokenPx };
}

/** Turn collected type snapshots into slop findings; pure and self-contained. */
export function typeSlopFindings(s: TypeSlopSnapshot): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (id: string, selector: string, detail: string): void => {
    findings.push({ rule: "slop", id, selector, detail });
  };
  const nodes = s.nodes;
  const viewportHeight = s.viewportHeight;
  const quote = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 40);
  const fmt = (value: number): string => String(Math.round(value * 100) / 100);
  const isBody = (node: TypeSlopNode): boolean =>
    node.visible && (node.tag === "p" || node.tag === "li") && node.textLen >= 60 && !node.insideFooter;
  const bodyNodes = nodes.filter((node) => isBody(node));
  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };

  // Italic serif display: a slanted serif headline.
  const serifFirst = /garamond|playfair|fraunces|cormorant|baskerville|didot|bodoni|caslon|lora|newsreader|instrument serif|dm serif/i;
  const serifStack = (stack: string): boolean => {
    const lower = stack.toLowerCase();
    const first = (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (serifFirst.test(first)) return true;
    if (lower.includes("sans-serif")) return false;
    return lower.includes("serif");
  };
  let italicSerif = 0;
  for (const node of nodes) {
    if (italicSerif >= 1) break;
    if (!node.visible || node.textLen === 0) continue;
    if (node.tag !== "h1" && node.tag !== "h2" && !(node.fontPx >= 40 && node.hasOwnText)) continue;
    if (!node.fontStyle.includes("italic")) continue;
    if (!serifStack(node.fontFamily)) continue;
    italicSerif += 1;
    add("italic-serif-display", node.selector, "italic serif display headline: set the headline upright, keep italics for emphasis");
  }

  // Hero chip: a pill badge sitting above the h1.
  let heroChip = 0;
  for (const node of nodes) {
    if (heroChip >= 1) break;
    if (!node.visible) continue;
    if (node.radius < node.rectHeight / 2 - 1) continue;
    if (!node.paintedBackground && !node.hasBorder) continue;
    if (node.rectHeight > 40) continue;
    if (node.textLen < 1 || node.textLen > 40) continue;
    if (node.nextTag !== "h1") continue;
    heroChip += 1;
    add("hero-chip", node.selector, `badge "${quote(node.text)}" above the main headline: let the headline open the page`);
  }

  // Oversized headline: display type past 96px (or past the system's own display size) or 60% of the viewport; slides are exempt.
  const displayMax = Math.max(96, (s.displayTokenPx ?? 0) + 0.5);
  let oversized = 0;
  for (const node of nodes) {
    if (oversized >= 1) break;
    if (!node.visible || node.tag !== "h1" || node.inSlide) continue;
    const share = viewportHeight > 0 ? node.rectHeight / viewportHeight : 0;
    if (node.fontPx <= displayMax && share < 0.6) continue;
    oversized += 1;
    add("oversized-headline", node.selector, `${Math.round(node.fontPx)}px headline: keep display type at or under ${displayMax > 96.5 ? `the system's ${Math.round(displayMax)}px` : "6rem (96px)"}`);
  }

  // Crushed tracking: letter spacing tighter than -0.04em.
  let crushed = 0;
  for (const node of nodes) {
    if (crushed >= 3) break;
    if (!node.visible || !node.hasOwnText || node.fontPx < 16) continue;
    const ratio = node.letterSpacingPx / node.fontPx;
    if (ratio >= -0.04) continue;
    crushed += 1;
    add(
      "crushed-tracking",
      node.selector,
      `letter-spacing ${fmt(ratio)}em on "${quote(node.text)}": keep tracking at -0.04em or looser`,
    );
  }

  // Flat hierarchy: heading levels too close to body text.
  const headingSizes: Record<string, number[]> = { h1: [], h2: [], h3: [] };
  for (const node of nodes) {
    if (!node.visible || node.fontPx <= 0) continue;
    const bucket = headingSizes[node.tag];
    if (bucket) bucket.push(node.fontPx);
  }
  const bodySizes = bodyNodes.filter((node) => node.fontPx > 0).map((node) => node.fontPx);
  const bodyMedian = median(bodySizes);
  const medians: Record<string, number> = {};
  const levels: string[] = [];
  let largest = 0;
  for (const level of ["h1", "h2", "h3"]) {
    const sizes = headingSizes[level]!;
    if (sizes.length === 0) continue;
    const value = median(sizes);
    medians[level] = value;
    levels.push(level);
    if (value > largest) largest = value;
  }
  const h1Median = medians.h1;
  const h2Median = medians.h2;
  const h3Median = medians.h3;
  if (bodySizes.length > 0 && levels.length > 0) {
    const flatToBody = largest / bodyMedian < 1.25;
    const flatH1H2 = h1Median !== undefined && h2Median !== undefined && h1Median / h2Median < 1.15;
    const flatH2H3 = h2Median !== undefined && h3Median !== undefined && h2Median / h3Median < 1.1;
    if (flatToBody || flatH1H2 || flatH2H3) {
      const parts: string[] = [];
      for (const level of levels) parts.push(`${level} ${Math.round(medians[level]!)}px`);
      parts.push(`body ${Math.round(bodyMedian)}px`);
      add(
        "flat-hierarchy",
        "body",
        `headings barely step up (${parts.join(", ")}): make each level clearly larger`,
      );
    }
  }

  // Justified text: running text aligned to both edges.
  const justified = bodyNodes.filter((node) => node.textAlign === "justify");
  if (justified.length > 0) {
    add(
      "justified-text",
      justified[0]!.selector,
      `${justified.length} ${justified.length === 1 ? "paragraph" : "paragraphs"} justified: align running text to the left`,
    );
  }

  // Tight body leading: running text below 1.35 line-height.
  const leading = (node: TypeSlopNode): number => (node.lineHeightPx > 0 ? node.lineHeightPx / node.fontPx : 1.2);
  const tight: TypeSlopNode[] = [];
  for (const node of bodyNodes) {
    if (node.textLen < 120 || node.fontPx <= 0 || node.fontPx > 20) continue;
    if (leading(node) < 1.35) tight.push(node);
  }
  if (tight.length >= 2) {
    const shown = Math.min(tight.length, 3);
    for (let i = 0; i < shown; i += 1) {
      const node = tight[i]!;
      add(
        "tight-body-leading",
        node.selector,
        `body text at line-height ${fmt(leading(node))}: set running text at 1.4–1.6`,
      );
    }
  }

  // Tiny text: body copy under 14px or controls under 12px.
  const tinyBody = nodes.filter(
    (node) =>
      node.visible &&
      (node.tag === "p" || node.tag === "li") &&
      !node.insideFooter &&
      node.textLen >= 40 &&
      node.fontPx > 0 &&
      node.fontPx < 14,
  );
  const tinyControls = nodes.filter(
    (node) =>
      node.visible &&
      node.textLen > 0 &&
      node.fontPx > 0 &&
      node.fontPx < 12 &&
      (node.tag === "button" ||
        node.tag === "input" ||
        node.tag === "select" ||
        node.tag === "label" ||
        (node.tag === "a" && node.insideNav)),
  );
  let tiny = 0;
  if (tinyBody.length >= 2) {
    for (const node of tinyBody) {
      if (tiny >= 3) break;
      tiny += 1;
      add("tiny-text", node.selector, `${Math.round(node.fontPx)}px body text: set running text at 14px or more`);
    }
  }
  if (tinyControls.length >= 2) {
    for (const node of tinyControls) {
      if (tiny >= 3) break;
      tiny += 1;
      add("tiny-text", node.selector, `${Math.round(node.fontPx)}px control label: set controls at 12px or more`);
    }
  }

  // Wide-tracked body: running text spaced out like a label.
  let tracked = 0;
  for (const node of bodyNodes) {
    if (tracked >= 3) break;
    if (node.fontPx <= 0 || node.textTransform === "uppercase") continue;
    const ratio = node.letterSpacingPx / node.fontPx;
    if (ratio < 0.05) continue;
    tracked += 1;
    add(
      "wide-tracked-body",
      node.selector,
      `body text tracked at ${fmt(ratio)}em: leave running text at normal spacing`,
    );
  }

  // Skipped heading: a level more than one deeper than the last.
  let previousLevel = 0;
  let skipped = 0;
  for (const node of nodes) {
    if (skipped >= 2) break;
    if (!node.visible || !/^h[1-6]$/.test(node.tag)) continue;
    const level = Number.parseInt(node.tag.slice(1), 10) || 0;
    if (previousLevel > 0 && level > previousLevel + 1) {
      skipped += 1;
      add("skipped-heading", node.selector, `h${previousLevel} followed by h${level}: do not skip heading levels`);
    }
    previousLevel = level;
  }

  // Stub line: a heading ending on one word (the collector measures headings only).
  const headingStubs: TypeSlopNode[] = [];
  const bodyStubs: TypeSlopNode[] = [];
  for (const node of nodes) {
    if (!node.visible || node.lineCount < 2 || !node.lastWordAlone) continue;
    if (/balance|pretty/i.test(node.textWrap)) continue;
    if (node.tag === "h1" || node.tag === "h2" || node.tag === "h3") {
      headingStubs.push(node);
      continue;
    }
    if (isBody(node) && node.text.split(/\s+/).filter(Boolean).length >= 4) bodyStubs.push(node);
  }
  const stubs = headingStubs.concat(bodyStubs);
  const shownStubs = Math.min(stubs.length, 3);
  for (let i = 0; i < shownStubs; i += 1) {
    const node = stubs[i]!;
    const kind = node.tag === "h1" || node.tag === "h2" || node.tag === "h3" ? "heading" : "paragraph";
    add(
      "stub-line",
      node.selector,
      `"${quote(node.text)}" ${kind} ends on one word: rebalance the line (text-wrap: balance)`,
    );
  }

  return findings;
}
