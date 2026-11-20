import type { PluginAppTheme, ThemeScheme } from "./app-themes";
import { CHROME_THEME_BASE } from "./chrome-theme-tokens.generated";

export const CHROME_THEME_DERIVED = ["primary-soft", "send-bg", "send-fg", "send-ring", "goo-fill"] as const;

/** Only owned overrides; absent roles keep the exact CSS defaults and aliases. */
export function appThemePalette(theme: PluginAppTheme | null, scheme: ThemeScheme): Record<string, string> {
  const colors: Record<string, string> = { ...theme?.[scheme] };
  if (colors.primary) {
    const rgb = colors.primary.slice(1).match(/../g)!.map((p) => parseInt(p, 16));
    colors["primary-soft"] = `rgb(${rgb.join(" ")} / ${scheme === "light" ? 0.07 : 0.1})`;
  }
  if (colors.bg) colors["send-bg"] = colors.bg;
  if (colors.text) colors["send-fg"] = colors.text;
  if (colors["hairline-strong"]) colors["send-ring"] = colors["hairline-strong"];
  if (colors["bg-selected"]) colors["goo-fill"] = colors["bg-selected"];
  return colors;
}

type Color = [number, number, number, number];
/** Compiled base expressions only; plugin values use the stricter opaque hex grammar. */
function color(value: string, values: Record<string, string>, seen = new Set<string>()): Color {
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  if (alias) {
    if (seen.has(alias[1]!)) throw new Error("Cyclic base color.");
    return color(values[alias[1]!] ?? "", values, new Set(seen).add(alias[1]!));
  }
  if (/^#[\da-f]{6}$/i.test(value)) return [...value.slice(1).match(/../g)!.map((p) => parseInt(p, 16) / 255), 1] as Color;
  if (value === "transparent") return [0, 0, 0, 0];
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, Number(rgb[4] ?? 1)];
  throw new Error(`Unsupported base color: ${value}`);
}
function luminance(c: Color): number {
  const v = c.slice(0, 3).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  return v[0]! * 0.2126 + v[1]! * 0.7152 + v[2]! * 0.0722;
}
export function paletteContrast(values: Record<string, string>, foreground: string, background: string): number {
  const bg = color(values[background]!, values), fg = color(values[foreground]!, values);
  const composite = fg.map((v, i) => i < 3 ? v * fg[3] + bg[i]! * (1 - fg[3]) : 1) as Color;
  const a = luminance(composite), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function appThemeContrastErrors(theme: PluginAppTheme): string[] {
  const errors: string[] = [];
  const surfaces = ["bg", "bg-sidebar", "bg-elevated", "bg-subtle", "bg-chip", "bg-hover", "bg-selected"];
  const pairs: [string, string, number][] = surfaces.flatMap((bg) => ["text", "text-secondary", "text-tertiary", "signal-ink", "danger", "warning", "success", "focus"].map((fg): [string, string, number] => [fg, bg, fg === "focus" ? 3 : 4.5]));
  pairs.push(["on-primary", "primary", 4.5], ["send-fg", "send-bg", 4.5], ["signal-line", "bg", 3]);
  for (const bg of ["bg", "bg-subtle"]) for (const fg of ["syn-keyword", "syn-string", "syn-number", "syn-comment"]) pairs.push([fg, bg, 4.5]);
  for (const scheme of ["light", "dark"] as const) {
    const base: Record<string, string> = CHROME_THEME_BASE[scheme], values = { ...base, ...appThemePalette(theme, scheme) };
    for (const [fg, bg, target] of pairs) {
      const before = paletteContrast(base, fg, bg), after = paletteContrast(values, fg, bg);
      if (after + 0.000001 < Math.min(target, before)) errors.push(`${scheme}: ${fg} on ${bg} is ${after.toFixed(2)}:1; needs ${Math.min(target, before).toFixed(2)}:1${before < target ? " (existing base minimum)" : ""}.`);
    }
  }
  return errors;
}
