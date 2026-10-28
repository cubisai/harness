import type { LintFinding } from "./lint";

/** One off-token value as the page uses it: how many elements, and the first one's selector. */
export interface SystemUse {
  value: string;
  count: number;
  selector: string;
}

/** The design system's type and corner tokens, and the values the page's elements actually use. */
export interface SystemSlopSnapshot {
  /** First families of the `--font-*` tokens, lowercased; empty when the page defines none. */
  fonts: string[];
  /** `--text-*` sizes in px, as exact values and as clamp() ranges. */
  sizes: number[];
  sizeRanges: [number, number][];
  /** `--radius-*` values in px; `pill` when one is 999px or more (any pill or circle is on token). */
  radii: number[];
  pill: boolean;
  /** What text elements use (first font family, font size in px) and what boxes use (corner radius in px). */
  usedFonts: SystemUse[];
  usedSizes: SystemUse[];
  usedRadii: SystemUse[];
}

/** Snapshot the `:root` font, text and radius tokens and what the page's elements use; runs inside the page. */
export function collectSystemSlop(selectorFor: (el: Element) => string): SystemSlopSnapshot {
  const out: SystemSlopSnapshot = { fonts: [], sizes: [], sizeRanges: [], radii: [], pill: false, usedFonts: [], usedSizes: [], usedRadii: [] };
  const root = document.documentElement;
  const rootPx = Number.parseFloat(getComputedStyle(root).fontSize) || 16;
  /** A length token in px: px, rem or a bare 0; NaN otherwise. */
  const px = (value: string): number => {
    const m = /^\s*(-?[\d.]+)(px|rem)?\s*$/.exec(value);
    if (!m) return Number.NaN;
    const n = Number.parseFloat(m[1]!);
    if (m[2] === "rem") return n * rootPx;
    return m[2] === "px" || n === 0 ? n : Number.NaN;
  };
  // Token names declared on :root (or html) in any stylesheet.
  const names: Record<string, boolean> = {};
  const visit = (list: CSSRuleList): void => {
    for (let i = 0; i < list.length; i += 1) {
      const rule = list[i] as unknown as { style?: CSSStyleDeclaration; selectorText?: string; cssRules?: CSSRuleList } | undefined;
      if (!rule) continue;
      if (rule.style && typeof rule.selectorText === "string" && /(^|,)\s*(:root|html)\b/.test(rule.selectorText)) {
        for (let j = 0; j < rule.style.length; j += 1) {
          const name = rule.style[j] ?? "";
          if (/^--(font|text|radius)-/.test(name)) names[name] = true;
        }
      }
      let nested: CSSRuleList | null = null;
      try {
        nested = rule.cssRules ?? null;
      } catch {
        nested = null;
      }
      if (nested && nested.length > 0) visit(nested);
    }
  };
  for (let i = 0; i < document.styleSheets.length; i += 1) {
    try {
      const rules = document.styleSheets[i]?.cssRules;
      if (rules) visit(rules);
    } catch {
      // A cross-origin sheet can't be read.
    }
  }
  const rootStyle = getComputedStyle(root);
  for (const name of Object.keys(names)) {
    const value = rootStyle.getPropertyValue(name).trim();
    if (!value || value.includes("var(")) continue;
    if (name.startsWith("--font-")) {
      const first = (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (first && out.fonts.indexOf(first) === -1) out.fonts.push(first);
    } else if (name.startsWith("--text-")) {
      const clamp = /^clamp\(([^,]+),[^,]+,([^,)]+)\)$/.exec(value);
      if (clamp) {
        const lo = px(clamp[1]!);
        const hi = px(clamp[2]!);
        if (Number.isFinite(lo) && Number.isFinite(hi)) out.sizeRanges.push([lo, hi]);
      } else if (Number.isFinite(px(value))) out.sizes.push(px(value));
    } else {
      const n = px(value);
      if (!Number.isFinite(n)) continue;
      if (n >= 999) out.pill = true;
      else out.radii.push(n);
    }
  }
  if (!out.fonts.length && !out.sizes.length && !out.sizeRanges.length && !out.radii.length) return out;

  const fonts: Record<string, SystemUse> = {};
  const sizes: Record<string, SystemUse> = {};
  const radii: Record<string, SystemUse> = {};
  const note = (map: Record<string, SystemUse>, value: string, el: Element): void => {
    const hit = map[value];
    if (hit) hit.count += 1;
    else map[value] = { value, count: 1, selector: selectorFor(el) };
  };
  const elements = document.body ? document.body.querySelectorAll("*") : [];
  const limit = Math.min(elements.length, 3000);
  for (let i = 0; i < limit; i += 1) {
    const el = elements[i];
    if (!el || /^(script|style|svg|path|g|defs|use|circle|rect|line|polyline|polygon|ellipse|br|wbr)$/i.test(el.tagName)) continue;
    if (el.closest("[data-cubiq-variant][hidden], svg")) continue;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      let own = false;
      for (let j = 0; j < el.childNodes.length; j += 1) {
        const c = el.childNodes[j];
        if (c && c.nodeType === 3 && (c.textContent ?? "").trim()) own = true;
      }
      if (own) {
        const family = (cs.fontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (family) note(fonts, family, el);
        const size = Math.round((Number.parseFloat(cs.fontSize) || 0) * 10) / 10;
        if (size > 0) note(sizes, String(size), el);
      }
      const radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;
      if (radius > 0) {
        const rect = el.getBoundingClientRect();
        const short = Math.min(rect.width, rect.height);
        // A pill or a circle is the full token; percentages compute from the box.
        if (short > 0 && !(out.pill && radius >= short / 2 - 1) && !/%/.test(cs.borderTopLeftRadius)) note(radii, String(Math.round(radius * 10) / 10), el);
      }
    } catch {
      // One element never aborts the snapshot.
    }
  }
  out.usedFonts = Object.keys(fonts).map((k) => fonts[k]!);
  out.usedSizes = Object.keys(sizes).map((k) => sizes[k]!);
  out.usedRadii = Object.keys(radii).map((k) => radii[k]!);
  return out;
}

/** Fonts, text sizes and corner radii a page uses that its system/tokens.css doesn't define; pure. */
export function systemSlopFindings(s: SystemSlopSnapshot): LintFinding[] {
  const findings: LintFinding[] = [];
  const generic: Record<string, boolean> = {
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
    "-apple-system": true,
    blinkmacsystemfont: true,
    math: true,
    emoji: true,
  };
  const near = (list: number[], n: number): boolean => list.some((v) => Math.abs(v - n) <= 0.5);
  /** One finding for a kind: the off-token values, most used first, named with their counts. */
  const report = (id: string, off: SystemUse[], unit: string, fix: string): void => {
    if (!off.length) return;
    off.sort((a, b) => b.count - a.count);
    const named = off.slice(0, 3).map((u) => `${u.value}${unit} (${u.count})`).join(", ");
    const total = off.reduce((n, u) => n + u.count, 0);
    findings.push({ rule: "slop", id, selector: off[0]!.selector, detail: `${named} on ${total} elements not in system/tokens.css: ${fix}` });
  };

  // Font outside the system: a first family no --font-* token starts with.
  if (s.fonts.length) {
    report(
      "token-font",
      s.usedFonts.filter((u) => !generic[u.value] && !/icon|symbol|awesome/.test(u.value) && s.fonts.indexOf(u.value) === -1),
      "",
      "use the --font-* tokens",
    );
  }
  // Text size outside the scale: neither a --text-* value nor inside a clamp() token's range.
  if (s.sizes.length || s.sizeRanges.length) {
    report(
      "token-size",
      s.usedSizes.filter((u) => {
        const n = Number.parseFloat(u.value);
        return !near(s.sizes, n) && !s.sizeRanges.some((r) => n >= r[0] - 0.5 && n <= r[1] + 0.5);
      }),
      "px",
      "use the --text-* scale",
    );
  }
  // Radius outside the scale: a corner no --radius-* token gives (pills pass when the system has a full radius).
  if (s.radii.length || s.pill) {
    report("token-radius", s.usedRadii.filter((u) => !near(s.radii, Number.parseFloat(u.value))), "px radius", "use the --radius-* tokens");
  }
  return findings;
}
