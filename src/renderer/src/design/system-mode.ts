// System mode's reading of a kit's tokens: which Foundations page a token sits on, the colour roles drawn as cards, and
// the ramps under them. Pure, so it's tested without a DOM; the values it hands back may still hold `color-mix()`,
// which the browser paints.
import type { DesignToken } from "../../../shared/types";

export type Foundation = "colors" | "typography" | "spacing" | "shape" | "elevation" | "breakpoints" | "motion";

export const FOUNDATIONS: { id: Foundation; label: string }[] = [
  { id: "colors", label: "Colors" },
  { id: "typography", label: "Typography" },
  { id: "spacing", label: "Spacing" },
  { id: "shape", label: "Shape" },
  { id: "elevation", label: "Elevation" },
  { id: "breakpoints", label: "Breakpoints" },
  { id: "motion", label: "Motion" },
];

const COLOR_VALUE = /^(#|rgb|hsl|oklch|oklab|lab|lch|color\(|color-mix|transparent\b|currentcolor\b)/i;

/** The Foundations page a token belongs on, or null for one that fits none (a component's own token). */
export function foundationOf(token: DesignToken): Foundation | null {
  const n = token.name;
  if (/^--(shadow|elevation)-/.test(n)) return "elevation";
  if (/^--(font|text|leading|weight|tracking)-/.test(n) || n === "--measure" || n === "--numeric-data") return "typography";
  if (/^--(space|gap|gutter)-/.test(n) || /^--(control|target)(-|$)/.test(n)) return "spacing";
  if (/^--(radius|hairline|border-width|ring-width)/.test(n)) return "shape";
  if (/^--(breakpoint|bp|screen)-/.test(n) || n === "--content-max") return "breakpoints";
  if (/^--(duration|ease|motion)/.test(n)) return "motion";
  if (/^--(color|chart)-/.test(n) || COLOR_VALUE.test(token.light.trim())) return "colors";
  return null;
}

/** Each page's tokens, keeping the file's order. */
export function foundationGroups(tokens: DesignToken[]): Record<Foundation, DesignToken[]> {
  const out: Record<Foundation, DesignToken[]> = { colors: [], typography: [], spacing: [], shape: [], elevation: [], breakpoints: [], motion: [] };
  for (const t of tokens) {
    const f = foundationOf(t);
    if (f) out[f].push(t);
  }
  return out;
}

/** Name → value for one scheme: dark falls back to light, as the cascade does. */
export function schemeValues(tokens: DesignToken[], scheme: "light" | "dark"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokens) out[t.name] = scheme === "dark" ? t.dark ?? t.light : t.light;
  return out;
}

/** A value with every `var(--x, fallback)` it reads replaced, so it paints outside the kit's page. */
export function resolveVars(value: string, values: Record<string, string>, depth = 0): string {
  if (depth > 8 || !value.includes("var(")) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    // Find the matching close paren, so a fallback may hold its own calls.
    let level = 0;
    let end = at + 3;
    for (; end < value.length; end++) {
      if (value[end] === "(") level++;
      else if (value[end] === ")" && --level === 0) break;
    }
    const inner = value.slice(at + 4, end);
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? "" : inner.slice(comma + 1).trim();
    out += resolveVars(values[name] ?? fallback, values, depth + 1);
    i = end + 1;
  }
  return out;
}

export interface RoleSwatch {
  label: "Default" | "Hover" | "Active";
  value: string;
  ink: string;
  /** The token it reads, or null when it's worked out from the role's colour. */
  token: string | null;
}

export interface ColorRole {
  id: string;
  label: string;
  /** The token behind the role's colour. */
  token: string;
  base: string;
  fill: RoleSwatch[];
  container: RoleSwatch[];
}

const ROLES: { id: string; label: string; names: string[] }[] = [
  { id: "primary", label: "Primary", names: ["primary"] },
  { id: "secondary", label: "Secondary", names: ["secondary"] },
  { id: "danger", label: "Error", names: ["danger", "error"] },
  { id: "success", label: "Success", names: ["success"] },
  { id: "warning", label: "Warning", names: ["warning"] },
  { id: "info", label: "Info", names: ["info"] },
];

const mix = (a: string, pct: number, b: string): string => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

/**
 * The kit's colour roles as `Default | Hover | Active`, for fill and container. A state the kit names is read from its
 * token; one it doesn't is worked out from the role colour and marked as such.
 */
export function colorRoles(values: Record<string, string>): ColorRole[] {
  const v = (name: string): string | undefined => (values[name] !== undefined ? resolveVars(values[name]!, values) : undefined);
  const out: ColorRole[] = [];
  for (const role of ROLES) {
    const key = role.names.find((n) => values[`--color-${n}`] !== undefined || values[`--color-${n}-fill`] !== undefined);
    if (!key) continue;
    const pick = (names: string[]): { token: string; value: string } | null => {
      for (const n of names) {
        const value = v(`--color-${key}${n}`);
        if (value !== undefined) return { token: `--color-${key}${n}`, value };
      }
      return null;
    };
    const baseTok = pick(["-fill", ""])!;
    const base = baseTok.value;
    const fillInk = (v(`--color-on-${key}-fill`) ?? v(`--color-on-${key}`) ?? "white");
    const softInk = v(`--color-on-${key}-soft`) ?? v(`--color-${key}-soft-text`) ?? v(`--color-${key}-text`) ?? base;
    const swatch = (label: RoleSwatch["label"], found: { token: string; value: string } | null, derived: string, ink: string): RoleSwatch =>
      found ? { label, value: found.value, ink, token: found.token } : { label, value: derived, ink, token: null };
    const soft = pick(["-soft", "-bg", "-container", "-light"]);
    const softValue = soft?.value ?? mix(base, 14, "transparent");
    out.push({
      id: role.id,
      label: role.label,
      token: baseTok.token,
      base,
      fill: [
        { label: "Default", value: base, ink: fillInk, token: baseTok.token },
        swatch("Hover", pick(["-hover", "-fill-hover"]), mix(base, 88, "black"), fillInk),
        swatch("Active", pick(["-active", "-dark"]), mix(base, 76, "black"), fillInk),
      ],
      container: [
        { label: "Default", value: softValue, ink: softInk, token: soft?.token ?? null },
        swatch("Hover", pick(["-bg-hover", "-soft-hover"]), mix(softValue, 80, base), softInk),
        swatch("Active", null, mix(softValue, 64, base), softInk),
      ],
    });
  }
  return out;
}

export const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/** Ten steps from a colour: tints to white below 500, the colour at 500, shades to black above. */
export function ramp(base: string): string[] {
  const tints = [8, 16, 32, 50, 72];
  const shades = [84, 68, 52, 38];
  return [...tints.map((p) => mix(base, p, "white")), base, ...shades.map((p) => mix(base, p, "black"))];
}

/** Rows of the System rail's search: does the token's name or a value match? */
export function tokenMatches(token: DesignToken, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return token.name.toLowerCase().includes(q) || token.light.toLowerCase().includes(q) || (token.dark ?? "").toLowerCase().includes(q);
}

/** Where a sample page is served: the page's own URL with its path swapped. */
export function siblingUrl(pageUrl: string, pageRel: string, rel: string): string {
  const bare = pageUrl.split("?")[0]!;
  const encoded = pageRel.split("/").map(encodeURIComponent).join("/");
  const base = bare.endsWith(encoded) ? bare.slice(0, bare.length - encoded.length) : bare.replace(/[^/]*$/, "");
  return base + rel.split("/").map(encodeURIComponent).join("/");
}

/** The shortcut modifier as the platform writes it: `⌘` on a Mac, `Ctrl+` elsewhere. */
export const MOD_KEY = typeof navigator !== "undefined" && !/mac/i.test(navigator.platform) ? "Ctrl+" : "⌘";
