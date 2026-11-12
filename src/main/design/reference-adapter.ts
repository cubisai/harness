// Turns one GradientDeck reference (its Markdown) into a Foundation tokens.css: colour roles
// read from the reference's own role prose, the missing ones derived, a second scheme derived,
// every contrast pair repaired by lightness alone, and fonts mapped onto the bundled OFL faces.
// Deterministic: the same text and base always give the same bytes. The Markdown is untrusted
// data; nothing from it reaches the CSS except validated colours, sizes and shadow values.

import { contrast, fromOklch, mix, parseHex, repairContrast, toHex, toOklch, type Oklch, type Rgb } from "./oklch";
import { setToken } from "./tokens";

export type Scheme = "light" | "dark";
export type RoleConfidence = "role-text" | "luminance" | "derived" | "default";

/** The colour roles Foundation's tokens.css defines, without the `--color-` prefix. */
export const COLOR_ROLES = [
  "bg", "surface", "surface-2", "surface-3", "text", "text-muted", "border", "border-strong",
  "primary", "on-primary", "accent", "on-accent", "accent-text", "accent-soft",
  "success", "success-soft", "warning", "warning-soft", "danger", "danger-soft", "focus",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

/** The pairs every scheme must pass, the same 17 the style contrast test checks. */
export const CONTRAST_PAIRS: readonly [ColorRole, ColorRole, number][] = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["text", "surface-2", 4.5],
  ["text-muted", "bg", 4.5],
  ["text-muted", "surface", 4.5],
  ["on-primary", "primary", 4.5],
  ["on-accent", "accent", 4.5],
  ["accent-text", "bg", 4.5],
  ["accent-text", "surface", 4.5],
  ["accent-text", "accent-soft", 4.5],
  ["success", "surface", 4.5],
  ["warning", "surface", 4.5],
  ["danger", "surface", 4.5],
  ["success", "success-soft", 4.5],
  ["warning", "warning-soft", 4.5],
  ["danger", "danger-soft", 4.5],
  ["border-strong", "surface", 3],
];

export type RoleSource = { value: string; from: string | null; confidence: RoleConfidence };
export type ContrastFix = { scheme: Scheme; role: ColorRole; against: ColorRole; from: string; to: string; need: number };
export type FontChoice = { slot: "sans" | "display" | "mono"; original: string | null; face: string; match: "exact" | "substituted" | "system" };

export interface AdaptReport {
  name: string;
  /** The reference's own theme line. */
  theme: "light" | "dark" | "mixed";
  /** The scheme the reference's colours describe; the other one is derived. */
  native: Scheme;
  /** Which scheme sits in `:root` of `tokensCss`. */
  base: Scheme;
  /** Where each colour role of the native scheme came from. */
  roles: Record<ColorRole, RoleSource>;
  contrastFixes: ContrastFix[];
  fonts: FontChoice[];
  notes: string[];
}

export interface AdaptResult {
  tokensCss: string;
  light: Record<ColorRole, string>;
  dark: Record<ColorRole, string>;
  /** Bundled font files (names in `resources/design-fonts`) the CSS declares from `fonts/`. */
  fontFiles: string[];
  report: AdaptReport;
}

export interface AdaptOptions {
  /** Foundation's tokens.css: every token it defines is kept, and only the adapted ones change. */
  baseCss: string;
  /** Which scheme goes in `:root`. Defaults to the native one; a dark-native reference then ships dark only. */
  appearance?: Scheme;
}

// ---------------------------------------------------------------------------------------------
// Markdown parsing

type Section = { title: string; depth: number; body: string[] };
type SourceColor = { name: string; hex: string; rgb: Rgb; lch: Oklch; role: string; order: number };
type SurfaceRow = { level: number; name: string; rgb: Rgb; hex: string; purpose: string };
type Family = { name: string; role: string; substitute: string; weights: number[] };
type ScaleRow = { role: string; size: number; lineHeight: number | null; trackingEm: number | null; weight: number | null };

export interface ParsedReference {
  name: string;
  theme: "light" | "dark" | "mixed";
  colors: SourceColor[];
  surfaces: SurfaceRow[];
  quick: { label: string; rgb: Rgb; hex: string }[];
  families: Family[];
  scale: ScaleRow[];
  radii: { element: string; px: number }[];
  shadows: { label: string; value: string }[];
  flat: boolean;
  maxWidth: number | null;
}

/** Every heading's lines, outside code fences; text before the first heading is under depth 0. */
function sectionsOf(text: string): Section[] {
  const out: Section[] = [{ title: "", depth: 0, body: [] }];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) out.push({ title: heading[2]!, depth: heading[1]!.length, body: [] });
    else out[out.length - 1]!.body.push(line);
  }
  return out;
}

/** A section's lines plus its subsections', found by a `##` title (with or without "Tokens — "). */
function sectionLines(sections: Section[], titles: RegExp): string[] {
  const at = sections.findIndex((s) => s.depth === 2 && titles.test(s.title.replace(/^Tokens\s*[—–-]\s*/u, "")));
  if (at < 0) return [];
  const lines: string[] = [];
  for (let i = at + 1; i < sections.length && sections[i]!.depth > 2; i++) lines.push(`${"#".repeat(sections[i]!.depth)} ${sections[i]!.title}`, ...sections[i]!.body);
  return [...sections[at]!.body, ...lines];
}

const cell = (s: string): string => s.trim().replace(/^`+|`+$/g, "").trim();

/** The rows of every Markdown table in `lines`, keyed by lowercased header. */
function tables(lines: string[]): Record<string, string>[][] {
  const out: Record<string, string>[][] = [];
  let header: string[] | null = null;
  let rows: Record<string, string>[] = [];
  const flush = (): void => {
    if (header && rows.length) out.push(rows);
    header = null;
    rows = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      flush();
      continue;
    }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell);
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const row: Record<string, string> = {};
    header.forEach((key, i) => (row[key] = cells[i] ?? ""));
    rows.push(row);
  }
  flush();
  return out;
}

const px = (s: string | undefined): number | null => {
  const m = /^(-?[\d.]+)\s*(px)?$/i.exec((s ?? "").trim());
  return m ? Number(m[1]) : null;
};

export function parseReference(text: string): ParsedReference {
  const sections = sectionsOf(text);
  const name = (sections.find((s) => s.depth === 1)?.title ?? "Reference").replace(/\s*[—–-]\s*Style Reference\s*$/i, "").trim();
  const intro = sections.slice(0, 2).flatMap((s) => s.body).join("\n");
  const themeWord = /\*\*Theme:\*\*\s*(light|dark|mixed)/i.exec(intro)?.[1]?.toLowerCase();
  const theme = themeWord === "dark" || themeWord === "mixed" ? themeWord : "light";

  const colors: SourceColor[] = [];
  for (const table of tables(sectionLines(sections, /^Colou?rs$/i))) {
    for (const row of table) {
      const rgb = parseHex(row.value ?? "");
      if (!rgb) continue;
      colors.push({ name: row.name ?? "", hex: toHex(rgb), rgb, lch: toOklch(rgb), role: row.role ?? "", order: colors.length });
    }
  }

  const surfaces: SurfaceRow[] = [];
  for (const table of tables(sectionLines(sections, /^Surfaces$/i))) {
    for (const row of table) {
      const rgb = parseHex(row.value ?? "");
      if (!rgb) continue;
      surfaces.push({ level: Number(row.level) || surfaces.length, name: row.name ?? "", rgb, hex: toHex(rgb), purpose: row.purpose ?? "" });
    }
  }
  surfaces.sort((a, b) => a.level - b.level);

  // The quick reference: a heading or a bold line, then "- label: #hex" bullets.
  const quick: ParsedReference["quick"] = [];
  const lines = text.split(/\r?\n/);
  const marker = lines.findIndex((l) => /^\s*(#{2,4}\s+|\*\*)Quick Colou?r Reference(\*\*)?\s*$/i.test(l));
  if (marker >= 0) {
    for (const line of lines.slice(marker + 1, marker + 40)) {
      if (!line.trim()) continue;
      const m = /^\s*[-*]\s*([^:]{1,60}):\s*`?(#[0-9a-fA-F]{3,8})\b/.exec(line);
      if (!m) {
        if (/^\s*[-*]\s/.test(line)) continue;
        break;
      }
      const rgb = parseHex(m[2]!);
      if (rgb) quick.push({ label: m[1]!.trim(), rgb, hex: toHex(rgb) });
    }
  }

  const typography = sectionLines(sections, /^Typography$/i);
  const families: Family[] = [];
  let current: Family | null = null;
  for (const line of typography) {
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      current = null;
      const title = heading[1]!;
      if (/^Type Scale$/i.test(title)) continue;
      const [familyName, ...rest] = title.split(/\s+[—–]\s+/u);
      current = { name: (familyName ?? "").trim(), role: rest.join(" — ").replace(/\s*·\s*`[^`]*`\s*$/, ""), substitute: "", weights: [] };
      families.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^\s*-\s*\*\*([^*]+):\*\*\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1]!.toLowerCase();
    if (key === "substitute") current.substitute = field[2]!;
    else if (key === "weights") current.weights = (field[2]!.match(/\d{3}/g) ?? []).map(Number);
    else if (key === "role" && !current.role) current.role = field[2]!;
  }

  const scale: ScaleRow[] = [];
  for (const table of tables(typography)) {
    for (const row of table) {
      const size = px(row.size);
      if (row.role === undefined || size === null || size <= 0) continue;
      const lh = Number((row["line height"] ?? "").trim());
      const ls = (row["letter spacing"] ?? "").trim();
      const lsPx = /^(-?[\d.]+)px$/i.exec(ls);
      const lsEm = /^(-?[\d.]+)em$/i.exec(ls);
      const trackingEm = lsPx ? Number(lsPx[1]) / size : lsEm ? Number(lsEm[1]) : null;
      const weight = Number(row.weight);
      scale.push({ role: row.role.toLowerCase(), size, lineHeight: Number.isFinite(lh) && lh > 0 ? lh : null, trackingEm, weight: Number.isFinite(weight) && weight >= 100 ? weight : null });
    }
  }

  const shapes = sectionLines(sections, /^Spacing\s*(&|and)\s*(Shapes|Layout)$/i);
  const radii: ParsedReference["radii"] = [];
  for (const table of tables(shapes)) {
    for (const row of table) {
      const value = px(row.value);
      if (row.element !== undefined && value !== null && value >= 0) radii.push({ element: row.element.toLowerCase(), px: value });
    }
  }
  const maxLine = shapes.find((l) => /\*\*Page max-width:\*\*/i.test(l));
  const maxWidth = maxLine ? px(/:\*\*\s*([\d.]+px)/.exec(maxLine)?.[1]) : null;

  const elevation = sectionLines(sections, /^Elevation$/i);
  const shadows: ParsedReference["shadows"] = [];
  for (const line of elevation) {
    const m = /^\s*-\s*\*\*([^*]+):\*\*\s*`([^`]+)`/.exec(line);
    if (m) shadows.push({ label: m[1]!.trim(), value: m[2]!.trim() });
  }
  for (const table of tables(elevation)) {
    for (const row of table) {
      const value = row.value ?? row.shadow ?? "";
      if (/\d+px/.test(value)) shadows.push({ label: row.name ?? row.level ?? "", value });
    }
  }
  if (!shadows.length) {
    for (const m of text.matchAll(/^\s*--shadow-([\w-]+):\s*([^;{}\n]+);/gm)) shadows.push({ label: m[1]!, value: m[2]!.trim() });
  }
  const elevationText = elevation.join(" ");
  const flat = !shadows.length && /\b(no|avoids?|without|rejects?|rejected|zero)\b[^.]{0,30}\bshadows?\b|\bshadow-?less\b|\bflat\b[^.]{0,20}\b(design|surfaces?|system)\b|elevation is (rejected|absent|not used)/i.test(elevationText);

  return { name, theme, colors, surfaces, quick, families, scale, radii, shadows, flat, maxWidth };
}

// ---------------------------------------------------------------------------------------------
// Colour roles

/** Foundation's own values, used only when a reference gives nothing for a role. */
const FOUNDATION: Record<Scheme, Record<ColorRole, string>> = {
  light: {
    bg: "#ffffff", surface: "#fafafa", "surface-2": "#f3f3f4", "surface-3": "#ebebec", text: "#18181b", "text-muted": "#5c5c66",
    border: "#e4e4e7", "border-strong": "#a1a1aa", primary: "#27272a", "on-primary": "#ffffff", accent: "#3b5bdb", "on-accent": "#ffffff",
    "accent-text": "#2f49b8", "accent-soft": "#eef1fc", success: "#15803d", "success-soft": "#edf7f1", warning: "#9a5b00",
    "warning-soft": "#fbf4e8", danger: "#b42318", "danger-soft": "#fdf0ef", focus: "#3b5bdb",
  },
  dark: {
    bg: "#0c0c0e", surface: "#131316", "surface-2": "#1a1a1e", "surface-3": "#232328", text: "#f2f2f4", "text-muted": "#a1a1ab",
    border: "#2a2a30", "border-strong": "#5a5a64", primary: "#f2f2f4", "on-primary": "#18181b", accent: "#7c93f5", "on-accent": "#0c0c0e",
    "accent-text": "#a5b6fa", "accent-soft": "#1b2240", success: "#5bc48a", "success-soft": "#15291e", warning: "#e0aa55",
    "warning-soft": "#2b2416", danger: "#f5887d", "danger-soft": "#2e1b1a", focus: "#a5b6fa",
  },
};

const rgbOf = (hex: string): Rgb => parseHex(hex)!;
const fits = (scheme: Scheme, c: Rgb): boolean => (scheme === "light" ? toOklch(c).l >= 0.84 : toOklch(c).l <= 0.34);
const CHROMATIC = 0.06;

type Pick = { rgb: Rgb; from: string | null; confidence: RoleConfidence };
/** The roles read or derived before the second scheme and the contrast repair. */
type Core = { bg: Pick; surfaces: Pick[]; text: Pick; muted: Pick; border: Pick; borderStrong: Pick; primary: Pick; accent: Pick; accentSoft: Pick | null };

const NEGATED_ACTION =
  /\b(do not|don't|never|not)\b[^.;|]{0,30}\b(promote|use|used|as)?\b[^.;|]{0,24}\b(cta|primary|fills?|buttons?|backgrounds?)\b|\bnever (as )?(a )?(fill|background)/i;

/** A role's keyword rules: the strongest that matches scores, in table order on ties. */
function score(text: string, rules: [RegExp, number][]): number {
  let best = 0;
  for (const [re, weight] of rules) if (re.test(text)) best = Math.max(best, weight);
  return best;
}

const BG_RULES: [RegExp, number][] = [
  [/\b(page|site|body|main|default|primary|base|app|global)\s+(canvas|background|bg|surface)\b/i, 10],
  [/\bcanvas\b|\bpage background\b/i, 8],
  [/\bbackground\b/i, 4],
];
const SURFACE_RULES: [RegExp, number][] = [
  [/\b(card|panel|section|band|banding|well|container|tile|sheet|modal|elevated|raised|inset)\b/i, 8],
  [/\bsurface\b/i, 6],
  [/\bbackground\b|\bfooter\b/i, 3],
];
const TEXT_RULES: [RegExp, number][] = [
  [/\b(primary|main|body|default|base|heading|headline|running)s?\s+(text|copy|type|ink|colou?r for text)\b|\btext primary\b|\bheadings? and body\b|\bbody (copy|paragraphs?)\b|\ball (text|type|copy)\b/i, 10],
  [/\bheadings?\b|\bheadlines?\b|\bbody\b/i, 6],
  [/\btext\b|\bink\b|\bcopy\b|\btype\b/i, 3],
];
const MUTED_RULES: [RegExp, number][] = [
  [/\b(secondary|muted|tertiary|supporting|subdued|helper|meta(data)?|caption|subtle|dim|quiet|de-?emphasi[sz]ed|low-emphasis|grey|gray)\b[^.;|]{0,30}\b(text|copy|labels?|type|body)\b/i, 10],
  [/\b(text|copy)\b[^.;|]{0,20}\b(secondary|muted|tertiary)\b|\bcaptions?\b|\bmetadata\b|\bhelper\b|\bplaceholder\b/i, 6],
  [/\bsecondary\b|\bmuted\b|\btertiary\b/i, 3],
];
const BORDER_RULES: [RegExp, number][] = [
  [/\b(borders?|dividers?|hairlines?|rules?|separators?|keylines?)\b/i, 10],
  [/\b(outlines?|strokes?)\b/i, 5],
];
const PRIMARY_RULES: [RegExp, number][] = [
  [/\b(primary|main|key)\s+(action|cta|button|call)|\bctas?\b|call[- ]to[- ]action|\bfilled (button|cta|action)s?\b|\bbutton (fills?|backgrounds?)\b|\baction colou?r\b|\bconversion\b/i, 10],
  [/\bbuttons?\b|\binteractive\b|\bactionable\b/i, 5],
  [/\bbrand\b/i, 3],
];
const ACCENT_RULES: [RegExp, number][] = [
  [/\baccents?\b|\blinks?\b|\bhighlights?\b/i, 10],
  [/\bemphasi[sz]|\bfocus|\bselected\b|\bactive\b|\btags?\b|\bbadges?\b|\bbrand\b/i, 5],
];
const SOFT_RULES: [RegExp, number][] = [[/\b(wash|tint|tinted|soft|pale|light)\b[^.;|]{0,30}\b(background|surface|fill|chip|pill|tag|badge|block)s?\b/i, 10]];

// Quick-reference labels, as the corpus writes them ("background (canvas)", "text (primary)", "primary action").
const QUICK_BG = /^(page |main |site )?(background|canvas|bg)( \((canvas|page|light|base)\))?$|^background canvas$/i;
const QUICK_SURFACE = /^(card )?surface(\/card)?$|^card( surface| background)?$|^background \(card\)$|^secondary surface$|^background band$/i;
const QUICK_TEXT = /^(text|text \((primary|body|main)\)|text primary|primary text|body text|heading text|text \/ ink)$/i;
const QUICK_MUTED = /^(muted text|text \((secondary|muted)\)|secondary text|text (secondary|muted)|muted)$/i;
const QUICK_BORDER = /^(border|borders?( \/ |\/)?(divider|hairline)s?|border \((hairline|default|subtle)\)|divider|hairline)$/i;
const QUICK_PRIMARY = /^primary( action| cta| button)?$|^cta$/i;
const QUICK_ACCENT = /^(accent|link|accent \/ link|link \/ accent)$/i;

const pick = (rgb: Rgb, from: string | null, confidence: RoleConfidence): Pick => ({ rgb, from, confidence });

/** The best-scoring colour that passes `ok`, or null; ties go to the earlier row. */
function bestBy(colors: SourceColor[], rules: [RegExp, number][], ok: (c: SourceColor) => boolean, tieBreak?: (c: SourceColor) => number): SourceColor | null {
  let best: SourceColor | null = null;
  let bestScore = 0;
  let bestTie = -Infinity;
  for (const color of colors) {
    if (!ok(color)) continue;
    const s = score(color.role, rules) || score(color.name, rules) / 2;
    if (s <= 0) continue;
    const tie = tieBreak ? tieBreak(color) : -color.order;
    if (s > bestScore || (s === bestScore && tie > bestTie)) {
      best = color;
      bestScore = s;
      bestTie = tie;
    }
  }
  return best;
}

function readCore(ref: ParsedReference, scheme: Scheme): Core {
  const colors = ref.colors;
  const quick = (re: RegExp): ParsedReference["quick"][number] | undefined => ref.quick.find((q) => re.test(q.label));

  // Background: the quick reference, the surfaces table, role prose, then the lightness extreme.
  let bg: Pick | null = null;
  const qbg = quick(QUICK_BG);
  if (qbg && fits(scheme, qbg.rgb)) bg = pick(qbg.rgb, qbg.label, "role-text");
  if (!bg) {
    const row = ref.surfaces.find((s) => fits(scheme, s.rgb));
    if (row) bg = pick(row.rgb, row.name, "role-text");
  }
  if (!bg) {
    const c = bestBy(colors, BG_RULES, (c) => fits(scheme, c.rgb));
    if (c) bg = pick(c.rgb, c.name, "role-text");
  }
  if (!bg) {
    const fitting = colors.filter((c) => fits(scheme, c.rgb)).sort((a, b) => a.lch.c - b.lch.c || (scheme === "light" ? b.lch.l - a.lch.l : a.lch.l - b.lch.l));
    if (fitting[0]) bg = pick(fitting[0].rgb, fitting[0].name, "luminance");
  }
  bg ??= pick(rgbOf(FOUNDATION[scheme].bg), null, "default");
  const bgL = toOklch(bg.rgb).l;
  const bgHex = toHex(bg.rgb);

  // Text: role prose with enough contrast, else the most contrasting neutral.
  let text: Pick | null = null;
  const qtext = quick(QUICK_TEXT);
  if (qtext && contrast(qtext.rgb, bg.rgb) >= 3) text = pick(qtext.rgb, qtext.label, "role-text");
  if (!text) {
    const c = bestBy(colors, TEXT_RULES, (c) => contrast(c.rgb, bg!.rgb) >= 3 && c.lch.c < 0.16, (c) => contrast(c.rgb, bg!.rgb));
    if (c) text = pick(c.rgb, c.name, "role-text");
  }
  if (!text) {
    const c = [...colors].filter((c) => c.lch.c < 0.08).sort((a, b) => contrast(b.rgb, bg!.rgb) - contrast(a.rgb, bg!.rgb))[0];
    if (c && contrast(c.rgb, bg.rgb) >= 4.5) text = pick(c.rgb, c.name, "luminance");
  }
  text ??= pick(rgbOf(FOUNDATION[scheme].text), null, "default");
  const textContrast = contrast(text.rgb, bg.rgb);
  const textHex = toHex(text.rgb);

  // Surfaces: near the background on the same side, nearest first; the rest stepped towards the text.
  const near = (c: Rgb): boolean => Math.abs(toOklch(c).l - bgL) <= 0.14 && toOklch(c).c < 0.08 && toHex(c) !== bgHex;
  const surfaceCandidates: Pick[] = [];
  const seen = new Set<string>([bgHex]);
  for (const q of ref.quick.filter((q) => QUICK_SURFACE.test(q.label))) {
    if (near(q.rgb) && !seen.has(q.hex)) {
      seen.add(q.hex);
      surfaceCandidates.push(pick(q.rgb, q.label, "role-text"));
    }
  }
  for (const row of ref.surfaces) {
    if (near(row.rgb) && !seen.has(row.hex)) {
      seen.add(row.hex);
      surfaceCandidates.push(pick(row.rgb, row.name, "role-text"));
    }
  }
  for (const c of colors) {
    if (near(c.rgb) && !seen.has(c.hex) && score(c.role, SURFACE_RULES) > 0 && score(c.role, BORDER_RULES) < 10) {
      seen.add(c.hex);
      surfaceCandidates.push(pick(c.rgb, c.name, "role-text"));
    }
  }
  surfaceCandidates.sort((a, b) => Math.abs(toOklch(a.rgb).l - bgL) - Math.abs(toOklch(b.rgb).l - bgL));
  const surfaces: Pick[] = surfaceCandidates.slice(0, 3);
  // Missing tiers step towards the text at Foundation's own lightness steps, with a floor that still shows on near-black.
  const towardsText = toOklch(text.rgb).l > bgL ? 1 : -1;
  const bgLch = toOklch(bg.rgb);
  const tierL = (i: number): number =>
    towardsText > 0 ? Math.max(bgL + [0.03, 0.06, 0.1][i]!, [0.17, 0.2, 0.24][i]!) : bgL - [0.015, 0.035, 0.06][i]!;
  while (surfaces.length < 3) {
    const i = surfaces.length;
    const last = surfaces[i - 1];
    let l = tierL(i);
    // Keep each tier further from the ground than the one before it.
    if (last && (l - toOklch(last.rgb).l) * towardsText <= 0.01) l = toOklch(last.rgb).l + towardsText * 0.025;
    surfaces.push(pick(fromOklch({ l, c: Math.min(bgLch.c, 0.04), h: bgLch.h }), null, "derived"));
  }

  // Muted text: secondary prose that still reads, else a mix of text into the background.
  let muted: Pick | null = null;
  const qmuted = quick(QUICK_MUTED);
  if (qmuted && contrast(qmuted.rgb, bg.rgb) >= 2.5 && qmuted.hex !== textHex) muted = pick(qmuted.rgb, qmuted.label, "role-text");
  if (!muted) {
    const c = bestBy(
      colors,
      MUTED_RULES,
      (c) => c.hex !== textHex && contrast(c.rgb, bg!.rgb) >= 2.5 && contrast(c.rgb, bg!.rgb) < textContrast && c.lch.c < 0.12,
      (c) => contrast(c.rgb, bg!.rgb),
    );
    if (c) muted = pick(c.rgb, c.name, "role-text");
  }
  muted ??= pick(mix(text.rgb, bg.rgb, 0.36), null, "derived");

  // Borders: a quiet neutral rule, and a strong one that shows on a surface.
  let border: Pick | null = null;
  const borderOk = (c: Rgb): boolean => toOklch(c).c < 0.08 && contrast(c, bg!.rgb) >= 1.08 && contrast(c, bg!.rgb) <= 2.6;
  const qborder = quick(QUICK_BORDER);
  if (qborder && borderOk(qborder.rgb)) border = pick(qborder.rgb, qborder.label, "role-text");
  if (!border) {
    const c = bestBy(colors, BORDER_RULES, (c) => borderOk(c.rgb), (c) => -Math.abs(contrast(c.rgb, bg!.rgb) - 1.3));
    if (c) border = pick(c.rgb, c.name, "role-text");
  }
  border ??= pick(mix(bg.rgb, text.rgb, 0.12), null, "derived");
  const strongC = bestBy(colors, BORDER_RULES, (c) => c.lch.c < 0.1 && contrast(c.rgb, surfaces[0]!.rgb) >= 2.4 && contrast(c.rgb, surfaces[0]!.rgb) < 4.5, (c) => -contrast(c.rgb, bg!.rgb));
  const borderStrong = strongC ? pick(strongC.rgb, strongC.name, "role-text") : pick(mix(bg.rgb, text.rgb, 0.42), null, "derived");

  // Primary: the action colour, never one the prose keeps off buttons; else the most saturated; else the text.
  const visible = (c: SourceColor): boolean => contrast(c.rgb, bg!.rgb) >= 1.4 && !NEGATED_ACTION.test(c.role);
  let primary: Pick | null = null;
  const qprimary = quick(QUICK_PRIMARY);
  if (qprimary && contrast(qprimary.rgb, bg.rgb) >= 1.4) primary = pick(qprimary.rgb, qprimary.label, "role-text");
  if (!primary) {
    // Prose that names the CTA outright wins even for a pale fill on a pale page (on-primary carries the label).
    const named = bestBy(colors, PRIMARY_RULES.slice(0, 1), (c) => c.hex !== bgHex && !NEGATED_ACTION.test(c.role));
    const c = named ?? bestBy(colors, PRIMARY_RULES, visible);
    if (c) primary = pick(c.rgb, c.name, "role-text");
  }
  if (!primary) {
    const c = colors.filter((c) => visible(c) && c.lch.c >= CHROMATIC).sort((a, b) => b.lch.c - a.lch.c)[0];
    if (c) primary = pick(c.rgb, c.name, "luminance");
  }
  primary ??= pick(text.rgb, text.from, "derived");
  const primaryHex = toHex(primary.rgb);

  // Accent: a chromatic highlight other than the primary; else the primary itself.
  const chromaticOther = (c: SourceColor): boolean => c.lch.c >= CHROMATIC && c.hex !== primaryHex && contrast(c.rgb, bg!.rgb) >= 1.3;
  let accent: Pick | null = null;
  const qaccent = quick(QUICK_ACCENT);
  if (qaccent && toOklch(qaccent.rgb).c >= CHROMATIC && qaccent.hex !== primaryHex) accent = pick(qaccent.rgb, qaccent.label, "role-text");
  if (!accent) {
    const c = bestBy(colors, ACCENT_RULES, chromaticOther);
    if (c) accent = pick(c.rgb, c.name, "role-text");
  }
  if (!accent && toOklch(primary.rgb).c >= CHROMATIC) accent = pick(primary.rgb, primary.from, "derived");
  if (!accent) {
    const c = colors.filter(chromaticOther).sort((a, b) => b.lch.c - a.lch.c)[0];
    if (c) accent = pick(c.rgb, c.name, "luminance");
  }
  accent ??= pick(primary.rgb, primary.from, "derived");

  // A soft accent wash the reference names itself: pale, on the background's side, near the accent's hue.
  const accentLch = toOklch(accent.rgb);
  const soft = bestBy(colors, SOFT_RULES, (c) => {
    const hueGap = Math.min(Math.abs(c.lch.h - accentLch.h), 360 - Math.abs(c.lch.h - accentLch.h));
    return Math.abs(c.lch.l - bgL) <= 0.12 && c.lch.c >= 0.012 && hueGap <= 40 && c.hex !== bgHex;
  }, (c) => c.lch.c);
  const accentSoft = soft ? pick(soft.rgb, soft.name, "role-text") : null;

  return { bg, surfaces, text, muted, border, borderStrong, primary, accent, accentSoft };
}

/** The other scheme's core: neutrals' lightness flipped (hue and chroma kept), colours kept vivid. */
function flipCore(core: Core, to: Scheme): Core {
  const flipNeutral = (p: Pick): Pick => {
    const lch = toOklch(p.rgb);
    const l = to === "dark" ? 0.15 + (1 - lch.l) * 1.025 : 1 - (lch.l - 0.15) / 1.025;
    return pick(fromOklch({ ...lch, l: Math.min(0.985, Math.max(0.1, l)), c: lch.c * (to === "dark" ? 0.85 : 1) }), p.from, "derived");
  };
  const flipColour = (p: Pick): Pick => {
    const lch = toOklch(p.rgb);
    if (lch.c < 0.04) return flipNeutral(p);
    const l = to === "dark" ? Math.min(0.85, Math.max(lch.l, 0.68)) : Math.max(0.38, Math.min(lch.l, 0.56));
    return pick(fromOklch({ ...lch, l }), p.from, "derived");
  };
  const bg = flipNeutral(core.bg);
  const bgL = toOklch(bg.rgb).l;
  // Flipped tiers can bunch up (light references step in hundredths); spread them to Foundation's minimum gaps.
  const gaps = to === "dark" ? [0.03, 0.06, 0.1] : [-0.015, -0.035, -0.06];
  const surfaces = core.surfaces.map(flipNeutral).map((p, i) => {
    const lch = toOklch(p.rgb);
    const min = bgL + gaps[i]!;
    const l = to === "dark" ? Math.max(lch.l, min) : Math.min(lch.l, min);
    return l === lch.l ? p : pick(fromOklch({ ...lch, l }), p.from, "derived");
  });
  /** `p` moved at least `gap` of lightness from the ground (upwards for a positive gap). */
  function spread(p: Pick, gap: number): Pick {
    const lch = toOklch(p.rgb);
    const l = gap > 0 ? Math.max(lch.l, bgL + gap) : Math.min(lch.l, bgL + gap);
    return l === lch.l ? p : pick(fromOklch({ ...lch, l }), p.from, "derived");
  }
  return {
    bg,
    surfaces,
    text: flipNeutral(core.text),
    muted: flipNeutral(core.muted),
    border: spread(flipNeutral(core.border), to === "dark" ? 0.12 : -0.08),
    borderStrong: flipNeutral(core.borderStrong),
    primary: flipColour(core.primary),
    accent: flipColour(core.accent),
    accentSoft: null,
  };
}

/** The pair that reads best on `fill`, preferring the scheme's own ground and text before pure white or black. */
function onColour(fill: Rgb, bg: Rgb, text: Rgb): Rgb {
  const own = [bg, text].filter((c) => contrast(c, fill) >= 4.5).sort((a, b) => contrast(b, fill) - contrast(a, fill))[0];
  if (own) return own;
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  return contrast(white, fill) >= contrast(black, fill) ? white : black;
}

/** Every role of one scheme from its core, with all 17 pairs repaired by lightness; fixes are logged. */
function completeScheme(core: Core, scheme: Scheme, fixes: ContrastFix[]): Record<ColorRole, string> {
  const soft = scheme === "light" ? 0.9 : 0.8;
  const roles: Record<ColorRole, Rgb> = {
    bg: core.bg.rgb,
    surface: core.surfaces[0]!.rgb,
    "surface-2": core.surfaces[1]!.rgb,
    "surface-3": core.surfaces[2]!.rgb,
    text: core.text.rgb,
    "text-muted": core.muted.rgb,
    border: core.border.rgb,
    "border-strong": core.borderStrong.rgb,
    primary: core.primary.rgb,
    "on-primary": core.primary.rgb,
    accent: core.accent.rgb,
    "on-accent": core.accent.rgb,
    "accent-text": core.accent.rgb,
    "accent-soft": core.accentSoft?.rgb ?? mix(core.accent.rgb, core.bg.rgb, soft),
    success: rgbOf(FOUNDATION[scheme].success),
    "success-soft": rgbOf(FOUNDATION[scheme].success),
    warning: rgbOf(FOUNDATION[scheme].warning),
    "warning-soft": rgbOf(FOUNDATION[scheme].warning),
    danger: rgbOf(FOUNDATION[scheme].danger),
    "danger-soft": rgbOf(FOUNDATION[scheme].danger),
    focus: toOklch(core.primary.rgb).c >= CHROMATIC ? core.primary.rgb : core.accent.rgb,
  };
  for (const status of ["success", "warning", "danger"] as const) roles[`${status}-soft`] = mix(roles[status], core.bg.rgb, scheme === "light" ? 0.92 : 0.84);
  roles["on-primary"] = onColour(roles.primary, roles.bg, roles.text);
  roles["on-accent"] = onColour(roles.accent, roles.bg, roles.text);

  // Repeat until stable: fixing one pair (accent-text on its soft wash) can undo another.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [fg, bg, need] of CONTRAST_PAIRS) {
      if (contrast(roles[fg], roles[bg]) >= need) continue;
      const fixed = fg === "on-primary" || fg === "on-accent" ? onColour(roles[bg], roles.bg, roles.text) : repairContrast(roles[fg], roles[bg], need);
      if (!fixed) continue;
      fixes.push({ scheme, role: fg, against: bg, from: toHex(roles[fg]), to: toHex(fixed), need });
      roles[fg] = fixed;
      changed = true;
    }
    if (!changed) break;
  }
  // The focus ring has to show on the page.
  const focus = repairContrast(roles.focus, roles.bg, 3);
  if (focus && toHex(focus) !== toHex(roles.focus)) {
    fixes.push({ scheme, role: "focus", against: "bg", from: toHex(roles.focus), to: toHex(focus), need: 3 });
    roles.focus = focus;
  }

  const out = {} as Record<ColorRole, string>;
  for (const role of COLOR_ROLES) out[role] = toHex(roles[role]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fonts

type Face = { family: string; file: string; weights: string; cls: "sans" | "serif" | "mono" | "display"; displayOnly?: boolean; italic?: string };

/** The bundled OFL faces (`resources/design-fonts`) the adapter can point at. */
export const FACES: Face[] = [
  { family: "Geist", file: "geist.woff2", weights: "100 900", cls: "sans" },
  { family: "Geist Mono", file: "geist-mono.woff2", weights: "100 900", cls: "mono" },
  { family: "JetBrains Mono", file: "jetbrains-mono.woff2", weights: "100 800", cls: "mono" },
  { family: "Martian Mono", file: "martian-mono.woff2", weights: "100 800", cls: "mono" },
  { family: "Overpass Mono", file: "overpass-mono.woff2", weights: "300 700", cls: "mono" },
  { family: "Hanken Grotesk", file: "hanken-grotesk.woff2", weights: "100 900", cls: "sans" },
  { family: "Schibsted Grotesk", file: "schibsted-grotesk.woff2", weights: "400 900", cls: "sans" },
  { family: "Public Sans", file: "public-sans.woff2", weights: "100 900", cls: "sans" },
  { family: "Onest", file: "onest.woff2", weights: "100 900", cls: "sans" },
  { family: "Sora", file: "sora.woff2", weights: "100 800", cls: "sans" },
  { family: "Archivo", file: "archivo.woff2", weights: "100 900", cls: "sans" },
  { family: "Chivo", file: "chivo.woff2", weights: "100 900", cls: "sans" },
  { family: "Overpass", file: "overpass.woff2", weights: "100 900", cls: "sans" },
  { family: "Bricolage Grotesque", file: "bricolage-grotesque.woff2", weights: "200 800", cls: "sans" },
  { family: "Fredoka", file: "fredoka.woff2", weights: "300 700", cls: "sans" },
  { family: "Chakra Petch", file: "chakra-petch.woff2", weights: "100 900", cls: "display", displayOnly: true },
  { family: "Big Shoulders Display", file: "big-shoulders-display.woff2", weights: "100 900", cls: "display", displayOnly: true },
  { family: "Unbounded", file: "unbounded.woff2", weights: "200 900", cls: "display", displayOnly: true },
  { family: "Michroma", file: "michroma.woff2", weights: "100 900", cls: "display", displayOnly: true },
  { family: "Pixelify Sans", file: "pixelify-sans.woff2", weights: "400 700", cls: "display", displayOnly: true },
  { family: "Source Serif 4", file: "source-serif-4.woff2", weights: "200 900", cls: "serif" },
  { family: "Literata", file: "literata.woff2", weights: "200 900", cls: "serif", italic: "literata-italic.woff2" },
  { family: "Bodoni Moda", file: "bodoni-moda.woff2", weights: "400 900", cls: "serif", displayOnly: true, italic: "bodoni-moda-italic.woff2" },
  { family: "Young Serif", file: "young-serif.woff2", weights: "400", cls: "serif", displayOnly: true },
  { family: "Gloock", file: "gloock.woff2", weights: "400", cls: "serif", displayOnly: true },
  { family: "Alfa Slab One", file: "alfa-slab-one.woff2", weights: "400", cls: "serif", displayOnly: true },
];

const SANS_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF_STACK = 'Georgia, "Times New Roman", serif';
const MONO_STACK = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const facesByName = new Map(FACES.map((f) => [f.family.toLowerCase(), f]));
const ALIASES: Record<string, string> = { "source serif pro": "Source Serif 4", "source serif": "Source Serif 4", "geist sans": "Geist", "bodoni": "Bodoni Moda", "big shoulders": "Big Shoulders Display", "alfa slab": "Alfa Slab One" };

/** A bundled face named in `text` (a font name or a substitute line), or null. */
function namedFace(text: string): Face | null {
  const t = text.toLowerCase();
  for (const face of FACES) if (new RegExp(`\\b${face.family.toLowerCase().replace(/\s+/g, "\\s*")}\\b`).test(t)) return face;
  for (const [alias, family] of Object.entries(ALIASES)) if (t.includes(alias)) return facesByName.get(family.toLowerCase()) ?? null;
  return null;
}

type Kind = "mono" | "system-serif" | "didone" | "soft-serif" | "slab" | "serif" | "rounded" | "condensed" | "wide" | "pixel" | "geometric" | "grotesk" | "humanist" | "neutral" | "unknown";

const KIND_RULES: [Kind, RegExp][] = [
  ["mono", /\bmono(space)?\b|\bcode\b|courier|consolas|menlo|\bplex mono\b/],
  ["pixel", /\bpixel|bitmap|8-?bit/],
  ["slab", /\bslab\b|rockwell|clarendon/],
  ["system-serif", /\btimes\b|\bgeorgia\b/],
  ["didone", /didot|bodoni|playfair|didone|high[- ]contrast|canela|\bogg\b|domaine|editorial new|migra|gt super|instrument serif|dm serif display/],
  ["soft-serif", /cooper|recoleta|fraunces|gelica|young serif|soft serif|warm serif/],
  ["serif", /(?<!sans[- ])\bserif\b|garamond|tiempos|\blyon\b|freight|caslon|baskerville|newsreader|merriweather|\blora\b|gt sectra|\bpp editorial|charter|tobias|signifier/],
  ["rounded", /\brounded\b|nunito|quicksand|fredoka|varela|comfortaa/],
  ["condensed", /condensed|compressed|\bnarrow\b|oswald|bebas|\banton\b|league gothic/],
  ["wide", /\bextended\b|\bexpanded\b|\bwide\b|monument|unbounded|syncopate|michroma/],
  ["geometric", /geometric|futura|circular|avenir|montserrat|poppins|satoshi|manrope|gilroy|product sans|gotham|proxima|\bcera\b|outfit|plus jakarta|general sans|urbanist|lexend|figtree|\beina\b|tt norms|apercu|euclid|object sans|\bsora\b|space grotesk/],
  ["grotesk", /grotesk|grotesque|s[öo]hne|neue montreal|suisse|graphik|aeonik|roobert|gt america|\bhaas\b|helvetica now|untitled sans|founders|favorit|whyte|lausanne|pp neue|haffer|\bmatter\b|mabry|diatype|gt standard|gtstandard|\babc\b/],
  ["humanist", /humanist|dm sans|open sans|source sans|noto sans|\blato\b|fira sans|plex sans|frutiger|myriad|\bgill\b|\bmuli\b/],
  ["neutral", /\binter\b|sf pro|-apple-system|system-ui|ui-sans|helvetica|arial|roboto|segoe|sans-serif|\bsystem\b/],
];

function kindOf(text: string): Kind {
  const t = text.toLowerCase();
  for (const [kind, re] of KIND_RULES) if (re.test(t)) return kind;
  return "unknown";
}

/** The face (or system stack) for one slot from a reference family. */
function chooseFace(family: Family | null, slot: FontChoice["slot"]): { stack: string; face: Face | null; choice: FontChoice } {
  const system = (stack: string, label: string): ReturnType<typeof chooseFace> => ({ stack, face: null, choice: { slot, original: family?.name ?? null, face: label, match: "system" } });
  if (!family) return slot === "mono" ? system(MONO_STACK, "system mono") : system(SANS_STACK, "system sans");

  const exact = namedFace(family.name);
  const usable = (f: Face | null): f is Face => !!f && (slot === "display" || !f.displayOnly) && (slot === "mono") === (f.cls === "mono");
  const stackFor = (f: Face): string => `"${f.family}", ${f.cls === "mono" ? MONO_STACK : f.cls === "serif" ? SERIF_STACK : SANS_STACK}`;
  if (usable(exact)) return { stack: stackFor(exact), face: exact, choice: { slot, original: family.name, face: exact.family, match: "exact" } };
  const viaSubstitute = namedFace(family.substitute);
  if (usable(viaSubstitute)) return { stack: stackFor(viaSubstitute), face: viaSubstitute, choice: { slot, original: family.name, face: viaSubstitute.family, match: "substituted" } };

  let kind = kindOf(family.name);
  // Role prose names other families too ("cuts the warmth of Gelica"), so only the name and substitute classify.
  if (kind === "unknown") kind = kindOf(family.substitute);
  const byKind: Partial<Record<Kind, string>> = {
    mono: "Geist Mono",
    didone: slot === "display" ? "Bodoni Moda" : "Source Serif 4",
    "soft-serif": slot === "display" ? "Young Serif" : "Literata",
    slab: slot === "display" ? "Alfa Slab One" : "Source Serif 4",
    serif: slot === "display" ? "Source Serif 4" : "Literata",
    rounded: "Fredoka",
    condensed: slot === "display" ? "Big Shoulders Display" : "Archivo",
    wide: slot === "display" ? "Unbounded" : "Archivo",
    pixel: slot === "display" ? "Pixelify Sans" : undefined,
    geometric: "Sora",
    grotesk: "Hanken Grotesk",
    humanist: "Public Sans",
  };
  if (slot === "mono") return kind === "mono" && !/ui-monospace|sf mono|menlo|consolas/i.test(family.name) ? pickFace("Geist Mono") : system(MONO_STACK, "system mono");
  if (kind === "system-serif") return system(SERIF_STACK, "system serif");
  const target = byKind[kind];
  if (!target || kind === "mono") return system(SANS_STACK, "system sans");
  return pickFace(target);

  function pickFace(name: string): ReturnType<typeof chooseFace> {
    const f = facesByName.get(name.toLowerCase())!;
    return { stack: stackFor(f), face: f, choice: { slot, original: family!.name, face: f.family, match: "substituted" } };
  }
}

const GENERIC = /^(sans-serif|serif|monospace|system-ui|-apple-system|ui-sans-serif|ui-serif|blinkmacsystemfont|inherit|initial)$/i;

/** Which reference family fills the body, display and mono slots. */
function slotFamilies(families: Family[]): { sans: Family | null; display: Family | null; mono: Family | null } {
  const real = families.filter((f) => f.name && !GENERIC.test(f.name));
  const isMono = (f: Family): boolean => kindOf(f.name) === "mono" || (kindOf(f.name) === "unknown" && /\bmono(space)?\b|\bcode\b/i.test(`${f.substitute} ${f.role.slice(0, 80)}`));
  const mono = real.find(isMono) ?? null;
  const text = real.filter((f) => !isMono(f));
  const sole = text.find((f) =>
    /\b(sole|only|single|one) (type ?face|typeface|family|font)\b|\bacross the (entire|whole)\b|\bentire (interface|system|site|page)\b|\ball (text|type|roles)\b|\beverything\b/i.test(f.role),
  );
  const body = sole ?? text.find((f) => /\b(body|paragraphs?|ui|interface|navigation|nav|labels?|copy|running text|workhorse)\b/i.test(f.role) && !/^\s*(display|headline|heading)/i.test(f.role)) ?? text[0] ?? null;
  const display = sole ?? text.find((f) => /\b(display|headlines?|headings?|hero|titles?|wordmark)\b/i.test(f.role.slice(0, 120)) && f !== body) ?? body;
  return { sans: body, display, mono };
}

// ---------------------------------------------------------------------------------------------
// Type, shape and elevation

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Foundation's dark shadows, for a dark :root. */
const DARK_SHADOWS: [string, string][] = [
  ["--shadow-1", "0 1px 2px rgb(0 0 0 / 0.4)"],
  ["--shadow-2", "0 6px 16px rgb(0 0 0 / 0.5)"],
  ["--shadow-3", "0 20px 48px rgb(0 0 0 / 0.6)"],
];
const SAFE_SHADOW = /^[\w\s#%(),.\-/]+$/;

function shadowBlur(value: string): number {
  // The third length of the first shadow: `x y blur`.
  const first = value.split(/,(?![^(]*\))/)[0] ?? "";
  const lengths = first.replace(/rgba?\([^)]*\)|#[0-9a-f]+|inset/gi, " ").match(/-?[\d.]+px|\b0\b/g) ?? [];
  return Math.abs(Number.parseFloat(lengths[2] ?? "0"));
}

// ---------------------------------------------------------------------------------------------
// CSS assembly

/** `css` without the `@media (prefers-color-scheme: dark) { … }` block. */
function withoutDarkBlock(css: string): string {
  const at = css.search(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i);
  if (at < 0) return css;
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return `${css.slice(0, at).replace(/\s+$/, "")}\n${css.slice(i + 1).replace(/^\s*\n/, "\n")}`;
  }
  return css;
}

/** A name safe inside a CSS comment. */
const commentSafe = (s: string): string => s.replace(/[^\p{L}\p{N} .&'+-]/gu, "").slice(0, 60).trim() || "reference";

function fontFaceCss(face: Face): string {
  const rule = (file: string, style: string): string =>
    `@font-face {\n  font-family: "${face.family}";\n  src: url("fonts/${file}") format("woff2");\n  font-style: ${style};\n  font-weight: ${face.weights};\n  font-display: swap;\n}\n`;
  return rule(face.file, "normal") + (face.italic ? rule(face.italic, "italic") : "");
}

/**
 * Adapt one reference to a Foundation tokens.css. `extended` is preferred (it has every table);
 * `compact` is read when it is the only one. Throws when neither has a colour table.
 */
export function adaptReference(source: { extended?: string | null; compact?: string | null }, options: AdaptOptions): AdaptResult {
  const text = source.extended ?? source.compact;
  if (!text) throw new Error("No reference text to adapt.");
  const ref = parseReference(text);
  if (!ref.colors.length) throw new Error(`${ref.name} has no colour table to adapt.`);

  const native: Scheme = ref.theme === "dark" ? "dark" : "light";
  const other: Scheme = native === "light" ? "dark" : "light";
  const base: Scheme = options.appearance === "light" || options.appearance === "dark" ? options.appearance : native;
  const notes: string[] = [];
  const fixes: ContrastFix[] = [];

  const core = readCore(ref, native);
  const schemes = {} as Record<Scheme, Record<ColorRole, string>>;
  schemes[native] = completeScheme(core, native, fixes);
  schemes[other] = completeScheme(flipCore(core, other), other, fixes);
  notes.push(`${other === "dark" ? "Dark" : "Light"} scheme derived from the ${native} one.`);
  if (ref.theme === "mixed") notes.push("The source mixes light and dark sections; its light side is used.");

  const roles = {} as Record<ColorRole, RoleSource>;
  const coreRoles: Partial<Record<ColorRole, Pick>> = {
    bg: core.bg, surface: core.surfaces[0], "surface-2": core.surfaces[1], "surface-3": core.surfaces[2], text: core.text, "text-muted": core.muted,
    border: core.border, "border-strong": core.borderStrong, primary: core.primary, accent: core.accent, ...(core.accentSoft ? { "accent-soft": core.accentSoft } : {}),
  };
  for (const role of COLOR_ROLES) {
    const from = coreRoles[role];
    const statusRole = /^(success|warning|danger)/.test(role);
    roles[role] = { value: schemes[native][role], from: from?.from ?? null, confidence: from?.confidence ?? (statusRole ? "default" : "derived") };
  }

  // Fonts.
  const slots = slotFamilies(ref.families);
  const sans = chooseFace(slots.sans, "sans");
  const display = slots.display === slots.sans ? { ...sans, choice: { ...sans.choice, slot: "display" as const } } : chooseFace(slots.display, "display");
  const mono = chooseFace(slots.mono, "mono");
  const fonts = [sans.choice, display.choice, mono.choice];
  const faces = [...new Map([sans.face, display.face, mono.face].filter((f): f is Face => !!f).map((f) => [f.family, f])).values()];

  // Two shapes, as the bundled styles have: a light :root with a dark pair that follows the system,
  // or a dark :root alone (the dark-native look, or any reference asked to sit dark).
  const darkOnly = base === "dark";
  let css = options.baseCss.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
  const set = (name: string, scheme: Scheme, value: string): void => {
    try {
      css = setToken(css, name, scheme, value);
    } catch {
      notes.push(`Skipped ${name}: Foundation's tokens.css has no such token.`);
    }
  };
  if (darkOnly) {
    css = withoutDarkBlock(css).replace(/(:root\s*\{[^}]*?color-scheme:\s*)light/, "$1dark");
    for (const role of COLOR_ROLES) set(`--color-${role}`, "light", schemes.dark[role]);
    for (const [name, value] of DARK_SHADOWS) set(name, "light", value);
  } else {
    for (const role of COLOR_ROLES) {
      set(`--color-${role}`, "light", schemes.light[role]);
      set(`--color-${role}`, "dark", schemes.dark[role]);
    }
  }

  set("--font-sans", "light", sans.stack);
  set("--font-display", "light", display.stack);
  set("--font-mono", "light", mono.stack);

  // Type: body, display and tracking from the scale, clamped to what Foundation's parts can hold.
  const body = ref.scale.find((r) => /^body(-md|-base|-default|-regular)?$/.test(r.role)) ?? ref.scale.filter((r) => r.role.includes("body")).sort((a, b) => Math.abs(a.size - 16) - Math.abs(b.size - 16))[0];
  if (body) {
    const size = Math.round(clamp(body.size, 14, 18));
    set("--text-md", "light", `${size}px`);
    set("--leading-md", "light", `${Math.round(size * clamp(body.lineHeight ?? 1.5, 1.4, 1.75))}px`);
  }
  const displayRow = ref.scale.find((r) => /display|hero/.test(r.role)) ?? [...ref.scale].sort((a, b) => b.size - a.size)[0];
  if (displayRow && displayRow.size >= 32) {
    const size = Math.round(clamp(displayRow.size, 40, 80));
    const lh = clamp(displayRow.lineHeight ?? 1.1, 0.95, 1.3);
    set("--text-display", "light", `${size}px`);
    set("--leading-display", "light", `${Math.round(size * lh)}px`);
    const small = Math.round(clamp(size * 0.64, 32, 48));
    set("--text-display-sm", "light", `${small}px`);
    set("--leading-display-sm", "light", `${Math.round(small * clamp(lh + 0.05, 1, 1.35))}px`);
    if (displayRow.trackingEm !== null) set("--tracking-display", "light", `${clamp(displayRow.trackingEm, -0.06, 0.04).toFixed(3)}em`);
  }
  const headingRow = ref.scale.find((r) => /^(heading|h2|heading-md|title)$/.test(r.role));
  if (headingRow?.trackingEm !== null && headingRow?.trackingEm !== undefined) set("--tracking-heading", "light", `${clamp(headingRow.trackingEm, -0.04, 0.04).toFixed(3)}em`);
  const weights = [...new Set((slots.sans?.weights ?? []).filter((w) => w >= 300 && w <= 800))].sort((a, b) => a - b);
  if (weights.length) {
    const regular = weights.find((w) => w >= 300 && w <= 450) ?? 400;
    const medium = weights.find((w) => w > regular && w <= 600) ?? Math.min(regular + 100, 500);
    const bold = Math.max(medium, weights[weights.length - 1]!);
    set("--weight-regular", "light", String(regular));
    set("--weight-medium", "light", String(medium));
    set("--weight-bold", "light", String(Math.min(bold, 700)));
  }

  // Shape: controls → md, cards → lg, small parts → sm.
  const radius = (re: RegExp): number | null => ref.radii.find((r) => re.test(r.element) && r.px < 999)?.px ?? null;
  const md = radius(/button|input|control|field|cta/) ?? radius(/./);
  if (md !== null) {
    const mdPx = Math.round(clamp(md, 0, 24));
    const lg = radius(/card|panel|modal|container|dialog|image|section/);
    const sm = radius(/tag|chip|badge|pill|small|checkbox|tooltip/);
    set("--radius-md", "light", `${mdPx}px`);
    set("--radius-lg", "light", `${Math.round(clamp(lg ?? mdPx * 1.5, mdPx, 32))}px`);
    set("--radius-sm", "light", `${Math.round(clamp(sm ?? mdPx * 0.75, 0, mdPx))}px`);
  }

  // Elevation: the reference's shadows by blur, or none for a flat one.
  const shadows = ref.shadows.filter((s) => s.value.length <= 200 && SAFE_SHADOW.test(s.value) && /\dpx/.test(s.value) && !/none/i.test(s.value));
  // The source's shadows belong to its own scheme: in :root, or in the dark pair for a dark reference shown light.
  const shadowScheme: Scheme = darkOnly || native === "light" ? "light" : "dark";
  if (shadows.length) {
    const sorted = [...new Map(shadows.map((s) => [s.value, s])).values()].sort((a, b) => shadowBlur(a.value) - shadowBlur(b.value));
    const at = (i: number): string => sorted[Math.min(sorted.length - 1, Math.round((i * (sorted.length - 1)) / 2))]!.value;
    set("--shadow-1", shadowScheme, at(0));
    set("--shadow-2", shadowScheme, at(1));
    set("--shadow-3", shadowScheme, at(2));
  } else if (ref.flat) {
    set("--shadow-1", shadowScheme, "none");
    set("--shadow-2", shadowScheme, "none");
    notes.push("The source uses no shadows: cards and menus are flat; dialogs keep one.");
  }
  if (ref.maxWidth !== null) set("--content-max", "light", `${Math.round(clamp(ref.maxWidth, 960, 1440))}px`);

  const header = `/* Foundation tokens adapted from the GradientDeck reference "${commentSafe(ref.name)}". Colours come from its table with`
    + ` missing roles derived and contrast repaired; fonts are substituted from CubiQ's bundled faces. */\n`;
  const tokensCss = header + faces.map(fontFaceCss).join("") + (faces.length ? "\n" : "") + css;
  const fontFiles = faces.flatMap((f) => (f.italic ? [f.file, f.italic] : [f.file]));
  for (const f of fonts) if (f.original && f.match !== "exact") notes.push(`${f.slot}: ${commentSafe(f.original)} → ${f.face}.`);

  return {
    tokensCss,
    light: schemes.light,
    dark: schemes.dark,
    fontFiles,
    report: { name: ref.name, theme: ref.theme, native, base, roles, contrastFixes: fixes, fonts, notes },
  };
}

/** One line for the agent: the source, the scheme, what was substituted and fixed. */
export function adaptSummary(report: AdaptReport): string {
  const derived = report.native === "light" ? "dark derived" : "light derived";
  const subs = report.fonts.filter((f) => f.original && f.match !== "exact").map((f) => `${f.original} → ${f.face}`);
  const parts = [`Adapted from ${report.name} (${report.native}; ${derived})`];
  if (subs.length) parts.push(`fonts substituted: ${[...new Set(subs)].join(", ")}`);
  if (report.contrastFixes.length) parts.push(`${report.contrastFixes.length} contrast fix${report.contrastFixes.length === 1 ? "" : "es"}`);
  return `${parts.join("; ")}.`;
}

/** The short note the Customize panel shows: "Adapted from Stripe · font substituted". */
export function adaptNote(report: AdaptReport): string {
  const substituted = report.fonts.some((f) => f.original && f.match !== "exact");
  return `Adapted from ${report.name}${substituted ? " · font substituted" : ""}`;
}
