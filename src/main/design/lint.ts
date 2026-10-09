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
export type LintRule = "contrast" | "targets" | "spacing" | "color";

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

/**
 * Lint a design page: contrast, tap targets, 4px spacing, and color tokens.
 * Runs inside the page (serialized with `toString`), so it uses only its
 * parameters and DOM globals; the color helpers are passed in as `h`.
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

  return { findings, skipped, scanned };
}

/** The design lint as one page expression, embedding the selector and color helpers. */
export function lintScript(selectorFor: (el: Element) => string): string {
  return `(() => JSON.stringify((${designLint.toString()})(${selectorFor.toString()}, { parseColor: ${parseColor.toString()}, blend: ${blend.toString()}, contrastRatio: ${contrastRatio.toString()}, minContrast: ${minContrast.toString()}, onGrid: ${onGrid.toString()}, colorKey: ${colorKey.toString()} })))()`;
}

/** How many findings `formatLint` prints before eliding the rest. */
export const LINT_MAX = 40;

/** Render a lint result as a compact report for the agent. */
export function formatLint(result: LintResult): string {
  const order: LintRule[] = ["contrast", "targets", "spacing", "color"];
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

  const counts: Record<LintRule, number> = { contrast: 0, targets: 0, spacing: 0, color: 0 };
  for (const finding of deduped) counts[finding.rule] += 1;

  const lines: string[] = [];
  if (deduped.length === 0) {
    lines.push(`design_lint: no findings (${result.scanned} elements)`);
  } else {
    lines.push(
      `design_lint: ${deduped.length} findings — contrast ${counts.contrast}, targets ${counts.targets}, spacing ${counts.spacing}, color ${counts.color} (${result.scanned} elements)`,
    );
    const shown = deduped.slice(0, LINT_MAX);
    for (const finding of shown) lines.push(`- [${finding.rule}] ${finding.selector} — ${finding.detail}`);
    const rest = deduped.length - shown.length;
    if (rest > 0) lines.push(`… ${rest} more not shown`);
  }
  for (const entry of result.skipped) lines.push(`skipped ${entry}`);
  return lines.join("\n");
}
