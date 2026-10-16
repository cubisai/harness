/** An 8-bit sRGB colour; an alpha channel, when present, is parsed but ignored. */
export type Rgb = { r: number; g: number; b: number };

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
const RGB_RE = /^rgba?\(([^)]*)\)$/i;

/** Linearise one 0–255 sRGB channel for the WCAG relative-luminance sum. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Parse a CSS colour to its sRGB channels, or null when it isn't one this understands: `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, and `rgb()`/`rgba()` with commas or spaces and an optional `/ alpha`. Alpha is
 * ignored. `var()`, `hsl()` and named colours have no fixed value here, so they return null.
 */
export function parseColor(value: string): Rgb | null {
  const s = value.trim();
  const hex = HEX_RE.exec(s);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      return { r: parseInt(h[0]! + h[0]!, 16), g: parseInt(h[1]! + h[1]!, 16), b: parseInt(h[2]! + h[2]!, 16) };
    }
    if (h.length === 6 || h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    return null;
  }
  const rgb = RGB_RE.exec(s);
  if (!rgb) return null;
  const channels = rgb[1]!.split("/")[0]!;
  const parts = channels.trim().split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return { r: Math.round(nums[0]!), g: Math.round(nums[1]!), b: Math.round(nums[2]!) };
}

/** The WCAG 2 contrast ratio between two colours: 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = 0.2126 * linear(a.r) + 0.7152 * linear(a.g) + 0.0722 * linear(a.b);
  const lb = 0.2126 * linear(b.r) + 0.7152 * linear(b.g) + 0.0722 * linear(b.b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The ratio as `"13.6:1"` plus its WCAG verdict: `"aa"` (≥ 4.5), `"large"` (≥ 3) or `"fail"`. */
export function contrastLabel(ratio: number): { text: string; pass: "aa" | "large" | "fail" } {
  return { text: `${ratio.toFixed(1)}:1`, pass: ratio >= 4.5 ? "aa" : ratio >= 3 ? "large" : "fail" };
}

/**
 * The token an ink token is checked against: `--color-on-primary` sits on `--color-primary`, any other name
 * containing `text` on `--color-bg`, and everything else has no single ground.
 */
export function groundFor(name: string): string | null {
  if (name.startsWith("--color-on-")) return `--color-${name.slice("--color-on-".length)}`;
  if (name.includes("text")) return "--color-bg";
  return null;
}

/** Whether a custom property is a colour: a `--color-*` name, or any name whose value parses as a colour. */
export function isColorToken(name: string, value: string): boolean {
  return name.startsWith("--color-") || parseColor(value) !== null;
}
