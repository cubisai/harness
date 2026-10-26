/// <reference lib="dom" />

/** An sRGB color: channels 0-255, alpha 0-1. */
export type Rgba = { r: number; g: number; b: number; a: number };

/**
 * Parse a CSS color into channels; null when unrecognized. Supports
 * `rgb()/rgba()` (comma or space syntax), `#rgb/#rgba/#rrggbb/#rrggbbaa`, and
 * `transparent`. Self-contained: serialized into the page with `toString`.
 */
export function parseColor(s: string): Rgba | null {
  const text = s.trim().toLowerCase();
  if (!text) return null;
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const dup = (h: string): number => Number.parseInt(h + h, 16);
    const pair = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: dup(hex[0]!),
        g: dup(hex[1]!),
        b: dup(hex[2]!),
        a: hex.length === 4 ? dup(hex[3]!) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: pair(0),
        g: pair(2),
        b: pair(4),
        a: hex.length === 8 ? pair(6) / 255 : 1,
      };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(text);
  if (!fn) return null;
  const body = fn[1]!.trim();
  const parts = body.includes(",")
    ? body.split(",").map((p) => p.trim()).filter(Boolean)
    : body.split(/[\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (i: number): number => Number(parts[i]);
  const r = channel(0);
  const g = channel(1);
  const b = channel(2);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  let a = 1;
  if (parts.length >= 4) {
    a = Number(parts[3]);
    if (!Number.isFinite(a)) return null;
  }
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
}

/** Source-over compositing of `fg` onto `bg`; result alpha is fg.a + bg.a*(1-fg.a). */
export function blend(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (f: number, b: number): number => (fg.a * f + bg.a * b * (1 - fg.a)) / a;
  return { r: Math.round(mix(fg.r, bg.r)), g: Math.round(mix(fg.g, bg.g)), b: Math.round(mix(fg.b, bg.b)), a };
}

/** WCAG 2 contrast ratio between two colors (sRGB linearized, alpha ignored). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const lum = (c: Rgba): number => {
    const channel = (v: number): number => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The minimum contrast ratio for text at `fontPx`/`fontWeight` (WCAG large-text rules). */
export function minContrast(fontPx: number, fontWeight: number): number {
  return fontPx >= 24 || (fontPx >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
}

/** True when `px` is 0, 1, 2, or a multiple of 4; rounds to 2 decimals first. */
export function onGrid(px: number): boolean {
  const v = Math.abs(Math.round(px * 100) / 100);
  return v === 0 || v === 1 || v === 2 || v % 4 === 0;
}

/** Stable set-membership key for a color: `r,g,b,a` with alpha to 2 decimals. */
export function colorKey(c: Rgba): string {
  return `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.round(c.a * 100) / 100}`;
}

/** The lint rules the design lint runs. */
export type LintRule = "contrast" | "targets" | "spacing" | "color" | "slop";

/** One lint finding. */
export interface LintFinding {
  rule: LintRule;
  selector: string;
  detail: string;
}

/** The full result of a design lint run. */
export interface LintResult {
  findings: LintFinding[];
  skipped: string[];
  scanned: number;
}

/** A plain-data snapshot of one element for the slop rules. */
export interface SlopNode {
  selector: string;
  tag: string;
  text: string;
  nextTag: string | null;
  fontPx: number;
  textTransform: string;
  letterSpacingPx: number;
  fontFamily: string;
  backgroundImage: string;
  backgroundClip: string;
  borderPx: { top: number; right: number; bottom: number; left: number };
  boxShadow: string;
  cardLike: boolean;
  childSig: string;
  parentSelector: string | null;
  width: number;
  lineHeightPx?: number;
  textLen?: number;
  transitionProperty?: string;
  transitionDuration?: string;
  transitionTiming?: string;
  animationTiming?: string;
  filter?: string;
  backdropFilter?: string;
  position?: string;
  height?: number;
  radius?: number;
  placeholder?: string;
  labelled?: boolean;
  hasAlt?: boolean;
  ariaHidden?: boolean;
  /** Computed text-align. */
  textAlign?: string;
  /** A card-like box holding a big figure (own text a number, 24px or larger). */
  bigNumber?: boolean;
}

/** Snapshot every element for the slop rules; runs inside the page. */
export function collectSlop(selectorFor: (el: Element) => string): SlopNode[] {
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

  const nodes: SlopNode[] = [];
  const body = document.body;
  if (!body) return nodes;
  const elements = body.querySelectorAll("*");
  const limit = Math.min(elements.length, 3000);
  for (let i = 0; i < limit; i += 1) {
    const el = elements[i];
    if (!el) continue;
    const tag = el.tagName.toLowerCase();
    if (skipTags[tag]) continue;
    try {
      const cs = getComputedStyle(el);
      const borderPx = {
        top: Number.parseFloat(cs.getPropertyValue("border-top-width")) || 0,
        right: Number.parseFloat(cs.getPropertyValue("border-right-width")) || 0,
        bottom: Number.parseFloat(cs.getPropertyValue("border-bottom-width")) || 0,
        left: Number.parseFloat(cs.getPropertyValue("border-left-width")) || 0,
      };
      const fontFamily = (cs.fontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
      const letterSpacing = cs.letterSpacing;
      const descendants = el.querySelectorAll("*");
      const childTags: string[] = [];
      const childLimit = Math.min(descendants.length, 12);
      for (let j = 0; j < childLimit; j += 1) {
        const child = descendants[j];
        if (child) childTags.push(child.tagName.toLowerCase());
      }
      const next = el.nextElementSibling;
      const rect = el.getBoundingClientRect();
      const lineHeightPx = cs.lineHeight === "normal" ? 0 : Number.parseFloat(cs.lineHeight) || 0;
      const textLen = Math.min((el.textContent ?? "").trim().length, 2000);
      const cardish =
        painted(cs.backgroundColor) ||
        borderPx.top >= 1 ||
        borderPx.right >= 1 ||
        borderPx.bottom >= 1 ||
        borderPx.left >= 1 ||
        (cs.boxShadow !== "" && cs.boxShadow !== "none");
      let bigNumber: boolean | undefined;
      if (cardish) {
        const inner = el.querySelectorAll("*");
        const innerLimit = Math.min(inner.length, 40);
        for (let j = 0; j < innerLimit && !bigNumber; j += 1) {
          const d = inner[j];
          if (!d) continue;
          let own = "";
          for (const c of Array.from(d.childNodes)) if (c.nodeType === 3) own += c.textContent ?? "";
          own = own.trim();
          if (own && /^[+\-−$€£¥]?\s?\d[\d.,]*\s?(%|[kKmMbB])?$/.test(own) && (Number.parseFloat(getComputedStyle(d).fontSize) || 0) >= 24) bigNumber = true;
        }
      }
      const isField = tag === "input" || tag === "textarea" || tag === "select";
      let placeholder: string | undefined;
      let labelled: boolean | undefined;
      if (isField) {
        placeholder = el.getAttribute("placeholder") || "";
        const field = el as HTMLInputElement;
        labelled = Boolean(
          field.labels?.length ||
            el.getAttribute("aria-label") ||
            el.getAttribute("aria-labelledby") ||
            el.closest("label"),
        );
      }
      let hasAlt: boolean | undefined;
      let ariaHidden: boolean | undefined;
      if (tag === "img") {
        hasAlt = el.hasAttribute("alt");
        ariaHidden = el.getAttribute("aria-hidden") === "true" || el.getAttribute("role") === "presentation";
      }
      nodes.push({
        selector: selectorFor(el),
        tag,
        text: (el.textContent ?? "").trim().slice(0, 80),
        nextTag: next ? next.tagName.toLowerCase() : null,
        fontPx: Number.parseFloat(cs.fontSize) || 0,
        textTransform: cs.textTransform || "none",
        letterSpacingPx: letterSpacing === "normal" ? 0 : Number.parseFloat(letterSpacing) || 0,
        fontFamily,
        backgroundImage: cs.backgroundImage || "none",
        backgroundClip: cs.getPropertyValue("background-clip") || cs.getPropertyValue("-webkit-background-clip") || "border-box",
        borderPx,
        boxShadow: cs.boxShadow || "none",
        cardLike: cardish,
        childSig: childTags.join(","),
        parentSelector: el.parentElement ? selectorFor(el.parentElement) : null,
        width: Math.round(rect.width),
        lineHeightPx,
        textLen,
        transitionProperty: cs.transitionProperty || "",
        transitionDuration: cs.transitionDuration || "",
        transitionTiming: cs.transitionTimingFunction || "",
        animationTiming: cs.animationTimingFunction || "",
        filter: cs.filter || "",
        backdropFilter: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter") || "",
        position: cs.position || "",
        height: Math.round(rect.height),
        radius: Number.parseFloat(cs.borderTopLeftRadius) || 0,
        placeholder,
        labelled,
        hasAlt,
        ariaHidden,
        textAlign: cs.textAlign || "",
        bigNumber,
      });
    } catch {
      // One element never aborts the snapshot.
    }
  }
  return nodes;
}

/** A plain-data snapshot of page-wide layout and copy for the slop rules. */
export interface SlopPage {
  overflowPx: number;
  text: string;
  ctas: string[];
  /** Every distinct computed `font-family` stack that sets visible text. */
  fontStacks?: string[];
  /** The visible text outside code, pre, kbd and samp, where identifiers belong. */
  proseText?: string;
  /** Text a hidden-overflow box cuts off (deliberate ellipsis and line clamps excepted). */
  clipped?: { selector: string; text: string; px: number }[];
  /** Text drawn over other text (neither inside the other). */
  overlaps?: { selector: string; text: string; other: string }[];
}

/** Snapshot page overflow, body copy, visible calls to action and (given `selectorFor`) clipped or overlapping text; runs in the page. */
export function collectSlopPage(selectorFor?: (el: Element) => string): SlopPage {
  const overflowPx = Math.max(
    0,
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const text = (document.body ? document.body.innerText : "").slice(0, 8000);
  const ctas: string[] = [];
  const controls = document.querySelectorAll("button, a, [role=button]");
  const limit = Math.min(controls.length, 500);
  for (let i = 0; i < limit; i += 1) {
    const el = controls[i];
    if (!el) continue;
    const label = (el.textContent ?? "").trim();
    if (label.length < 1 || label.length > 40) continue;
    const rect = el.getBoundingClientRect();
    const visible = (rect.width > 0 && rect.height > 0) || (el as HTMLElement).offsetParent !== null;
    if (!visible) continue;
    ctas.push(label);
    if (ctas.length >= 80) break;
  }
  const stacks: Record<string, boolean> = {};
  const fontStacks: string[] = [];
  let proseText = "";
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), seen = 0; n && seen < 4000; n = walker.nextNode(), seen += 1) {
      const value = (n.nodeValue ?? "").trim();
      const parent = n.parentElement;
      if (!value || !parent || parent.closest("script, style, noscript, template")) continue;
      const stack = getComputedStyle(parent).fontFamily;
      if (stack && !stacks[stack] && fontStacks.length < 20) {
        stacks[stack] = true;
        fontStacks.push(stack);
      }
      if (proseText.length < 8000 && !parent.closest("code, pre, kbd, samp")) proseText += `${value} `;
    }
  }
  // Text fit: each visible text node's line boxes, checked against the nearest hidden-overflow box and against other text.
  const clipped: { selector: string; text: string; px: number }[] = [];
  const overlaps: { selector: string; text: string; other: string }[] = [];
  if (selectorFor && document.body) {
    const leaves: { el: Element; lines: DOMRect[]; text: string; pinned: Element | null }[] = [];
    const taken = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), seen = 0; n && seen < 4000 && leaves.length < 400; n = walker.nextNode(), seen += 1) {
      const value = (n.nodeValue ?? "").trim();
      const parent = n.parentElement;
      if (value.length < 2 || !parent || taken.has(parent)) continue;
      if (parent.closest("script, style, noscript, template, svg, [aria-hidden=true]")) continue;
      taken.add(parent);
      const cs = getComputedStyle(parent);
      const alpha = /rgba?\([^)]*[,/]\s*([\d.]+)\s*\)/.exec(cs.color);
      if (cs.visibility !== "visible" || Number(cs.opacity) < 0.5 || (alpha && Number(alpha[1]) < 0.5)) continue;
      // Inside a closed <details>, a hidden or faded ancestor: not on screen at all.
      const check = (parent as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility;
      if (check && !check.call(parent, { opacityProperty: true, visibilityProperty: true })) continue;
      // Icon-font ligatures ("arrow_forward") are glyphs, not text.
      if (/icons|symbols/i.test(cs.fontFamily)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const lines = Array.prototype.slice.call(range.getClientRects(), 0, 6).filter((r: DOMRect) => r.width >= 1 && r.height >= 1) as DOMRect[];
      if (!lines.length) continue;
      const text = value.replace(/\s+/g, " ").slice(0, 40);
      // The fixed or sticky bar it sits in (page content scrolls under a bar by design), and the part of
      // its lines that every scrolling or clipping box around it leaves in view.
      let pinned: Element | null = null;
      let faded = false;
      let view = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
      for (let a: Element | null = parent.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const as = getComputedStyle(a);
        if (Number(as.opacity) < 0.5) faded = true;
        if (!pinned && (as.position === "fixed" || as.position === "sticky")) pinned = a;
        if (as.overflowX !== "visible" || as.overflowY !== "visible") {
          const r = a.getBoundingClientRect();
          view = { left: Math.max(view.left, r.left), top: Math.max(view.top, r.top), right: Math.min(view.right, r.right), bottom: Math.min(view.bottom, r.bottom) };
        }
      }
      if (!pinned && (cs.position === "fixed" || cs.position === "sticky")) pinned = parent;
      // Each line's ink band (the font box less its ascent and descent room), as far as it is in view.
      const shown: DOMRect[] = [];
      for (const r of faded ? [] : lines) {
        const left = Math.max(r.left, view.left);
        const top = Math.max(r.top + r.height * 0.25, view.top);
        const right = Math.min(r.right, view.right);
        const bottom = Math.min(r.bottom - r.height * 0.2, view.bottom);
        if (right - left >= 1 && bottom - top >= 1) shown.push(new DOMRect(left, top, right - left, bottom - top));
      }
      if (shown.length) leaves.push({ el: parent, lines: shown, text, pinned });
      if (clipped.length >= 8) continue;
      const rect = range.getBoundingClientRect();
      for (let a: Element | null = parent; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        const cx = s.overflowX === "hidden" || s.overflowX === "clip";
        const cy = s.overflowY === "hidden" || s.overflowY === "clip";
        if (!cx && !cy) continue;
        // An ellipsis or a line clamp is a deliberate cut.
        const clamp = (s as unknown as { webkitLineClamp?: string }).webkitLineClamp;
        if (s.textOverflow === "ellipsis" || (clamp && clamp !== "none")) break;
        const box = a.getBoundingClientRect();
        // Screen-reader-only text and collapsed panels are meant to be out of sight.
        if (box.width < 16 || box.height < 8) break;
        const inside = Math.min(rect.right, box.right) - Math.max(rect.left, box.left) > 0 && Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top) > 0;
        const px = Math.round(Math.max(cx ? box.left - rect.left : 0, cx ? rect.right - box.right : 0, cy ? box.top - rect.top : 0, cy ? rect.bottom - box.bottom : 0));
        // Only text the box shows in part: wholly hidden text is a closed menu or an off-screen slide.
        if (inside && px > 4) clipped.push({ selector: selectorFor(parent), text, px });
        break;
      }
    }
    for (let i = 0; i < leaves.length && overlaps.length < 8; i += 1) {
      const a = leaves[i]!;
      for (let j = i + 1; j < leaves.length; j += 1) {
        const b = leaves[j]!;
        if (a.el.contains(b.el) || b.el.contains(a.el) || a.pinned !== b.pinned) continue;
        let hit = false;
        for (const ra of a.lines) {
          for (const rb of b.lines) {
            const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            // Ink over ink, not tightly stacked lines whose font boxes touch.
            if (w > 4 && h > 1) hit = true;
          }
        }
        if (hit) {
          overlaps.push({ selector: selectorFor(b.el), text: b.text, other: a.text });
          break;
        }
      }
    }
  }
  return { overflowPx, text, ctas, fontStacks, proseText, clipped, overlaps };
}

/** Turn collected element snapshots into slop findings; pure and self-contained. */
export function slopFindings(nodes: SlopNode[], page?: SlopPage): LintFinding[] {
  const findings: LintFinding[] = [];
  const push = (selector: string, detail: string): void => {
    findings.push({ rule: "slop", selector, detail });
  };

  const headingTags: Record<string, boolean> = { h1: true, h2: true, h3: true };
  const hasHeading = (sig: string): boolean => {
    for (const tag of sig.split(",")) {
      if (tag === "h2" || tag === "h3" || tag === "h4") return true;
    }
    return false;
  };
  const overused = [
    "inter",
    "roboto",
    "poppins",
    "montserrat",
    "open sans",
    "lato",
    "playfair display",
    "fraunces",
    "cormorant",
    "cormorant garamond",
    "lora",
    "newsreader",
    "space grotesk",
    "space mono",
    "syne",
    "dm sans",
    "dm serif display",
    "outfit",
    "plus jakarta sans",
    "instrument sans",
    "ibm plex sans",
    "ibm plex mono",
  ];

  // Eyebrow: a small uppercase or widely tracked label directly above a heading.
  for (const node of nodes) {
    const tracked = node.fontPx > 0 && node.letterSpacingPx / node.fontPx >= 0.06;
    if (
      node.text.length >= 1 &&
      node.text.length <= 40 &&
      node.fontPx <= 14 &&
      (node.textTransform === "uppercase" || tracked) &&
      node.nextTag !== null &&
      headingTags[node.nextTag]
    ) {
      push(node.selector, `eyebrow label "${node.text}" above a heading`);
    }
  }

  // Gradient text: a gradient clipped to the glyphs.
  for (const node of nodes) {
    if (node.backgroundClip.includes("text") && node.backgroundImage.includes("gradient")) {
      push(node.selector, "gradient text");
    }
  }

  // Side stripe: one heavy left or right border, the other sides hairline.
  for (const node of nodes) {
    if (node.tag === "blockquote") continue;
    const b = node.borderPx;
    const left = b.left > 1;
    const right = b.right > 1;
    if (left === right) continue;
    const others = left ? [b.top, b.right, b.bottom] : [b.top, b.bottom, b.left];
    if (others.every((v) => v <= 1)) push(node.selector, `${left ? b.left : b.right}px side stripe on one edge`);
  }

  // Hard offset shadow: a non-inset shadow layer with zero blur.
  const shadowLayers = (value: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(value.slice(start).trim());
    return parts;
  };
  for (const node of nodes) {
    if (!node.boxShadow || node.boxShadow === "none") continue;
    for (const layer of shadowLayers(node.boxShadow)) {
      if (!layer || /\binset\b/.test(layer)) continue;
      const nums = (layer.match(/-?\d+(?:\.\d+)?px/g) ?? []).map((v) => Number.parseFloat(v));
      const x = nums[0] ?? 0;
      const y = nums[1] ?? 0;
      const blur = nums[2] ?? 0;
      if (blur === 0 && (x !== 0 || y !== 0)) {
        push(node.selector, "hard offset shadow (no blur)");
        break;
      }
    }
  }

  // Identical cards: three or more same-structure, same-width card children.
  const byParent: Record<string, SlopNode[]> = {};
  for (const node of nodes) {
    const parent = node.parentSelector;
    if (parent === null || !node.cardLike || !hasHeading(node.childSig)) continue;
    (byParent[parent] ??= []).push(node);
  }
  for (const parent of Object.keys(byParent)) {
    const group = byParent[parent]!;
    if (group.length < 3) continue;
    const bySig: Record<string, SlopNode[]> = {};
    for (const node of group) {
      (bySig[node.childSig] ??= []).push(node);
    }
    for (const sig of Object.keys(bySig)) {
      const same = bySig[sig]!;
      if (same.length < 3) continue;
      let min = same[0]!.width;
      let max = same[0]!.width;
      for (const node of same) {
        if (node.width < min) min = node.width;
        if (node.width > max) max = node.width;
      }
      if (max - min > 2) continue;
      push(parent, `${same.length} identical cards (${sig})`);
      break;
    }
  }

  // Metric row: three to five equal cards that each lead with a big figure. Slides and panels are bigger than a card.
  const metricsByParent: Record<string, SlopNode[]> = {};
  for (const node of nodes) {
    if (node.parentSelector === null || !node.cardLike || node.bigNumber !== true) continue;
    // Hidden boxes (an inactive slide) measure 0 and would all look equal.
    if (node.width < 80 || node.width > 480 || (node.height ?? 0) < 40 || (node.height ?? 0) > 320) continue;
    (metricsByParent[node.parentSelector] ??= []).push(node);
  }
  let metricRows = 0;
  for (const parent of Object.keys(metricsByParent)) {
    const row = metricsByParent[parent]!;
    if (row.length < 3 || row.length > 5) continue;
    let min = row[0]!.width;
    let max = row[0]!.width;
    for (const node of row) {
      if (node.width < min) min = node.width;
      if (node.width > max) max = node.width;
    }
    if (max - min > 4) continue;
    push(parent, `${row.length} equal metric cards in a row: lead with the number that matters, put the rest in a table or a sentence`);
    metricRows += 1;
    if (metricRows >= 2) break;
  }

  // Index labels: zero-padded section numbers as decoration ("01 / WORK", "[ 00 / OVERVIEW ]", "02 · TENANCY").
  const indexLabels = nodes.filter(
    (node) => node.fontPx > 0 && node.fontPx <= 14 && node.text.length <= 40 && /^\[?\s*0\d\s*[\/·.|—–-]\s*[A-Za-zÀ-ɏ]/.test(node.text),
  );
  const indexParents: Record<string, boolean> = {};
  for (const node of indexLabels) if (node.parentSelector) indexParents[node.parentSelector] = true;
  const innermostIndex = indexLabels.filter((node) => !indexParents[node.selector]);
  if (innermostIndex.length >= 2) {
    push(
      innermostIndex[0]!.selector,
      `${innermostIndex.length} index labels as decoration ("${innermostIndex[0]!.text}", "${innermostIndex[1]!.text}"): let the heading name the section`,
    );
  }

  // Centred running text: most paragraphs centred.
  const paragraphs = nodes.filter((node) => (node.tag === "p" || node.tag === "li") && (node.textLen ?? node.text.length) >= 60);
  const centred = paragraphs.filter((node) => node.textAlign === "center" || node.textAlign === "-webkit-center").length;
  if (paragraphs.length >= 5 && centred / paragraphs.length >= 0.7) {
    push("body", `${centred} of ${paragraphs.length} paragraphs centred: align running text to the left, centre only short headlines`);
  }

  // Emoji icon: a glyph (or two) used as the only content.
  const emoji = /^(\p{Extended_Pictographic}️?){1,2}$/u;
  for (const node of nodes) {
    if (emoji.test(node.text)) push(node.selector, "emoji used as an icon");
  }

  // Overused display font: headings set in a default-looking face.
  const seenFonts: Record<string, boolean> = {};
  for (const node of nodes) {
    if (node.tag !== "h1" && node.tag !== "h2") continue;
    const family = node.fontFamily.trim().toLowerCase();
    if (overused.indexOf(family) === -1) continue;
    if (seenFonts[family]) continue;
    seenFonts[family] = true;
    push(node.selector, `"${node.fontFamily}" display face is an overused default`);
  }

  // Display leading: hero type set with paragraph leading.
  let displayLeading = 0;
  for (const node of nodes) {
    if (displayLeading >= 3) break;
    // Text elements only: a wrapper inherits the size of the heading inside it.
    if (!/^(h[1-6]|p|span|a|blockquote|strong|em)$/.test(node.tag)) continue;
    if (node.fontPx < 28 || node.text.length === 0) continue;
    const lineHeight = node.lineHeightPx ?? 0;
    if (lineHeight <= 0) continue;
    const ratio = lineHeight / node.fontPx;
    if (ratio < 1.45) continue;
    displayLeading += 1;
    push(
      node.selector,
      `${Math.round(node.fontPx)}px heading at line-height ${ratio.toFixed(2)}: set display type at 1.0–1.2`,
    );
  }

  // Long measure: prose so wide its lines run past a readable character count.
  const longMeasure: SlopNode[] = [];
  for (const node of nodes) {
    if (node.tag !== "p" && node.tag !== "li") continue;
    if (node.fontPx <= 0 || (node.textLen ?? 0) < 160) continue;
    if (node.width / (node.fontPx * 0.5) <= 90) continue;
    longMeasure.push(node);
  }
  if (longMeasure.length >= 2) {
    const shown = Math.min(longMeasure.length, 3);
    for (let i = 0; i < shown; i += 1) {
      const node = longMeasure[i]!;
      const chars = Math.round(node.width / (node.fontPx * 0.5));
      push(node.selector, `paragraph runs about ${chars} characters a line: cap prose at 65–75ch`);
    }
  }

  // Transition all: controls that animate every property.
  const interactiveTags: Record<string, boolean> = {
    a: true,
    button: true,
    input: true,
    select: true,
    textarea: true,
    summary: true,
  };
  let interactive = 0;
  let transitionAll = 0;
  for (const node of nodes) {
    if (!interactiveTags[node.tag]) continue;
    interactive += 1;
    // Every element computes "all" with a 0s duration by default: only a timed "all" counts.
    const props = (node.transitionProperty ?? "").split(",");
    const durations = (node.transitionDuration ?? "").split(",");
    for (let i = 0; i < props.length; i += 1) {
      const duration = Number.parseFloat(durations[i % Math.max(durations.length, 1)] ?? "") || 0;
      if (props[i]!.trim() === "all" && duration > 0) {
        transitionAll += 1;
        break;
      }
    }
  }
  if (interactive >= 8 && transitionAll / interactive >= 0.6) {
    push(
      "body",
      `transition: all on ${transitionAll} of ${interactive} controls: transition named properties (transform, opacity, color)`,
    );
  }

  // Overshoot easing: a cubic-bezier whose control point leaves 0–1.
  const cubic = /cubic-bezier\(([^)]*)\)/g;
  const overshootSeen: Record<string, boolean> = {};
  let overshootCount = 0;
  for (const node of nodes) {
    if (overshootCount >= 2) break;
    const timings = [node.transitionTiming ?? "", node.animationTiming ?? ""];
    for (const timing of timings) {
      cubic.lastIndex = 0;
      let match = cubic.exec(timing);
      while (match) {
        const nums = (match[1] ?? "").split(",").map((v) => Number.parseFloat(v.trim()));
        const y1 = nums[1];
        const y2 = nums[3];
        if (y1 !== undefined && y2 !== undefined && (y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1)) {
          const value = match[0] ?? "";
          if (!overshootSeen[value]) {
            overshootSeen[value] = true;
            overshootCount += 1;
            push(node.selector, `overshooting easing ${value}: use an ease-out without bounce`);
            if (overshootCount >= 2) break;
          }
        }
        match = cubic.exec(timing);
      }
      if (overshootCount >= 2) break;
    }
  }

  // Coloured glow: a large, saturated, non-inset shadow.
  const glowNodes: SlopNode[] = [];
  for (const node of nodes) {
    if (!node.boxShadow || node.boxShadow === "none") continue;
    let glow = false;
    for (const layer of shadowLayers(node.boxShadow)) {
      if (!layer || /\binset\b/.test(layer)) continue;
      const colour = /rgba?\(([^)]*)\)/.exec(layer);
      if (!colour) continue;
      const body = (colour[1] ?? "").trim();
      const parts = body.includes(",")
        ? body.split(",").map((p) => p.trim())
        : body.split(/[\s/]+/).filter(Boolean);
      const r = Number.parseFloat(parts[0] ?? "") / 255;
      const g = Number.parseFloat(parts[1] ?? "") / 255;
      const b = Number.parseFloat(parts[2] ?? "") / 255;
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      const alpha = parts.length >= 4 ? Number.parseFloat(parts[3] ?? "") : 1;
      if (!Number.isFinite(alpha)) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const denom = 1 - Math.abs(max + min - 1);
      const saturation = max === min || denom === 0 ? 0 : (max - min) / denom;
      const lengths = (layer.match(/-?\d+(?:\.\d+)?px/g) ?? []).map((v) => Number.parseFloat(v));
      const blur = lengths[2] ?? 0;
      if (alpha > 0.2 && saturation > 0.4 && blur >= 24) {
        glow = true;
        break;
      }
    }
    if (glow) glowNodes.push(node);
  }
  if (glowNodes.length >= 2) {
    const shown = Math.min(glowNodes.length, 3);
    for (let i = 0; i < shown; i += 1) {
      push(glowNodes[i]!.selector, "coloured glow shadow: use one neutral elevation or surface tone");
    }
  }

  // Blurred blob: a big blurred decorative layer.
  let blobs = 0;
  for (const node of nodes) {
    if (blobs >= 2) break;
    const position = node.position ?? "";
    if (position !== "absolute" && position !== "fixed") continue;
    if (node.width < 300 || (node.height ?? 0) < 300) continue;
    const blur = /blur\(\s*(-?\d+(?:\.\d+)?)px\s*\)/.exec(node.filter ?? "");
    if (!blur) continue;
    if ((Number.parseFloat(blur[1] ?? "") || 0) < 40) continue;
    blobs += 1;
    push(node.selector, "blurred decorative blob: show the product instead");
  }

  // Glass content panel: frosted backdrop over real content.
  const panelTags: Record<string, boolean> = { header: true, nav: true, dialog: true, menu: true };
  let glassed = 0;
  for (const node of nodes) {
    if (glassed >= 2) break;
    if (!(node.backdropFilter ?? "").includes("blur(")) continue;
    if (panelTags[node.tag] || !node.cardLike) continue;
    if ((node.textLen ?? 0) < 40) continue;
    glassed += 1;
    push(node.selector, "frosted glass panel holding content: give it a solid surface");
  }

  // One radius everywhere: a single corner value across every shape.
  const radiusCounts: Record<string, number> = {};
  const radiusCandidates: SlopNode[] = [];
  for (const node of nodes) {
    if ((node.radius ?? 0) <= 0) continue;
    const control =
      node.tag === "button" ||
      node.tag === "input" ||
      node.tag === "select" ||
      node.tag === "textarea" ||
      node.tag === "img";
    if (!control && !(node.cardLike && node.width >= 200)) continue;
    radiusCandidates.push(node);
    const key = String(Math.round(node.radius ?? 0));
    radiusCounts[key] = (radiusCounts[key] ?? 0) + 1;
  }
  if (radiusCandidates.length >= 10) {
    let commonRadius = 0;
    let commonCount = 0;
    for (const key of Object.keys(radiusCounts)) {
      const count = radiusCounts[key]!;
      if (count > commonCount) {
        commonCount = count;
        commonRadius = Number.parseInt(key, 10);
      }
    }
    let narrowest = radiusCandidates[0]!.width;
    let widest = radiusCandidates[0]!.width;
    for (const node of radiusCandidates) {
      if (node.width < narrowest) narrowest = node.width;
      if (node.width > widest) widest = node.width;
    }
    // A sharp style (0–2px everywhere) is a decision, not a habit.
    if (commonRadius > 2 && commonCount / radiusCandidates.length >= 0.8 && widest > narrowest * 3) {
      push(
        "body",
        `one ${commonRadius}px radius on ${commonCount} of ${radiusCandidates.length} shapes: set radius by role (controls smaller, cards larger, media 0)`,
      );
    }
  }

  // Placeholder-only field: a control whose only label is its placeholder.
  let placeholderOnly = 0;
  for (const node of nodes) {
    if (placeholderOnly >= 4) break;
    if (node.tag !== "input" && node.tag !== "textarea" && node.tag !== "select") continue;
    if (node.labelled !== false) continue;
    const placeholder = node.placeholder ?? "";
    if (!placeholder) continue;
    placeholderOnly += 1;
    push(node.selector, `field labelled only by its placeholder "${placeholder}"`);
  }

  // Missing alt: an exposed image with no alt text.
  let missingAlt = 0;
  for (const node of nodes) {
    if (missingAlt >= 4) break;
    if (node.tag !== "img" || node.hasAlt !== false || node.ariaHidden === true) continue;
    missingAlt += 1;
    push(node.selector, "image without alt text");
  }

  // Running text in capitals: a sentence or more set uppercase (by CSS or typed that way) reads slowly. Short labels
  // and display headlines are fine; only the innermost block with inline-only children is reported.
  const inlineTags: Record<string, boolean> = { a: true, b: true, strong: true, em: true, i: true, span: true, br: true, small: true, code: true };
  const capsBlocks = nodes.filter((node) => {
    if (node.fontPx >= 32 || (node.textLen ?? node.text.length) < 60) return false;
    if (node.childSig && node.childSig.split(",").some((t) => !inlineTags[t])) return false;
    if (node.text.split(/\s+/).length < 8) return false;
    // Child elements without sentence punctuation are a row of labels, not running text.
    if (node.childSig && !/[.!?,;:]\s/.test(node.text)) return false;
    if (node.textTransform === "uppercase") return true;
    const letters = node.text.match(/[A-Za-z]/g) ?? [];
    const upper = node.text.match(/[A-Z]/g) ?? [];
    return letters.length >= 40 && upper.length / letters.length >= 0.9;
  });
  const capsParents: Record<string, boolean> = {};
  for (const node of capsBlocks) if (node.parentSelector) capsParents[node.parentSelector] = true;
  let capsCount = 0;
  for (const node of capsBlocks) {
    if (capsParents[node.selector]) continue;
    capsCount += 1;
    if (capsCount > 3) break;
    push(node.selector, `running text in capitals ("${node.text.slice(0, 40)}…"): set sentences in sentence case, keep caps for short labels`);
  }

  if (page) {
    if (page.overflowPx > 1) {
      push("html", `page scrolls sideways by ${page.overflowPx}px at this width`);
    }

    // Text cut off by its box, or drawn over other text: titles under bars, clipped chips, colliding labels.
    for (const c of page.clipped ?? []) {
      push(c.selector, `text "${c.text}" is cut off by its box (${c.px}px hidden): let it wrap, shorten it, or make the row scroll`);
    }
    for (const o of page.overlaps ?? []) {
      push(o.selector, `text "${o.text}" overlaps "${o.other}": give each its own space`);
    }

    // Copy clichés: stock marketing language.
    const cliches: RegExp[] = [
      /\b(supercharge|unlock|empower|streamline|revolutioni[sz]e)\b/i,
      /\bseamless(ly)?\b/i,
      /\b(all[- ]in[- ]one)\b/i,
      /\bnext[- ]gen(eration)?\b/i,
      /\bAI[- ](powered|driven|native)\b/i,
      /\b(build|shape) the future\b/i,
      /\bgame[- ]chang(er|ing)\b/i,
    ];
    const matchedCopy: string[] = [];
    for (const cliche of cliches) {
      const match = cliche.exec(page.text);
      if (match) matchedCopy.push(match[0] ?? "");
    }
    if (matchedCopy.length >= 2) {
      push(
        "body",
        `generic copy (${matchedCopy.join(", ")}): name the audience, the task and a concrete outcome`,
      );
    }

    // Generic calls to action: interchangeable button labels.
    const genericCtas: Record<string, boolean> = {
      "get started": true,
      "learn more": true,
      "try it free": true,
      "try for free": true,
      "start for free": true,
      "book a demo": true,
      "request a demo": true,
      "sign up": true,
      "contact sales": true,
      "click here": true,
    };
    let genericCount = 0;
    const examples: string[] = [];
    for (const cta of page.ctas) {
      const label = cta.trim().toLowerCase();
      if (!genericCtas[label]) continue;
      genericCount += 1;
      if (examples.indexOf(label) === -1) examples.push(label);
    }
    if (genericCount >= 3) {
      push(
        "body",
        `${genericCount} generic calls to action ("${examples.slice(0, 3).join(", ")}"): name what each one does`,
      );
    }

    // Placeholder copy: lorem ipsum and stand-in names.
    const placeholderCopy =
      /lorem ipsum|\bjohn doe\b|\bjane doe\b|\bacme\b|\bfeature (one|two|three|[1-9])\b|\byour company\b|\bcompany name\b/i.exec(
        page.text,
      );
    if (placeholderCopy) {
      push("body", `placeholder copy "${placeholderCopy[0] ?? ""}": use real, specific names and content`);
    }

    // A font stack with no generic family: while the web font loads (or if it fails) text drops to the browser's
    // default serif. Icon fonts are exempt: a fallback face would only show the ligature names.
    const generics: Record<string, boolean> = {
      serif: true,
      "sans-serif": true,
      monospace: true,
      cursive: true,
      fantasy: true,
      "system-ui": true,
      "ui-serif": true,
      "ui-sans-serif": true,
      "ui-monospace": true,
      "ui-rounded": true,
      math: true,
      emoji: true,
      fangsong: true,
      "-apple-system": true,
      blinkmacsystemfont: true,
    };
    let stackCount = 0;
    for (const stack of page.fontStacks ?? []) {
      const families = stack.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase());
      if (families.some((f) => generics[f]) || /icon|symbol|awesome/.test(families[0] ?? "")) continue;
      stackCount += 1;
      if (stackCount > 3) break;
      push("body", `font stack "${stack}" has no generic fallback: end it with sans-serif, serif or monospace`);
    }

    // Pseudo-data: system-looking filler (SCREAMING_SNAKE ids, null hashes) in prose, where it means nothing to the
    // reader. Code blocks are left out, so docs pages can show real identifiers.
    const pseudo = (page.proseText ?? "").match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b|\b0[xX]0{4,}\b|\bNULL\b/g) ?? [];
    const pseudoSeen: string[] = [];
    for (const hit of pseudo) if (pseudoSeen.indexOf(hit) === -1) pseudoSeen.push(hit);
    if (pseudoSeen.length >= 2) {
      push("body", `pseudo-data in copy (${pseudoSeen.slice(0, 3).join(", ")}): every label and meta line should state a real fact`);
    }
  }

  return findings;
}

/**
 * Lint a design page: contrast, tap targets, 4px spacing, color tokens, and
 * the slop rules for generic AI design tells. Runs inside the page (serialized
 * with `toString`), so it uses only its parameters and DOM globals; the color
 * helpers are passed in as `h`.
 */
export function designLint(
  selectorFor: (el: Element) => string,
  h: {
    parseColor: typeof parseColor;
    blend: typeof blend;
    contrastRatio: typeof contrastRatio;
    minContrast: typeof minContrast;
    onGrid: typeof onGrid;
    colorKey: typeof colorKey;
    collectSlop: typeof collectSlop;
    collectSlopPage: typeof collectSlopPage;
    slopFindings: typeof slopFindings;
  },
): LintResult {
  const findings: LintFinding[] = [];
  const skipped: string[] = [];
  const root = document.body;
  if (!root) return { findings, skipped, scanned: 0 };

  const skipTags: Record<string, boolean> = {
    SCRIPT: true,
    STYLE: true,
    TEMPLATE: true,
    HEAD: true,
    META: true,
    LINK: true,
    NOSCRIPT: true,
  };
  const targetSelector =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [tabindex]:not([tabindex="-1"])';
  const spacingProps = [
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "margin-block",
    "margin-block-start",
    "margin-block-end",
    "margin-inline",
    "margin-inline-start",
    "margin-inline-end",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "padding-block",
    "padding-block-start",
    "padding-block-end",
    "padding-inline",
    "padding-inline-start",
    "padding-inline-end",
    "gap",
    "row-gap",
    "column-gap",
  ];

  /** `#rrggbb`, lowercased. */
  const hex = (c: Rgba): string => {
    const part = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${part(c.r)}${part(c.g)}${part(c.b)}`;
  };

  /** True when `el` has a direct non-whitespace text child. */
  const hasText = (el: Element): boolean => {
    for (let i = 0; i < el.childNodes.length; i += 1) {
      const node = el.childNodes[i];
      if (node && node.nodeType === 3 && (node.textContent ?? "").trim() !== "") return true;
    }
    return false;
  };

  /** Visit every CSSStyleRule in the document, recursing into grouping rules. */
  const eachStyleRule = (cb: (style: CSSStyleDeclaration, selector: string) => void): void => {
    const visit = (list: CSSRuleList): void => {
      for (let i = 0; i < list.length; i += 1) {
        const rule = list[i];
        if (!rule) continue;
        const shape = rule as unknown as { style?: CSSStyleDeclaration; selectorText?: string; cssRules?: CSSRuleList };
        if (shape.style && typeof shape.selectorText === "string") {
          try {
            cb(shape.style, shape.selectorText);
          } catch {
            // A rule we cannot inspect is skipped.
          }
        }
        let nested: CSSRuleList | null = null;
        try {
          nested = shape.cssRules ?? null;
        } catch {
          nested = null;
        }
        if (nested && nested.length > 0) visit(nested);
      }
    };
    for (let i = 0; i < document.styleSheets.length; i += 1) {
      const sheet = document.styleSheets[i];
      if (!sheet) continue;
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        rules = null;
      }
      if (rules) visit(rules);
    }
  };

  // Declared spacing, from stylesheet rules and inline styles (never computed).
  const spacingSeen = new Set<string>();
  const checkSpacing = (value: string, selector: string, property: string): void => {
    if (/var\(|calc\(|clamp\(|min\(|max\(|%/.test(value)) return;
    for (const token of value.trim().split(/\s+/)) {
      if (!/^-?[\d.]+(px|rem|em)?$/.test(token)) continue;
      const unit = /(px|rem|em)$/.exec(token);
      let px: number;
      if (!unit) {
        if (Number.parseFloat(token) !== 0) continue;
        px = 0;
      } else if (unit[1] === "rem") {
        px = Number.parseFloat(token) * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      } else if (unit[1] === "em") {
        px = Number.parseFloat(token) * 16;
      } else {
        px = Number.parseFloat(token);
      }
      if (!Number.isFinite(px) || h.onGrid(px)) continue;
      const key = `${selector}|${property}`;
      if (spacingSeen.has(key)) continue;
      spacingSeen.add(key);
      findings.push({ rule: "spacing", selector, detail: `${property}: ${token} (not on the 4px grid)` });
    }
  };
  const checkDeclared = (style: CSSStyleDeclaration, selector: string): void => {
    for (const property of spacingProps) {
      const value = style.getPropertyValue(property);
      if (value) checkSpacing(value, selector, property);
    }
  };

  // Color tokens: `--color-*` names, resolved once through a hidden probe.
  const tokenNames = new Set<string>();
  eachStyleRule((style) => {
    for (let i = 0; i < style.length; i += 1) {
      const name = style[i];
      if (name && name.startsWith("--color-")) tokenNames.add(name);
    }
  });
  const tokenKeys = new Set<string>();
  tokenKeys.add(h.colorKey({ r: 0, g: 0, b: 0, a: 0 }));
  let colorEnabled = false;
  if (tokenNames.size === 0) {
    skipped.push("color: no --color-* tokens on :root");
  } else {
    colorEnabled = true;
    const probe = document.createElement("div");
    probe.style.display = "none";
    root.appendChild(probe);
    try {
      for (const name of tokenNames) {
        probe.style.color = `var(${name})`;
        const parsed = h.parseColor(getComputedStyle(probe).color);
        if (parsed) tokenKeys.add(h.colorKey(parsed));
      }
    } finally {
      probe.remove();
    }
  }

  // Stylesheet spacing, over the same walk as the tokens.
  eachStyleRule((style, selector) => checkDeclared(style, selector));

  const elements = root.querySelectorAll("*");
  const limit = Math.min(elements.length, 3000);
  let scanned = 0;
  for (let i = 0; i < limit; i += 1) {
    const el = elements[i];
    if (!el) continue;
    if (skipTags[el.tagName]) continue;
    let cs: CSSStyleDeclaration;
    try {
      cs = getComputedStyle(el);
    } catch {
      continue;
    }
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    let rendered = true;
    try {
      rendered = el.getClientRects().length > 0;
    } catch {
      rendered = true;
    }
    if (!rendered) continue;
    scanned += 1;

    // Contrast: composite the text color over the effective background.
    try {
      if (hasText(el)) {
        const fgRaw = h.parseColor(cs.color);
        if (fgRaw) {
          let bg: Rgba | null = null;
          let unknown = false;
          let node: Element | null = el;
          while (node) {
            const ncs = getComputedStyle(node);
            if (ncs.backgroundImage && ncs.backgroundImage !== "none") {
              unknown = true;
              break;
            }
            const layer = h.parseColor(ncs.backgroundColor);
            if (layer && layer.a > 0) {
              bg = bg === null ? layer : h.blend(bg, layer);
              if (bg.a >= 1) break;
            }
            node = node.parentElement;
          }
          if (!unknown) {
            if (bg === null) bg = { r: 255, g: 255, b: 255, a: 1 };
            else if (bg.a < 1) bg = h.blend(bg, { r: 255, g: 255, b: 255, a: 1 });
            const fg = fgRaw.a < 1 ? h.blend(fgRaw, bg) : fgRaw;
            const ratio = h.contrastRatio(fg, bg);
            const need = h.minContrast(Number.parseFloat(cs.fontSize), Number.parseInt(cs.fontWeight, 10));
            if (ratio < need) {
              findings.push({
                rule: "contrast",
                selector: selectorFor(el),
                detail: `${ratio.toFixed(1)}:1 (${hex(fg)} on ${hex(bg)}), needs ${need}:1`,
              });
            }
          }
        }
      }
    } catch {
      // Never let one element abort the scan.
    }

    // Targets: interactive elements at least 44x44 CSS px.
    try {
      if (el.matches(targetSelector)) {
        const inlineLink =
          el.tagName === "A" && cs.display === "inline" && el.parentElement !== null && hasText(el.parentElement);
        if (!inlineLink) {
          const rect = el.getBoundingClientRect();
          let width = rect.width;
          let height = rect.height;
          const input = el as HTMLInputElement;
          if (el.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio")) {
            let label: Element | null = input.closest("label");
            if (!label && input.id) {
              label = root.querySelector('label[for="' + input.id.replace(/["\\]/g, "\\$&") + '"]');
            }
            if (label) {
              const lr = label.getBoundingClientRect();
              width = Math.max(width, lr.width);
              height = Math.max(height, lr.height);
            }
          }
          if (width < 44 || height < 44) {
            findings.push({
              rule: "targets",
              selector: selectorFor(el),
              detail: `${Math.round(width)}×${Math.round(height)}px, needs 44×44`,
            });
          }
        }
      }
    } catch {
      // Never let one element abort the scan.
    }

    // Color: every painted color must be a `--color-*` token.
    if (colorEnabled) {
      try {
        const checkColor = (value: string, property: string): void => {
          const parsed = h.parseColor(value);
          if (!parsed) return;
          if (tokenKeys.has(h.colorKey(parsed))) return;
          findings.push({
            rule: "color",
            selector: selectorFor(el),
            detail: `${property} ${hex(parsed)} is not a design token`,
          });
        };
        if (hasText(el)) checkColor(cs.color, "color");
        const bg = h.parseColor(cs.backgroundColor);
        if (bg && bg.a > 0) checkColor(cs.backgroundColor, "background-color");
        for (const side of ["top", "right", "bottom", "left"]) {
          const width = cs.getPropertyValue(`border-${side}-width`);
          const style = cs.getPropertyValue(`border-${side}-style`);
          if (width !== "0px" && style !== "none") checkColor(cs.getPropertyValue(`border-${side}-color`), `border-${side}-color`);
        }
      } catch {
        // Never let one element abort the scan.
      }
    }

    // Spacing declared inline on the element.
    try {
      const inline = (el as unknown as { style?: CSSStyleDeclaration }).style;
      if (inline) checkDeclared(inline, selectorFor(el));
    } catch {
      // Never let one element abort the scan.
    }
  }

  // Slop: generic AI design tells, from a snapshot of every element.
  try {
    findings.push(...h.slopFindings(h.collectSlop(selectorFor), h.collectSlopPage(selectorFor)));
  } catch {
    skipped.push("slop");
  }

  return { findings, skipped, scanned };
}

/** The design lint as one page expression, embedding the selector and helpers. */
export function lintScript(selectorFor: (el: Element) => string): string {
  return `(() => JSON.stringify((${designLint.toString()})(${selectorFor.toString()}, { parseColor: ${parseColor.toString()}, blend: ${blend.toString()}, contrastRatio: ${contrastRatio.toString()}, minContrast: ${minContrast.toString()}, onGrid: ${onGrid.toString()}, colorKey: ${colorKey.toString()}, collectSlop: ${collectSlop.toString()}, collectSlopPage: ${collectSlopPage.toString()}, slopFindings: ${slopFindings.toString()} })))()`;
}

/** How many findings `formatLint` prints before eliding the rest. */
export const LINT_MAX = 40;

/** Render a lint result as a compact report for the agent. */
export function formatLint(result: LintResult): string {
  const order: LintRule[] = ["contrast", "targets", "spacing", "color", "slop"];
  const deduped: LintFinding[] = [];
  const seen = new Set<string>();
  for (const rule of order) {
    for (const finding of result.findings) {
      if (finding.rule !== rule) continue;
      const key = `${finding.rule}|${finding.selector}|${finding.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(finding);
    }
  }

  const counts: Record<LintRule, number> = { contrast: 0, targets: 0, spacing: 0, color: 0, slop: 0 };
  for (const finding of deduped) counts[finding.rule] += 1;

  const lines: string[] = [];
  if (deduped.length === 0) {
    lines.push(`design_lint: no findings (${result.scanned} elements)`);
  } else {
    lines.push(
      `design_lint: ${deduped.length} findings — contrast ${counts.contrast}, targets ${counts.targets}, spacing ${counts.spacing}, color ${counts.color}, slop ${counts.slop} (${result.scanned} elements)`,
    );
    const shown = deduped.slice(0, LINT_MAX);
    for (const finding of shown) lines.push(`- [${finding.rule}] ${finding.selector} — ${finding.detail}`);
    const rest = deduped.length - shown.length;
    if (rest > 0) lines.push(`… ${rest} more not shown`);
  }
  for (const entry of result.skipped) lines.push(`skipped ${entry}`);
  return lines.join("\n");
}
