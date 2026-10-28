/// <reference lib="dom" />

import type { LintFinding } from "./lint";

/** One painted layer's computed surface: an element or its ::before/::after. */
export interface SurfacePaint {
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  boxShadow: string;
  borderWidth: { top: number; right: number; bottom: number; left: number };
  borderColor: { top: string; right: string; bottom: string; left: string };
  width: number;
  height: number;
  radius: number;
  animationName: string;
  animationIterationCount: string;
  animationDuration: string;
  content: string;
}

/** One element's plain-data surface, motion and copy record for the slop checks. */
export interface SurfaceNode {
  selector: string;
  tag: string;
  text: string;
  ownText: string;
  parentWidth: number;
  paint: SurfacePaint;
  before: SurfacePaint;
  after: SurfacePaint;
  color: string;
  effectiveBackground: string;
  cardLike: boolean;
  leaf: boolean;
  container: string | null;
  headingText: string | null;
  opacity: number;
  visibility: string;
  position: string;
  hiddenContext: boolean;
  editableContext: boolean;
}

/** A plain-data snapshot of page surfaces, motion and copy for the slop checks. */
export interface SurfaceSlopSnapshot {
  /** The body's (else html's) painted background is darker than 0.2 luminance. */
  dark: boolean;
  nodes: SurfaceNode[];
  /** Body text without code and pre, first 8000 characters. */
  prose: string;
  /** A stylesheet rule sets `animation-play-state: paused`. */
  paused: boolean;
  /** Keyframes rule names whose declarations contain "translate". */
  translateKeyframes: string[];
}

/** Snapshot page surfaces, motion and copy; runs inside the page. */
export function collectSurfaceSlop(selectorFor: (el: Element) => string): SurfaceSlopSnapshot {
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

  const parseColorValue = (value: string): { r: number; g: number; b: number; a: number } | null => {
    const text = (value || "").trim().toLowerCase();
    if (!text) return null;
    if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const fn = /^rgba?\(([^)]*)\)$/.exec(text);
    if (!fn) return null;
    const body = (fn[1] ?? "").trim();
    const parts = body.includes(",")
      ? body.split(",").map((p) => p.trim()).filter(Boolean)
      : body.split(/[\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (i: number): number => Number.parseFloat(parts[i] ?? "");
    const r = channel(0);
    const g = channel(1);
    const b = channel(2);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    let a = 1;
    if (parts.length >= 4) a = Number.parseFloat(parts[3] ?? "");
    if (!Number.isFinite(a)) return null;
    return { r, g, b, a };
  };

  /** True when a computed background-color paints something. */
  const painted = (value: string): boolean => {
    const c = parseColorValue(value);
    return c !== null && c.a > 0;
  };

  const luminance = (value: string): number | null => {
    const c = parseColorValue(value);
    if (!c || c.a <= 0) return null;
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  };

  /** The text of an element's direct text children. */
  const ownText = (el: Element): string => {
    let text = "";
    for (let i = 0; i < el.childNodes.length; i += 1) {
      const child = el.childNodes[i];
      if (child && child.nodeType === 3) text += child.textContent ?? "";
    }
    return text.trim().slice(0, 200);
  };

  /** True when the box paints a card-like surface. */
  const isCard = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 60) return false;
    if (painted(cs.backgroundColor)) return true;
    if ((Number.parseFloat(cs.getPropertyValue("border-top-width")) || 0) >= 1) return true;
    if ((Number.parseFloat(cs.getPropertyValue("border-right-width")) || 0) >= 1) return true;
    if ((Number.parseFloat(cs.getPropertyValue("border-bottom-width")) || 0) >= 1) return true;
    if ((Number.parseFloat(cs.getPropertyValue("border-left-width")) || 0) >= 1) return true;
    return cs.boxShadow !== "" && cs.boxShadow !== "none";
  };

  const readPaint = (el: Element, pseudo: string | null): SurfacePaint => {
    const cs = getComputedStyle(el, pseudo);
    let width = 0;
    let height = 0;
    if (pseudo) {
      width = Number.parseFloat(cs.width) || 0;
      height = Number.parseFloat(cs.height) || 0;
    } else {
      const rect = el.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    }
    const borderWidth = (side: string): number =>
      Number.parseFloat(cs.getPropertyValue("border-" + side + "-width")) || 0;
    const borderColor = (side: string): string =>
      cs.getPropertyValue("border-" + side + "-color") || "rgb(0, 0, 0)";
    return {
      backgroundColor: cs.backgroundColor || "rgba(0, 0, 0, 0)",
      backgroundImage: cs.backgroundImage || "none",
      backgroundSize: cs.getPropertyValue("background-size") || "",
      boxShadow: cs.boxShadow || "none",
      borderWidth: {
        top: borderWidth("top"),
        right: borderWidth("right"),
        bottom: borderWidth("bottom"),
        left: borderWidth("left"),
      },
      borderColor: {
        top: borderColor("top"),
        right: borderColor("right"),
        bottom: borderColor("bottom"),
        left: borderColor("left"),
      },
      width,
      height,
      radius: Number.parseFloat(cs.borderTopLeftRadius) || 0,
      animationName: cs.animationName || "none",
      animationIterationCount: cs.animationIterationCount || "1",
      animationDuration: cs.animationDuration || "0s",
      content: pseudo ? cs.content || "none" : "",
    };
  };

  let dark = false;
  const body = document.body;
  const rootEl = document.documentElement;
  if (body || rootEl) {
    const bodyBg = body ? getComputedStyle(body).backgroundColor : "";
    const rootBg = rootEl ? getComputedStyle(rootEl).backgroundColor : "";
    const chosen = painted(bodyBg) ? bodyBg : painted(rootBg) ? rootBg : "";
    const lum = chosen ? luminance(chosen) : null;
    if (lum !== null) dark = lum < 0.2;
  }

  const nodes: SurfaceNode[] = [];
  if (body) {
    const elements = body.querySelectorAll("*");
    const limit = Math.min(elements.length, 3000);
    for (let i = 0; i < limit; i += 1) {
      const el = elements[i];
      if (!el) continue;
      const tag = el.tagName.toLowerCase();
      if (skipTags[tag]) continue;
      // An unresolved variant set: only the shown variant is on the page.
      if (el.closest("[data-cubiq-variant][hidden]")) continue;
      try {
        const cs = getComputedStyle(el);
        const paint = readPaint(el, null);
        const before = readPaint(el, "::before");
        const after = readPaint(el, "::after");
        const bw = paint.borderWidth;
        const cardLike =
          painted(cs.backgroundColor) ||
          bw.top >= 1 ||
          bw.right >= 1 ||
          bw.bottom >= 1 ||
          bw.left >= 1 ||
          (cs.boxShadow !== "" && cs.boxShadow !== "none");

        // Effective background: the first painted background-color up the tree.
        let effectiveBackground = "rgb(255, 255, 255)";
        for (let a: Element | null = el; a; a = a.parentElement) {
          const bg = getComputedStyle(a).backgroundColor;
          if (painted(bg)) {
            effectiveBackground = bg;
            break;
          }
        }

        let parentWidth = 0;
        if (el.parentElement) {
          try {
            parentWidth = el.parentElement.getBoundingClientRect().width;
          } catch {
            parentWidth = 0;
          }
        }

        // The card or list item a repeated label would sit inside. Tables, nav
        // bars and panels larger than a card repeat labels by design.
        let container: string | null = null;
        const inGrid = Boolean(el.closest("table, nav"));
        for (let a: Element | null = el.parentElement; a && !inGrid; a = a.parentElement) {
          const parentTag = a.tagName.toLowerCase();
          if (parentTag === "li" || parentTag === "article") {
            container = selectorFor(a);
            break;
          }
          let card = false;
          try {
            card = isCard(a);
          } catch {
            card = false;
          }
          if (card) {
            const box = a.getBoundingClientRect();
            if (box.width <= 600 && box.height <= 600) container = selectorFor(a);
            break;
          }
        }

        // The headline a span might be highlighting.
        let headingText: string | null = null;
        for (let a: Element | null = el.parentElement; a; a = a.parentElement) {
          const parentTag = a.tagName.toLowerCase();
          if (parentTag === "h1" || parentTag === "h2") {
            headingText = (a.textContent ?? "").trim().slice(0, 200);
            break;
          }
        }

        // Hidden, dialog, aria-hidden or a closed details ancestor.
        let hiddenContext = Boolean(el.closest("[aria-hidden=true], [hidden], dialog"));
        if (!hiddenContext) {
          const closed = el.closest("details:not([open])");
          if (closed) {
            let summary: Element | null = null;
            for (let j = 0; j < closed.children.length; j += 1) {
              const child = closed.children[j];
              if (child && child.tagName === "SUMMARY") {
                summary = child;
                break;
              }
            }
            hiddenContext = !(summary && summary.contains(el));
          }
        }

        const opacity = Number.parseFloat(cs.opacity);
        nodes.push({
          selector: selectorFor(el),
          tag,
          text: (el.textContent ?? "").trim().slice(0, 300),
          ownText: ownText(el),
          parentWidth,
          paint,
          before,
          after,
          color: cs.color || "rgb(0, 0, 0)",
          effectiveBackground,
          cardLike,
          leaf: el.childElementCount === 0,
          container,
          headingText,
          opacity: Number.isFinite(opacity) ? opacity : 1,
          visibility: cs.visibility || "visible",
          position: cs.position || "",
          hiddenContext,
          editableContext: Boolean(el.closest("input, textarea, [contenteditable]")),
        });
      } catch {
        // One element never aborts the snapshot.
      }
    }
  }

  // Prose: body text outside code, pre, scripts and hidden regions.
  const chunks: string[] = [];
  if (body) {
    try {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let total = 0;
      for (let n = walker.nextNode(), seen = 0; n && seen < 4000 && total < 8000; n = walker.nextNode(), seen += 1) {
        const parent = n.parentElement;
        if (!parent) continue;
        if (parent.closest("code, pre, script, style, noscript, template, [hidden], [aria-hidden=true]")) continue;
        const value = (n.nodeValue ?? "").replace(/\s+/g, " ").trim();
        if (!value) continue;
        chunks.push(value);
        total += value.length + 1;
      }
    } catch {
      // A page that cannot be walked contributes no prose.
    }
  }
  const prose = chunks.join(" ").slice(0, 8000);

  // Stylesheets: a paused animation, and keyframes that move something sideways.
  let paused = false;
  const translateKeyframes: string[] = [];
  const visitRules = (list: CSSRuleList): void => {
    for (let i = 0; i < list.length; i += 1) {
      const rule = list[i];
      if (!rule) continue;
      const shape = rule as unknown as {
        cssRules?: CSSRuleList;
        style?: CSSStyleDeclaration;
        name?: string;
        cssText?: string;
      };
      if (typeof shape.name === "string" && shape.cssRules) {
        let text = "";
        try {
          text = (shape.cssText || "").toLowerCase();
        } catch {
          text = "";
        }
        if (text.indexOf("translate") !== -1) translateKeyframes.push(shape.name);
      }
      if (shape.style) {
        try {
          const state = shape.style.getPropertyValue("animation-play-state");
          const shorthand = shape.style.getPropertyValue("animation");
          if ((state + " " + shorthand).indexOf("paused") !== -1) paused = true;
        } catch {
          // A rule whose style cannot be read is skipped.
        }
      }
      let nested: CSSRuleList | null = null;
      try {
        nested = shape.cssRules ?? null;
      } catch {
        nested = null;
      }
      if (nested && nested.length > 0) visitRules(nested);
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
    if (rules) {
      try {
        visitRules(rules);
      } catch {
        // A sheet that cannot be walked is skipped.
      }
    }
  }

  return { dark, nodes, prose, paused, translateKeyframes };
}

/** Turn collected surface snapshots into slop findings; pure and self-contained. */
export function surfaceSlopFindings(s: SurfaceSlopSnapshot): LintFinding[] {
  const findings: LintFinding[] = [];
  const push = (selector: string, id: string, detail: string): void => {
    findings.push({ rule: "slop", id, selector, detail });
  };

  const parseColorValue = (value: string): { r: number; g: number; b: number; a: number } | null => {
    const text = (value || "").trim().toLowerCase();
    if (!text) return null;
    if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const fn = /^rgba?\(([^)]*)\)$/.exec(text);
    if (!fn) return null;
    const body = (fn[1] ?? "").trim();
    const parts = body.includes(",")
      ? body.split(",").map((p) => p.trim()).filter(Boolean)
      : body.split(/[\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (i: number): number => Number.parseFloat(parts[i] ?? "");
    const r = channel(0);
    const g = channel(1);
    const b = channel(2);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    let a = 1;
    if (parts.length >= 4) a = Number.parseFloat(parts[3] ?? "");
    if (!Number.isFinite(a)) return null;
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
  };

  /** Hue in degrees, saturation and lightness as 0-1. */
  const hsl = (c: { r: number; g: number; b: number }): { h: number; s: number; l: number } => {
    const r = c.r / 255;
    const g = c.g / 255;
    const b = c.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let sat = 0;
    if (d > 0) {
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s: sat, l };
  };

  const isPurple = (c: { r: number; g: number; b: number }): boolean => {
    const v = hsl(c);
    return v.s >= 0.4 && v.h >= 250 && v.h <= 310;
  };

  const isCyan = (c: { r: number; g: number; b: number }): boolean => {
    const v = hsl(c);
    return v.s >= 0.4 && v.h >= 170 && v.h <= 215;
  };

  const painted = (value: string): boolean => {
    const c = parseColorValue(value);
    return c !== null && c.a > 0;
  };

  /** Split a box-shadow value into top-level layers. */
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

  /** Inset flag, blur and colour of one shadow layer. */
  const shadowInfo = (layer: string): { inset: boolean; blur: number; color: { r: number; g: number; b: number; a: number } | null } => {
    const inset = /\binset\b/.test(layer);
    const colorMatch = /rgba?\([^)]*\)/.exec(layer);
    const color = colorMatch ? parseColorValue(colorMatch[0]) : null;
    const lengths: number[] = [];
    const re = /-?\d+(?:\.\d+)?px/g;
    let match = re.exec(layer);
    while (match) {
      lengths.push(Number.parseFloat(match[0]));
      match = re.exec(layer);
    }
    return { inset, blur: lengths[2] ?? 0, color };
  };

  /** Every rgb()/rgba() colour written in a gradient. */
  const gradientColors = (image: string): { r: number; g: number; b: number; a: number }[] => {
    const colors: { r: number; g: number; b: number; a: number }[] = [];
    const re = /rgba?\([^)]*\)/g;
    let match = re.exec(image);
    while (match) {
      const c = parseColorValue(match[0]);
      if (c) colors.push(c);
      match = re.exec(image);
    }
    return colors;
  };

  const durationSeconds = (value: string): number => {
    const first = (value || "").split(",")[0]?.trim() ?? "";
    if (first.endsWith("ms")) return (Number.parseFloat(first) || 0) / 1000;
    return Number.parseFloat(first) || 0;
  };

  const infinite = (p: SurfacePaint): boolean => {
    if (!p.animationName || p.animationName === "none") return false;
    const counts = p.animationIterationCount.split(",");
    let endless = false;
    for (const count of counts) if (count.trim() === "infinite") endless = true;
    return endless && durationSeconds(p.animationDuration) > 0;
  };

  const unquote = (value: string): string => value.trim().replace(/^["']|["']$/g, "");

  // Ghost card: a hairline border plus a wide soft shadow.
  const ghost: SurfaceNode[] = [];
  for (const n of s.nodes) {
    const b = n.paint.borderWidth;
    const hairline =
      b.top >= 0.5 && b.top <= 1 &&
      b.right >= 0.5 && b.right <= 1 &&
      b.bottom >= 0.5 && b.bottom <= 1 &&
      b.left >= 0.5 && b.left <= 1;
    if (!hairline) continue;
    let soft = false;
    for (const layer of shadowLayers(n.paint.boxShadow)) {
      if (!layer || /\binset\b/.test(layer)) continue;
      const info = shadowInfo(layer);
      if (info.blur >= 24 && info.color !== null && info.color.a <= 0.2) {
        soft = true;
        break;
      }
    }
    if (soft) ghost.push(n);
  }
  if (ghost.length >= 2) {
    for (let i = 0; i < Math.min(ghost.length, 3); i += 1) {
      push(ghost[i]!.selector, "ghost-card", "hairline border plus a wide soft shadow: pick one, a border or a tight shadow");
    }
  }

  // Radial halo: a big radial glow behind content on a dark page.
  if (s.dark) {
    const halos: SurfaceNode[] = [];
    for (const n of s.nodes) {
      const surfaces = [n.paint, n.before, n.after];
      for (const p of surfaces) {
        if (p.width >= 400 && p.height >= 300 && p.backgroundImage.indexOf("radial-gradient(") !== -1) {
          halos.push(n);
          break;
        }
      }
    }
    for (let i = 0; i < Math.min(halos.length, 2); i += 1) {
      push(halos[i]!.selector, "radial-halo", "radial glow behind content on a dark page: use a flat surface or a real image");
    }
  }

  // Purple-to-cyan palette: a gradient pairing, or a page painted in both.
  let palette: SurfaceNode | null = null;
  for (const n of s.nodes) {
    const surfaces = [n.paint, n.before, n.after];
    let hit = false;
    for (const p of surfaces) {
      if (p.backgroundImage.indexOf("gradient(") === -1) continue;
      const colors = gradientColors(p.backgroundImage);
      let purple = false;
      let cyan = false;
      for (const c of colors) {
        if (c.a <= 0.05) continue;
        if (isPurple(c)) purple = true;
        if (isCyan(c)) cyan = true;
      }
      if (purple && cyan) {
        hit = true;
        break;
      }
    }
    if (hit) {
      palette = n;
      break;
    }
  }
  if (palette) {
    push(palette.selector, "ai-palette", "purple-to-cyan palette: pick one accent that belongs to the subject");
  } else {
    let purpleCount = 0;
    let cyanCount = 0;
    for (const n of s.nodes) {
      const bg = parseColorValue(n.paint.backgroundColor);
      const fg = parseColorValue(n.color);
      const isPaintedPurple = (bg !== null && bg.a > 0 && isPurple(bg)) || (fg !== null && isPurple(fg));
      const isPaintedCyan = (bg !== null && bg.a > 0 && isCyan(bg)) || (fg !== null && isCyan(fg));
      if (isPaintedPurple) purpleCount += 1;
      if (isPaintedCyan) cyanCount += 1;
    }
    if (purpleCount >= 3 && cyanCount >= 3) {
      push("body", "ai-palette", "purple-to-cyan palette: pick one accent that belongs to the subject");
    }
  }

  // Grey text on a coloured surface: neutral type over a saturated fill.
  let greyText = 0;
  for (const n of s.nodes) {
    if (greyText >= 3) break;
    if (!n.ownText.trim()) continue;
    const fg = parseColorValue(n.color);
    const bg = parseColorValue(n.effectiveBackground);
    if (!fg || !bg || fg.a <= 0 || bg.a < 0.9) continue;
    const f = hsl(fg);
    const b = hsl(bg);
    if (f.s < 0.12 && f.l >= 0.25 && f.l <= 0.75 && b.s >= 0.35 && b.l >= 0.2 && b.l <= 0.8) {
      greyText += 1;
      push(n.selector, "gray-on-color", "grey text on a coloured surface: use a tint of the surface colour or white");
    }
  }

  // Repeating stripes: a repeating gradient used as texture.
  const stripes: SurfaceNode[] = [];
  for (const n of s.nodes) {
    const surfaces = [n.paint, n.before, n.after];
    for (const p of surfaces) {
      if (
        p.backgroundImage.indexOf("repeating-linear-gradient(") !== -1 ||
        p.backgroundImage.indexOf("repeating-radial-gradient(") !== -1
      ) {
        stripes.push(n);
        break;
      }
    }
  }
  for (let i = 0; i < Math.min(stripes.length, 2); i += 1) {
    push(stripes[i]!.selector, "repeating-stripes", "repeating-gradient stripes as texture: use a flat surface");
  }

  // Grid background: the graph-paper trick in two gradient layers.
  let grid: SurfaceNode | null = null;
  for (const n of s.nodes) {
    const surfaces = [n.paint, n.before, n.after];
    for (const p of surfaces) {
      if (p.width < 400 || p.height < 300) continue;
      const image = p.backgroundImage;
      if (!image || image === "none") continue;
      const repeating = (image.match(/repeating-linear-gradient\(/g) ?? []).length;
      if (repeating >= 2) {
        grid = n;
        break;
      }
      const layers = (image.match(/linear-gradient\(/g) ?? []).length - repeating;
      if (layers < 2) continue;
      const sizes = p.backgroundSize.match(/-?\d+(?:\.\d+)?px/g) ?? [];
      let small = false;
      for (const size of sizes) {
        const value = Number.parseFloat(size);
        if (value > 0 && value <= 120) small = true;
      }
      if (small) {
        grid = n;
        break;
      }
    }
    if (grid) break;
  }
  if (grid) {
    push(grid.selector, "grid-background", "decorative grid-line background: let the content carry the page");
  }

  // Glow border: a saturated border with its own coloured bloom on a dark page.
  if (s.dark) {
    const glowing: SurfaceNode[] = [];
    for (const n of s.nodes) {
      const bw = n.paint.borderWidth;
      const bc = n.paint.borderColor;
      const sides = [
        { px: bw.top, color: bc.top },
        { px: bw.right, color: bc.right },
        { px: bw.bottom, color: bc.bottom },
        { px: bw.left, color: bc.left },
      ];
      let border = false;
      for (const side of sides) {
        if (side.px < 1) continue;
        const c = parseColorValue(side.color);
        if (!c || c.a <= 0) continue;
        const v = hsl(c);
        if (v.s >= 0.5 && v.l >= 0.45) border = true;
      }
      if (!border) continue;
      let bloom = false;
      for (const layer of shadowLayers(n.paint.boxShadow)) {
        if (!layer || /\binset\b/.test(layer)) continue;
        const info = shadowInfo(layer);
        if (info.color === null || info.color.a <= 0) continue;
        if (info.blur >= 6 && hsl(info.color).s >= 0.4) bloom = true;
      }
      if (bloom) glowing.push(n);
    }
    if (glowing.length >= 2) {
      for (let i = 0; i < Math.min(glowing.length, 3); i += 1) {
        push(glowing[i]!.selector, "glow-border", "glowing border on a dark surface: use a quiet border or none");
      }
    }
  }

  // Pulsing dot: a tiny round element on an endless animation.
  const dots: SurfaceNode[] = [];
  for (const n of s.nodes) {
    const surfaces = [n.paint, n.before, n.after];
    for (const p of surfaces) {
      if (p.width <= 0 || p.height <= 0 || p.width > 16 || p.height > 16) continue;
      if (p.radius < p.width / 2 - 1) continue;
      if (!infinite(p)) continue;
      dots.push(n);
      break;
    }
  }
  for (let i = 0; i < Math.min(dots.length, 2); i += 1) {
    push(dots[i]!.selector, "pulsing-dot", "pulsing status dot: show status with a steady colour and a label");
  }

  // Blinking cursor: a fake caret drawn with an endless blink.
  const carets: SurfaceNode[] = [];
  const glyphs: Record<string, boolean> = { "|": true, _: true, "▋": true, "█": true };
  for (const n of s.nodes) {
    if (n.editableContext) continue;
    const own = n.ownText.trim();
    const afterContent = unquote(n.after.content).trim();
    let hit = false;
    const surfaces = [n.paint, n.before, n.after];
    for (const p of surfaces) {
      if (/blink|caret|cursor/i.test(p.animationName) && infinite(p)) {
        hit = true;
        break;
      }
    }
    if (!hit && infinite(n.paint) && glyphs[own]) hit = true;
    if (!hit && infinite(n.after) && glyphs[afterContent]) hit = true;
    if (hit) carets.push(n);
  }
  for (let i = 0; i < Math.min(carets.length, 2); i += 1) {
    push(carets[i]!.selector, "blinking-cursor", "blinking cursor on static text: drop the fake caret");
  }

  // Marquee: a literal scroller or a wide translating track with no pause.
  let marquee: SurfaceNode | null = null;
  for (const n of s.nodes) {
    if (n.tag === "marquee") {
      marquee = n;
      break;
    }
  }
  if (!marquee && !s.paused) {
    for (const n of s.nodes) {
      if (!infinite(n.paint)) continue;
      if (n.parentWidth <= 0 || n.paint.width <= n.parentWidth * 1.2) continue;
      const names = n.paint.animationName.split(",");
      let translated = false;
      for (const name of names) {
        if (s.translateKeyframes.indexOf(name.trim()) !== -1) translated = true;
      }
      if (translated) {
        marquee = n;
        break;
      }
    }
  }
  if (marquee) {
    push(marquee.selector, "marquee", "auto-scrolling marquee with no pause: show the items still, or pause on hover and for reduced motion");
  }

  // Hidden at rest: content that starts invisible and animates in.
  const hidden: SurfaceNode[] = [];
  for (const n of s.nodes) {
    const hasContent = n.text.trim().length >= 20 || n.tag === "img";
    if (!hasContent || n.paint.height <= 0) continue;
    if (n.hiddenContext || n.position === "fixed") continue;
    if (n.opacity < 0.05 || n.visibility === "hidden") hidden.push(n);
  }
  if (hidden.length >= 3) {
    const reason = hidden[0]!.opacity < 0.05 ? "opacity 0" : "visibility hidden";
    push(
      hidden[0]!.selector,
      "hidden-at-rest",
      `${hidden.length} blocks start invisible (${reason}): show content at rest, animate only as an extra`,
    );
  }

  // Em dash overuse: the pause-for-effect dash in most sentences.
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < s.prose.length; i += 1) {
    const ch = s.prose[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (i + 1 < s.prose.length && !/\s/.test(s.prose[i + 1] ?? "")) continue;
    const part = s.prose.slice(start, i + 1).trim();
    if (part) sentences.push(part);
    start = i + 1;
  }
  const tail = s.prose.slice(start).trim();
  if (tail) sentences.push(tail);
  let dashed = 0;
  for (const sentence of sentences) {
    if (sentence.indexOf("—") !== -1 || sentence.indexOf(" – ") !== -1) dashed += 1;
  }
  if (sentences.length >= 6 && dashed / sentences.length >= 0.4) {
    push("body", "em-dash-overuse", `em dashes in ${dashed} of ${sentences.length} sentences: use commas, colons or full stops`);
  }

  // Repeated label: the same short label twice inside one card, in different
  // roles (a heading and a badge); same-tag repeats are a list or a grid.
  const byContainer: Record<string, SurfaceNode[]> = {};
  for (const n of s.nodes) {
    if (!n.container || !n.leaf) continue;
    const text = n.text.trim();
    if (text.length < 4) continue;
    if (/^[\d\s.,:$€£¥%+\-−()]+$/.test(text)) continue;
    (byContainer[n.container] ??= []).push(n);
  }
  let repeated = 0;
  for (const container of Object.keys(byContainer)) {
    if (repeated >= 2) break;
    const group = byContainer[container]!;
    const seen: Record<string, SurfaceNode[]> = {};
    for (const n of group) {
      const key = n.text.trim().toLowerCase();
      (seen[key] ??= []).push(n);
    }
    for (const key of Object.keys(seen)) {
      const same = seen[key]!;
      if (same.length < 2) continue;
      if (same.every((n) => n.tag === same[0]!.tag)) continue;
      const label = same[0]!.text.trim().replace(/—/g, ":").slice(0, 40);
      const times = same.length === 2 ? "twice" : `${same.length} times`;
      push(same[0]!.selector, "repeated-label", `"${label}" appears ${times} in one card: say it once`);
      repeated += 1;
      if (repeated >= 2) break;
    }
  }

  // Slogan cadence: the "Not X. Y." pitch construction.
  const notXY = /\bNot (?:a |an |the |just )?[^.!?]{1,40}\.\s+[A-Z][^.!?]{1,40}[.!?]/.exec(s.prose);
  const notJust = /\b(?:isn't|is not|it's not) just [^.!?—]{1,40}[,—–-]\s*it's\b/i.exec(s.prose);
  const cadence = notXY ?? notJust;
  if (cadence) {
    const quote = (cadence[0] ?? "").replace(/—/g, ":").slice(0, 40);
    push("body", "not-x-y", `slogan cadence "${quote}": say plainly what it does`);
  }

  // Theatre: "X theater" where X is not an actual venue.
  const allowedTheatre: Record<string, boolean> = {
    movie: true,
    home: true,
    the: true,
    a: true,
    our: true,
    community: true,
    musical: true,
    opera: true,
    cinema: true,
    local: true,
    "open-air": true,
    outdoor: true,
    national: true,
    royal: true,
  };
  const theatre = /\b(\w+) theat(?:er|re)\b/gi;
  let theatreMatch = theatre.exec(s.prose);
  while (theatreMatch) {
    const word = (theatreMatch[1] ?? "").toLowerCase();
    if (!allowedTheatre[word]) {
      push("body", "theater", `"${(theatreMatch[0] ?? "").toLowerCase()}": name the actual problem`);
      break;
    }
    theatreMatch = theatre.exec(s.prose);
  }

  // Highlighter: a coloured band behind a few headline words.
  const highlightTags: Record<string, boolean> = {
    span: true,
    mark: true,
    em: true,
    strong: true,
    i: true,
    b: true,
  };
  for (const n of s.nodes) {
    if (!highlightTags[n.tag]) continue;
    if (!n.headingText) continue;
    const text = n.text.trim();
    if (!text || text.length >= n.headingText.trim().length) continue;
    const filled = painted(n.paint.backgroundColor) || n.paint.backgroundImage.indexOf("linear-gradient(") !== -1;
    if (!filled) continue;
    push(n.selector, "highlighter", "highlighter band behind headline words: let the type carry the emphasis");
    break;
  }

  return findings;
}
