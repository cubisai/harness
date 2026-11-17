import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { KitManifest } from "./kit-schema";
import type { LintFinding } from "./lint";

/**
 * Kit grounding: a page on a kit may only use the parts, props and prop values its `components.json` declares, and
 * its own CSS mustn't redraw a part (a variant, prop or token does that). Read from the page's text, not the render,
 * so it is exact and costs no browser.
 */

type Node5 = DefaultTreeAdapterMap["node"];
type El5 = DefaultTreeAdapterMap["element"];
const isEl = (n: Node5): n is El5 => "attrs" in n;
const kids = (n: Node5): Node5[] => ("childNodes" in n ? n.childNodes : []);

function walk(n: Node5, out: El5[] = []): El5[] {
  for (const child of kids(n)) {
    if (isEl(child)) {
      out.push(child);
      walk(child, out);
    }
    const content = (child as { content?: Node5 }).content;
    if (content) walk(content, out);
  }
  return out;
}

/** Elements that are never page content: the coverage share leaves them out. */
const NOT_CONTENT = new Set(["html", "head", "body", "meta", "link", "title", "script", "style", "template", "br", "svg", "path", "g", "use", "symbol", "defs", "circle", "rect", "line", "polyline", "polygon", "ellipse", "stop", "lineargradient", "radialgradient", "clippath", "mask"]);

/** Declarations that redraw a part's look, as opposed to placing it on the page. */
const REDRAW = /(^|;)\s*(background(-color|-image)?|border(-radius|-color|-width|-style)?|box-shadow|color|font(-size|-weight|-family)?|padding(-[a-z]+)?|outline)\s*:/i;

/** The most findings of one kind the check returns, so a page full of one mistake stays readable. */
const MAX_EACH = 8;

export interface Grounding {
  findings: LintFinding[];
  /** Content elements on the page, and how many of them are the kit's parts (unknown `data-ui` values don't count). */
  elements: number;
  parts: number;
  /** Content elements that are a kit part or sit inside one that owns its contents: a table part's cells are the kit's too,
   * but what a layout part (stack, grid, section, slide) or a block wrapper holds needs parts of its own. */
  covered: number;
  /** Distinct parts used, most used first. */
  used: { ui: string; count: number }[];
}

/** Class names that mean a kit part by another name, when the kit has that part. */
const TWIN_ALIASES: Record<string, string> = { tag: "badge", chip: "badge", pill: "badge", meter: "progress", metric: "stat", kpi: "stat" };

/** Part categories whose names are too common as page classes to call a class of that name a hand-built twin. */
const NO_TWIN_CATEGORIES = new Set(["layout", "content"]);

/** Inside a known part of the kit (not counting `el` itself). */
function inPart(el: El5, known: ReadonlyMap<string, unknown>): boolean {
  for (let n = (el as { parentNode?: unknown }).parentNode; n && typeof n === "object" && "attrs" in n; n = (n as { parentNode?: unknown }).parentNode) {
    const ui = (n as El5).attrs.find((a) => a.name === "data-ui")?.value;
    if (ui && known.has(ui)) return true;
  }
  return false;
}

/** A deck scaffold's slide frame (`section.slide`, from deck.css): the kit's slide part goes inside it. */
const isSlideFrame = (el: El5): boolean => el.tagName === "section" && /(^|\s)slide(\s|$)/.test(el.attrs.find((a) => a.name === "class")?.value ?? "");

/** Elements kit parts are built on: a page rule that recolours one of these recolours every part made of it. */
const PART_ELEMENTS = new Set(["a", "button", "input", "select", "textarea", "label", "table", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "nav", "dialog", "details", "summary"]);

/** Declarations that recolour an element (a page element rule with one of these overrides the kit's parts). */
const LOOK = /(^|;)\s*(background(-color)?|border-color|color)\s*:/i;

/** A selector list split on its top-level commas (not the ones inside `:is(…)` or `:not(…)`). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  return [...out, cur];
}

/** Inside a kit part that is a picture (`data-ui` with `role="img"`, a QR code): its colours are the kit's. */
function inKitPicture(el: El5): boolean {
  for (let n: unknown = el; n && typeof n === "object" && "attrs" in n; n = (n as { parentNode?: unknown }).parentNode) {
    const attrs = (n as El5).attrs;
    if (attrs.some((a) => a.name === "data-ui") && attrs.some((a) => a.name === "role" && a.value === "img")) return true;
  }
  return false;
}

/** A literal colour in a declaration's value, outside a `var()` fallback. */
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/i;

/** Common CSS named colours: `background: white` is a literal just like `#fff`. */
const NAMED_COLORS = new Set(["white", "black", "red", "green", "blue", "yellow", "orange", "purple", "pink", "gray", "grey", "silver", "navy", "teal", "maroon", "olive", "lime", "aqua", "cyan", "magenta", "fuchsia", "brown", "gold", "beige", "ivory", "indigo", "violet", "crimson", "coral", "salmon", "tomato", "khaki", "lavender", "plum", "tan", "turquoise", "whitesmoke", "gainsboro", "lightgray", "lightgrey", "darkgray", "darkgrey", "dimgray", "dimgrey", "slategray", "slategrey", "snow", "linen", "wheat", "chocolate", "firebrick", "darkred", "darkblue", "darkgreen", "skyblue", "steelblue", "royalblue", "midnightblue"]);

/** Those names as one whole-word test, built once. */
const NAMED_COLOR = new RegExp(`\\b(?:${[...NAMED_COLORS].join("|")})\\b`, "i");

/** Properties that paint a colour, so a named colour there is a literal (a custom property is not one). */
const COLOR_PROPERTY = /^(?:color|background(?:-color|-image)?|border|border-color|border-(?:top|right|bottom|left)|border-[-a-z]+-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration|text-decoration-color|column-rule|column-rule-color)$/i;

/** The custom property names a stylesheet declares (`system/tokens.css`: the theme's tokens). */
export function tokenNamesIn(css: string): Set<string> {
  return new Set([...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9_-]+)\s*:/gi)].map((m) => m[1]!.toLowerCase()));
}

/**
 * Check a page's markup against its kit's manifest. `pageCss` is the page's own linked stylesheets (not `system/`),
 * checked with its inline `<style>`. `themeTokens` (the names in `system/tokens.css`) turns on the page-token check:
 * a page may re-set a theme token on `:root`, but a new name with a literal colour is a colour outside the theme.
 */
export function groundPage(html: string, manifest: KitManifest, pageCss = "", themeTokens?: ReadonlySet<string>): Grounding {
  const els = walk(parse(html));
  const byUi = new Map(manifest.components.map((c) => [c.ui, c]));
  const unknown = new Map<string, number>();
  const badValues = new Map<string, string>();
  const counts = new Map<string, number>();
  let elements = 0;
  let parts = 0;
  let covered = 0;
  const owners = new Map(manifest.components.filter((c) => c.kind !== "composition" && (c.category ?? "").toLowerCase() !== "layout").map((c) => [c.ui, c]));
  // Parts a page class can twin: the kit's components outside layout and type, never a composition or the plain link.
  const twinable = new Set(manifest.components.filter((c) => c.kind !== "composition" && c.ui !== "link" && !NO_TWIN_CATEGORIES.has((c.category ?? "").toLowerCase())).map((c) => c.ui));
  const twins = new Map<string, { count: number; example: string }>();
  // Elements already counted as a twin: a BEM child under one (`stat__n` in `.stat`) is that same twin, not another.
  const twinEls = new Set<unknown>();
  const underTwin = (el: El5): boolean => {
    for (let n = (el as { parentNode?: unknown }).parentNode; n; n = (n as { parentNode?: unknown }).parentNode) if (twinEls.has(n)) return true;
    return false;
  };
  let css = "";
  let svgLiterals = 0;
  let svgExample = "";
  for (const el of els) {
    if (el.tagName === "style") css += kids(el).map((c) => ("value" in c ? String(c.value) : "")).join("");
    for (const a of el.attrs) {
      if ((a.name !== "fill" && a.name !== "stroke" && a.name !== "stop-color") || !LITERAL_COLOR.test(a.value) || inKitPicture(el)) continue;
      svgLiterals += 1;
      svgExample ||= `<${el.tagName} ${a.name}="${a.value}">`;
    }
    if (NOT_CONTENT.has(el.tagName)) continue;
    elements += 1;
    const ui = el.attrs.find((a) => a.name === "data-ui")?.value;
    const owned = inPart(el, owners);
    if ((ui && byUi.has(ui)) || owned) covered += 1;
    if (!ui) {
      if (owned || isSlideFrame(el) || underTwin(el)) continue;
      const classes = (el.attrs.find((a) => a.name === "class")?.value ?? "").split(/\s+/).filter(Boolean);
      for (const cls of classes) {
        const root = cls.toLowerCase().split(/__|--/)[0]!;
        const twin = twinable.has(root) ? root : TWIN_ALIASES[root];
        if (!twin || !twinable.has(twin)) continue;
        const seen = twins.get(twin) ?? { count: 0, example: `${el.tagName}.${cls}` };
        seen.count += 1;
        twins.set(twin, seen);
        twinEls.add(el);
        break;
      }
      continue;
    }
    const part = byUi.get(ui);
    if (!part) {
      unknown.set(ui, (unknown.get(ui) ?? 0) + 1);
      continue;
    }
    parts += 1;
    counts.set(ui, (counts.get(ui) ?? 0) + 1);
    for (const prop of part.props) {
      if (prop.type !== "choice" || !prop.options) continue;
      const value = el.attrs.find((a) => a.name === `data-${prop.name}`)?.value;
      if (value === undefined || prop.options.includes(value)) continue;
      badValues.set(`[data-ui="${ui}"][data-${prop.name}="${value}"]`, `data-${prop.name}="${value}" isn't a value of ${ui}: use ${prop.options.join(" | ")}`);
    }
  }

  const findings: LintFinding[] = [];
  const names = manifest.components.map((c) => c.ui);
  for (const [ui, n] of [...unknown].slice(0, MAX_EACH)) {
    const near = names.filter((name) => name.includes(ui) || ui.includes(name) || distance(name, ui) <= 2).slice(0, 3);
    findings.push({
      rule: "kit",
      id: "unknown-part",
      selector: `[data-ui="${ui}"]`,
      detail: `${manifest.name} has no part "${ui}" (${n}×)${near.length ? `; did you mean ${near.join(", ")}?` : ""}. Use a part from design_kit_inspect, or plain HTML with page CSS.`,
    });
  }
  for (const [selector, detail] of [...badValues].slice(0, MAX_EACH)) findings.push({ rule: "kit", id: "bad-prop", selector, detail });
  for (const [ui, { count, example }] of [...twins].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_EACH)) {
    findings.push({
      rule: "kit",
      id: "hand-built-part",
      selector: example,
      detail: `${example}${count > 1 ? ` ×${count}` : ""} is built by hand, and ${manifest.name} has a ${ui} part: use data-ui="${ui}" (design_kit_inspect component:"${ui}"), so it follows the theme and the kit.`,
    });
  }
  // Deck slides whose body isn't the kit's slide part: the part lays the kit's parts out at slide size.
  if (byUi.has("slide")) {
    const frames = els.filter(isSlideFrame);
    const bare = frames.filter((f) => !walk(f).some((d) => d.attrs.some((a) => a.name === "data-ui" && a.value === "slide")));
    if (bare.length) {
      findings.push({
        rule: "kit",
        id: "slide-body",
        selector: "section.slide",
        detail: `${bare.length} of ${frames.length} slide${frames.length === 1 ? "" : "s"} ha${bare.length === 1 ? "s" : "ve"} no ${manifest.name} slide body inside: put <div data-ui="slide"> in each section.slide and build it from the kit's parts (design_kit_inspect block:"slide-content").`,
      });
    }
  }

  css += pageCss;
  let redraws = 0;
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    const hit = /\[data-ui\s*[~^|*$]?=\s*["']?([a-z0-9-]+)/i.exec(selector);
    if (!hit || !byUi.has(hit[1]!) || !REDRAW.test(m[2]!)) continue;
    if (redraws++ >= MAX_EACH) break;
    findings.push({
      rule: "kit",
      id: "redraw-part",
      selector: selector.slice(0, 120),
      detail: `page CSS redraws the kit's ${hit[1]}: use its props (design_kit_inspect component:"${hit[1]}") or a token instead, so it follows theme changes.`,
    });
  }

  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hasLiteral = (d: string): boolean => {
    if (!d.includes(":")) return false;
    const at = d.indexOf(":");
    const value = d.slice(at + 1).replace(/var\([^()]*(\([^()]*\))?[^()]*\)/g, "");
    if (LITERAL_COLOR.test(value)) return true;
    // A named colour only counts in a property that paints, and a URL's file name is not a colour.
    return COLOR_PROPERTY.test(d.slice(0, at).trim()) && NAMED_COLOR.test(value.replace(/url\([^)]*\)/gi, ""));
  };
  let literals = 0;
  let pageTokens = 0;
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    if (selector.startsWith("@")) continue;
    const root = /^(?::root|html)\b/i.test(selector);
    // With the theme's names known, a custom property anywhere (`:root`, `.deck`) is a token: a new one with a literal
    // is a colour outside the theme.
    const tokens = Boolean(themeTokens?.size);
    if (tokens && themeTokens) {
      for (const d of m[2]!.split(";")) {
        const name = /^\s*(--[a-z0-9_-]+)\s*:/i.exec(d)?.[1]?.toLowerCase();
        if (!name || themeTokens.has(name) || !hasLiteral(d)) continue;
        if (pageTokens++ >= MAX_EACH) break;
        findings.push({
          rule: "kit",
          id: "page-token",
          selector: selector.slice(0, 120),
          detail: `page CSS makes a new colour token (${d.trim().slice(0, 60)}), a colour outside the theme. Point it at the theme (${name}: var(--color-text), or color-mix() of tokens), or re-set one of the theme's own tokens (--color-accent) for this page.`,
        });
      }
    }
    // Custom properties were checked as tokens above (on :root only, without the theme's names); the rest are literals.
    const decl = m[2]!.split(";").find((d) => hasLiteral(d) && !((tokens || root) && /^\s*--/.test(d)));
    if (!decl) continue;
    if (literals++ >= MAX_EACH) break;
    findings.push({
      rule: "kit",
      id: "literal-color",
      selector: selector.slice(0, 120),
      detail: `page CSS uses a literal colour (${decl.trim().slice(0, 60)}): use a --color-* token so it follows the theme.`,
    });
  }
  let resets = 0;
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    // A bare element (optionally :hover and the like); `button:not([data-ui], [data-ui] *)` or `.cta button` leaves parts alone.
    const bare = splitSelectors(selector).map((x) => x.trim().replace(/(?::(?:hover|focus|focus-visible|focus-within|active|visited|link|disabled|first-child|last-child))+$/i, ""));
    if (!bare.some((t) => PART_ELEMENTS.has(t.toLowerCase())) || !LOOK.test(m[2]!)) continue;
    if (resets++ >= MAX_EACH) break;
    findings.push({
      rule: "kit",
      id: "element-recolor",
      selector: selector.slice(0, 120),
      detail: `this element rule also hits the kit's parts and wins over them (page CSS beats @layer cubiq-ui), e.g. button text the same colour as its background. Leave parts out: ${bare.find((t) => PART_ELEMENTS.has(t.toLowerCase()))}:not([data-ui], [data-ui] *), or a class.`,
    });
  }

  if (svgLiterals) {
    findings.push({
      rule: "kit",
      id: "literal-color",
      selector: "svg",
      detail: `inline SVG paints ${svgLiterals} shape${svgLiterals === 1 ? "" : "s"} with a literal colour (${svgExample.slice(0, 60)}): use fill="var(--color-…)" or currentColor, so it follows the theme.`,
    });
  }

  // A deck page (slides in a full document) needs the scaffold's runtime, or it shows every slide at once with no keys.
  const slides = els.filter((el) => el.tagName === "section" && /(^|\s)slide(\s|$)/.test(el.attrs.find((a) => a.name === "class")?.value ?? "")).length;
  const runtime = els.some((el) => el.tagName === "script" && /(^|\/)deck\.js$/i.test((el.attrs.find((a) => a.name === "src")?.value ?? "").split(/[?#]/)[0]!));
  if (slides && !runtime && /<html[\s>]/i.test(html)) {
    findings.push({
      rule: "kit",
      id: "deck-runtime",
      selector: "section.slide",
      detail: `this deck (${slides} slide${slides === 1 ? "" : "s"}) doesn't load deck.js, so slides don't scale or step. Copy deck.js and deck.css from design-build's assets next to the page, unchanged, and add <script src="deck.js"></script> before </body>.`,
    });
  }

  const used = [...counts].map(([ui, count]) => ({ ui, count })).sort((a, b) => b.count - a.count || a.ui.localeCompare(b.ui));
  return { findings, elements, parts, covered, used };
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** One line on how much of the page is built from the kit. */
export function groundingSummary(g: Grounding, kitName: string): string {
  if (!g.parts) return `Kit: no ${kitName} parts on this page (${g.elements} elements). Build from its parts: design_kit_inspect lists them.`;
  const pct = g.elements ? Math.round((g.covered / g.elements) * 100) : 0;
  const top = g.used.slice(0, 8).map((u) => `${u.ui}×${u.count}`).join(", ");
  const low = pct < 25 ? " Most of the page is hand-built: swap in the parts the kit has (design_kit_inspect)." : "";
  return `Kit: ${pct}% of ${g.elements} elements are in ${kitName} parts (${g.parts} part${g.parts === 1 ? "" : "s"}: ${top}${g.used.length > 8 ? ", …" : ""}).${low}`;
}
