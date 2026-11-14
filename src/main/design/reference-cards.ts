// The style picker's cards for downloaded design references, drawn from the index's own colours (no images,
// no reference files read): ground and ink from the reference's theme, the most saturated colour as the accent.

import { REFERENCE_SYSTEM_PREFIX } from "../../shared/direction";
import type { DesignReferenceCard } from "../../shared/design-mutation";
import { contrast, mix, parseHex, toHex, toOklch, type Rgb } from "./oklch";
import type { ReferenceSource } from "./references";
import type { ReferenceIndexEntry } from "./references-store";

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** A CSS stack in the face's class, guessed from the reference's first font name. */
function fontStack(fonts: readonly string[] | undefined): string {
  const name = (fonts?.[0] ?? "").toLowerCase();
  if (/mono|code|courier/.test(name)) return "ui-monospace, SFMono-Regular, Menlo, monospace";
  if (/serif/.test(name) && !/sans/.test(name)) return "Georgia, 'Times New Roman', serif";
  return "system-ui, -apple-system, 'Segoe UI', sans-serif";
}

/** One reference as a card: its theme decides which end of its palette is the ground. */
export function referenceCard(entry: ReferenceIndexEntry): DesignReferenceCard {
  const colors = entry.colors.map((c) => parseHex(c.hex)).filter((c): c is Rgb => c !== null);
  const dark = entry.theme === "dark";
  const byLight = [...colors].sort((a, b) => toOklch(b).l - toOklch(a).l);
  const ground = (dark ? byLight[byLight.length - 1] : byLight[0]) ?? (dark ? { r: 17, g: 17, b: 17 } : WHITE);
  const darkest = byLight[byLight.length - 1];
  const lightest = byLight[0];
  // The ink is the far end of the palette when it reads on the ground, else plain black or white.
  const far = dark ? lightest : darkest;
  const ink = far && contrast(far, ground) >= 4.5 ? far : contrast(BLACK, ground) >= contrast(WHITE, ground) ? BLACK : WHITE;
  const saturated = [...colors].sort((a, b) => toOklch(b).c - toOklch(a).c)[0];
  const accent = saturated && toOklch(saturated).c >= 0.04 && contrast(saturated, ground) >= 1.4 ? saturated : ink;
  const onAccent = contrast(BLACK, accent) >= contrast(WHITE, accent) ? BLACK : WHITE;
  // The colour closest to the ground (but not it) is the surface; otherwise a step towards the ink.
  const near = colors.filter((c) => c !== ground && contrast(c, ground) < 1.6).sort((a, b) => contrast(a, ground) - contrast(b, ground))[0];
  const surface = near ?? mix(ground, ink, 0.05);
  return {
    id: `${REFERENCE_SYSTEM_PREFIX}${entry.slug}`,
    slug: entry.slug,
    name: entry.name,
    nickname: entry.nickname ?? "",
    industry: entry.industry?.trim() || "other",
    theme: entry.theme,
    host: entry.host ?? "",
    colors: entry.colors.map((c) => `${c.name} ${c.hex}`),
    card: {
      bg: toHex(ground),
      surface: toHex(surface),
      text: toHex(ink),
      muted: toHex(mix(ink, ground, 0.4)),
      accent: toHex(accent),
      onAccent: toHex(onAccent),
      border: toHex(mix(ground, ink, 0.14)),
      radius: "6px",
      font: fontStack(entry.fonts),
    },
  };
}

/** Every reference that has a file on this machine, as cards in the index's order. */
export function referenceCards(source: ReferenceSource | null): DesignReferenceCard[] {
  const manifest = source?.manifest() ?? null;
  if (!source || !manifest) return [];
  return source
    .index()
    .filter((e) => manifest.files[e.slug]?.extended || manifest.files[e.slug]?.compact)
    .map(referenceCard);
}

/** A stable 32-bit hash of `text`, to vary picks by thread and round without randomness. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * `count` references far apart from each other and from `current` (theme, industry and accent hue), skipping
 * `avoid`. The first is drawn by `seed`, so another round of the same design gets a different set.
 */
export function spreadReferences(cards: readonly DesignReferenceCard[], count: number, seed: string, current: string | null, avoid: readonly string[] = []): DesignReferenceCard[] {
  const pool = cards.filter((c) => c.slug !== current && !avoid.includes(c.slug));
  if (!pool.length) return [];
  const hue = (c: DesignReferenceCard): number | null => {
    const rgb = parseHex(c.card.accent);
    const o = rgb ? toOklch(rgb) : null;
    return o && o.c >= 0.04 ? o.h : null;
  };
  const distance = (a: DesignReferenceCard, b: DesignReferenceCard): number => {
    const ha = hue(a);
    const hb = hue(b);
    const dh = ha === null || hb === null ? (ha === hb ? 0 : 0.5) : Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb)) / 180;
    return (a.theme === b.theme ? 0 : 1) + (a.industry === b.industry ? 0 : 1) + dh;
  };
  const anchor = cards.find((c) => c.slug === current) ?? null;
  const picked: DesignReferenceCard[] = [];
  const first = pool[hash(seed) % pool.length]!;
  // Away from the current look when there is one; else the seeded pick starts the set.
  picked.push(anchor ? pool.reduce((best, c) => (distance(c, anchor) + (hash(seed + c.slug) % 100) / 1000 > distance(best, anchor) + (hash(seed + best.slug) % 100) / 1000 ? c : best), first) : first);
  while (picked.length < count && picked.length < pool.length) {
    let best: DesignReferenceCard | null = null;
    let bestScore = -1;
    for (const c of pool) {
      if (picked.includes(c)) continue;
      const near = Math.min(...picked.map((p) => distance(c, p)), anchor ? distance(c, anchor) : Infinity);
      const score = near + (hash(seed + c.slug) % 100) / 1000;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked;
}
