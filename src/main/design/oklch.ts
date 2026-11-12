// Colour maths for the reference adapter: hex ↔ OKLab/OKLCH, mixing, gamut fitting and
// WCAG contrast. Plain functions over plain numbers, so the adapter stays deterministic.

/** sRGB channels, 0-255. */
export type Rgb = { r: number; g: number; b: number };
/** OKLCH: lightness 0-1, chroma ≥ 0, hue in degrees. */
export type Oklch = { l: number; c: number; h: number };

/** `#rgb` or `#rrggbb` (an `#rrggbbaa` only when fully opaque) as channels, or null. */
export function parseHex(value: string): Rgb | null {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return { r: parseInt(short[1]! + short[1]!, 16), g: parseInt(short[2]! + short[2]!, 16), b: parseInt(short[3]! + short[3]!, 16) };
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(ff)?$/.exec(text);
  if (!long) return null;
  return { r: parseInt(long[1]!, 16), g: parseInt(long[2]!, 16), b: parseInt(long[3]!, 16) };
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

const toLinear = (v: number): number => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
/** Linear 0-1 back to an sRGB channel; callers clamp first. */
const fromLinear = (v: number): number => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** WCAG relative luminance. */
export function luminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG 2 contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type Lab = { l: number; a: number; b: number };

function toOklab(rgb: Rgb): Lab {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear sRGB (unclamped, may fall outside 0-1) of an OKLab colour. */
function oklabToLinear({ l: L, a, b }: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function toOklch(rgb: Rgb): Oklch {
  const { l, a, b } = toOklab(rgb);
  const c = Math.hypot(a, b);
  const h = c < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

const inGamut = (channels: [number, number, number]): boolean => channels.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The sRGB colour for an OKLCH value, lowering chroma (never lightness or hue) until it fits the gamut. */
export function fromOklch({ l, c, h }: Oklch): Rgb {
  const L = Math.min(1, Math.max(0, l));
  const rad = (h * Math.PI) / 180;
  const at = (chroma: number): [number, number, number] => oklabToLinear({ l: L, a: chroma * Math.cos(rad), b: chroma * Math.sin(rad) });
  let channels = at(c);
  if (!inGamut(channels)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    channels = at(lo);
  }
  const [r, g, b] = channels.map((v) => fromLinear(Math.min(1, Math.max(0, v)))) as [number, number, number];
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

/** `a` moved towards `b` by `t` (0-1) in OKLab. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const x = toOklab(a);
  const y = toOklab(b);
  const lab = { l: x.l + (y.l - x.l) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t };
  const [r, g, bl] = oklabToLinear(lab).map((v) => fromLinear(Math.min(1, Math.max(0, v)))) as [number, number, number];
  return { r: Math.round(r), g: Math.round(g), b: Math.round(bl) };
}

/** `color` with only its OKLCH lightness changed. */
export function withLightness(color: Rgb, l: number): Rgb {
  const lch = toOklch(color);
  return fromOklch({ ...lch, l });
}

/**
 * The smallest lightness change to `fg` that reaches `need` against `bg`, moving away from `bg`.
 * Tries the other direction when that side can't reach it; null when neither can.
 */
export function repairContrast(fg: Rgb, bg: Rgb, need: number): Rgb | null {
  if (contrast(fg, bg) >= need) return fg;
  const start = toOklch(fg).l;
  const away = luminance(bg) > 0.18 ? -1 : 1;
  for (const dir of [away, -away]) {
    const end = dir < 0 ? 0 : 1;
    const far = withLightness(fg, end);
    if (contrast(far, bg) < need) continue;
    let lo = start;
    let hi = end;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (contrast(withLightness(fg, mid), bg) >= need) hi = mid;
      else lo = mid;
    }
    // Rounding to hex can land a hair under the line: step on until it holds.
    let l = hi;
    let out = withLightness(fg, l);
    for (let i = 0; i < 50 && contrast(out, bg) < need; i++) {
      l = Math.min(1, Math.max(0, l + dir * 0.002));
      out = withLightness(fg, l);
    }
    if (contrast(out, bg) >= need) return out;
  }
  return null;
}
