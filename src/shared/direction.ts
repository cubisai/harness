import { readTier, type PrototypeTier } from "./tiers";

/** The design system id that lets the agent pick the style (the project's own system still wins). */
export const AUTO_SYSTEM = "auto";

/** A style from the style library as a design system id: `style:<folder>`. */
export const STYLE_PREFIX = "style:";

/** What is being designed: decides the frame, chrome and structure. */
export const SURFACES = ["component", "page", "screen", "workspace", "deck", "mobile"] as const;
export type DesignSurface = (typeof SURFACES)[number];

/** What the visitor's success looks like on the surface: decides how bold the design may be. */
export const MODES = ["persuade", "operate", "read", "experience"] as const;
export type DesignMode = (typeof MODES)[number];

/** A downloaded design reference a direction is built from; `sha256` pins the file it was adapted from. */
export interface DirectionReference {
  source: "gradientdeck";
  slug: string;
  sha256: string;
}

/** The direction the agent chose for an Auto design thread (design_set_direction). */
export interface DesignDirection {
  surface: DesignSurface;
  mode: DesignMode;
  /** A style id (`style:<folder>`) or "project". */
  style: string;
  tier: PrototypeTier;
  /** Set when the style is Foundation adapted from a design reference. */
  reference?: DirectionReference;
}

/** A stored reference, or null when it isn't a well-formed one. */
export function readDirectionReference(v: unknown): DirectionReference | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.source !== "gradientdeck" || typeof r.slug !== "string" || typeof r.sha256 !== "string") return null;
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(r.slug) || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  return { source: "gradientdeck", slug: r.slug, sha256: r.sha256 };
}

/** The marker a materialized reference leaves in `system/.reference`: `gradientdeck/<slug>@<sha8>`. */
export function referenceMarker(ref: DirectionReference): string {
  return `${ref.source}/${ref.slug}@${ref.sha256.slice(0, 8)}`;
}

/**
 * A design reference picked by the user as a thread's system: `ref:<slug>` (the picker's card, newest download) or
 * `ref:<slug>@<sha256>` (what a thread stores, so its pin survives a lost `system/`).
 */
export const REFERENCE_SYSTEM_PREFIX = "ref:";

/** The system id a thread stores for a picked reference. */
export function referenceSystemId(ref: DirectionReference): string {
  return `${REFERENCE_SYSTEM_PREFIX}${ref.slug}@${ref.sha256}`;
}

/** A reference system id's slug and (when pinned) sha256, or null when `id` isn't a well-formed one. */
export function parseReferenceSystemId(id: string | null | undefined): { slug: string; sha256?: string } | null {
  const m = id ? /^ref:([a-z0-9][a-z0-9-]{0,80})(?:@([0-9a-f]{64}))?$/.exec(id) : null;
  if (!m) return null;
  return m[2] ? { slug: m[1]!, sha256: m[2] } : { slug: m[1]! };
}

/** "persuade" -> "Persuade". */
export function modeLabel(mode: DesignMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/** A stored direction (JSON text or an object), or null when absent or malformed. */
export function readDirection(v: unknown): DesignDirection | null {
  let o: unknown = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const tier = readTier(r.tier);
  if (!(SURFACES as readonly unknown[]).includes(r.surface) || !(MODES as readonly unknown[]).includes(r.mode) || typeof r.style !== "string" || !r.style || !tier) return null;
  const reference = readDirectionReference(r.reference);
  return { surface: r.surface as DesignSurface, mode: r.mode as DesignMode, style: r.style, tier, ...(reference ? { reference } : {}) };
}

/** Whether a design thread picks its own style (a new thread, or one switched back to Auto). */
export function isAuto(thread: { designSystem?: string }): boolean {
  return thread.designSystem === AUTO_SYSTEM;
}
