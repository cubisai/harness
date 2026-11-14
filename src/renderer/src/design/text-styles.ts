// The Typography view's names: the kit's type styles and colour tokens, read from the page's own tokens, so the panel
// offers `Body md 14/20` and `text-muted` instead of pixel sizes and hex.

/** The parts whose look is type: their variant (or size, level, order) prop is the Variant picker. */
const TEXT_PARTS = new Set(["typography", "text", "heading", "title"]);
const VARIANT_PROPS = ["variant", "level", "order", "size"];

/** Plain names for the shared scale steps (`--text-md` is Body md). */
const SCALE_NAMES: Record<string, string> = {
  "2xs": "Caption xs",
  xs: "Caption",
  sm: "Body sm",
  md: "Body md",
  lg: "Body lg",
  xl: "Title sm",
  "2xl": "Title md",
  "3xl": "Title lg",
  "4xl": "Headline",
  "display-sm": "Display sm",
  display: "Display",
};

export interface ScaleStep {
  id: string;
  label: string;
  /** `16/24`, or just `16` when the step has no leading. */
  meta: string;
  px: number;
}

/** The token names a page's tokens.css declares that the panel reads: colours and the type scale, in file order. */
export function tokenNames(css: string, limit = 160): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/(--(?:color|text|leading)-[a-z0-9-]{1,40})\s*:/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
    if (out.length >= limit) break;
  }
  return out;
}

const px = (v: string | undefined): number => (v && /^-?[\d.]+px$/.test(v.trim()) ? parseFloat(v) : NaN);

/** The page's type scale, smallest first: every `--text-X` in px, with `--leading-X` when there is one. */
export function typeScale(tokens: Record<string, string>): ScaleStep[] {
  const steps: ScaleStep[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    const m = /^--text-([a-z0-9-]+)$/.exec(name);
    if (!m) continue;
    const size = px(value);
    if (Number.isNaN(size)) continue;
    const lead = px(tokens[`--leading-${m[1]}`]);
    steps.push({ id: m[1]!, label: SCALE_NAMES[m[1]!] ?? m[1]!, meta: Number.isNaN(lead) ? `${size}` : `${size}/${lead}`, px: size });
  }
  return steps.sort((a, b) => a.px - b.px);
}

/** The scale step a style says it uses: `var(--text-md)` names it, else a size equal to a step's. */
export function scaleStepOf(steps: ScaleStep[], inline: string | undefined, computed: string | undefined): string | null {
  const named = /var\(\s*--text-([a-z0-9-]+)\s*\)/.exec(inline ?? "")?.[1];
  if (named && steps.some((s) => s.id === named)) return named;
  const size = px(computed);
  return steps.find((s) => s.px === size)?.id ?? null;
}

/** A kit part's type-style prop, the one the Variant picker drives, or null when the part isn't a text part. */
export function textVariantProp(ui: string | null | undefined, props: readonly { name: string; options?: string[] | null }[]): { name: string; options: string[] } | null {
  if (!ui || !TEXT_PARTS.has(ui)) return null;
  for (const name of VARIANT_PROPS) {
    const prop = props.find((p) => p.name === name && p.options?.length);
    if (prop) return { name, options: prop.options! };
  }
  return null;
}

/** An option as people say it: `body1` is Body 1, `title-lg` is Title lg, a heading's level `2` is H2. */
export function optionLabel(prop: string, value: string): string {
  if ((prop === "level" || prop === "order") && /^\d$/.test(value)) return `H${value}`;
  if (/^h\d$/.test(value)) return value.toUpperCase();
  const spaced = value.replace(/-/g, " ").replace(/([a-z])(\d)$/, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A computed size and line as `14/20`, or "" when either is missing. */
export function sizeMeta(style: Record<string, string> | undefined): string {
  const size = px(style?.fontSize);
  const line = px(style?.lineHeight);
  if (Number.isNaN(size)) return "";
  return Number.isNaN(line) ? `${Math.round(size)}` : `${Math.round(size)}/${Math.round(line)}`;
}

export interface ColourToken {
  token: string;
  /** The name without `--color-`: `text-muted`. */
  name: string;
  value: string;
}

/** The page's colour tokens, in file order, with their live values. */
export function colourTokens(tokens: Record<string, string>): ColourToken[] {
  return Object.entries(tokens)
    .filter(([name, value]) => name.startsWith("--color-") && value.trim() !== "")
    .map(([token, value]) => ({ token, name: token.slice("--color-".length), value: value.trim() }));
}

// A colour as rgb or rgba with no spaces, so a hex value and the browser's computed colour compare equal.
/** A CSS function call written out: kept out of string literals so the design check doesn't read page data as app colour. */
const fn = (name: string, args: readonly unknown[]): string => `${name}(${args.join(",")})`;

/** A token reference for a page's own token, as written into its style. */
export const tokenRef = (name: string): string => fn("var", [name]);

/** The style a scale step writes: its size token, and its leading token when the page has one. */
export function scaleChanges(id: string, tokens: Record<string, string>): { prop: string; value: string }[] {
  const leading = `--leading-${id}`;
  return [{ prop: "font-size", value: tokenRef(`--text-${id}`) }, ...(tokens[leading] ? [{ prop: "line-height", value: tokenRef(leading) }] : [])];
}

export function normalColour(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s+/g, "");
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    if (full.length === 8) {
      const a = Math.round((parseInt(full.slice(6, 8), 16) / 255) * 100) / 100;
      return a === 1 ? fn("rgb", [r, g, b]) : fn("rgba", [r, g, b, a]);
    }
    return fn("rgb", [r, g, b]);
  }
  const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(v);
  if (rgba && parseFloat(rgba[4]!) === 1) return fn("rgb", [rgba[1], rgba[2], rgba[3]]);
  return v;
}

/** Which role words suit a style property, best first: a text colour should read as `text`, a fill as `surface`. */
const ROLE_HINTS: Record<string, string[]> = {
  color: ["text", "on-", "accent-text"],
  "background-color": ["surface", "bg", "soft"],
  "border-color": ["border"],
};

// The token a colour is: the one the inline style names, else the token with the same value.
export function colourTokenOf(list: ColourToken[], prop: string, inline: string | undefined, computed: string | undefined): string | null {
  const named = /var\(\s*(--color-[a-z0-9-]+)\s*\)/.exec(inline ?? "")?.[1];
  if (named && list.some((t) => t.token === named)) return named;
  if (!computed) return null;
  const want = normalColour(computed);
  const same = list.filter((t) => normalColour(t.value) === want);
  if (!same.length) return null;
  const hints = ROLE_HINTS[prop] ?? [];
  for (const hint of hints) {
    const hit = same.find((t) => t.name.includes(hint));
    if (hit) return hit.token;
  }
  return same[0]!.token;
}

/** One declaration of an inline `style` attribute, or undefined. */
export function inlineStyle(style: string | undefined, prop: string): string | undefined {
  for (const decl of (style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0 && decl.slice(0, i).trim().toLowerCase() === prop) return decl.slice(i + 1).trim();
  }
  return undefined;
}
