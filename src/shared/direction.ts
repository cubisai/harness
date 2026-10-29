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

/** The direction the agent chose for an Auto design thread (design_set_direction). */
export interface DesignDirection {
  surface: DesignSurface;
  mode: DesignMode;
  /** A style id (`style:<folder>`) or "project". */
  style: string;
  tier: PrototypeTier;
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
  return { surface: r.surface as DesignSurface, mode: r.mode as DesignMode, style: r.style, tier };
}

/** Whether a design thread picks its own style (a new thread, or one switched back to Auto). */
export function isAuto(thread: { designSystem?: string }): boolean {
  return thread.designSystem === AUTO_SYSTEM;
}
