/** How much design-prototype discipline a design thread gets. Chat threads have none. */
export type PrototypeTier = "quick" | "working" | "real-app";

/** The tier a design thread gets when none was chosen. */
export const DEFAULT_TIER: PrototypeTier = "working";

/** Every tier, with the picker's label and its one-line detail. */
export const TIERS: { value: PrototypeTier; label: string; detail: string }[] = [
  { value: "quick", label: "Quick", detail: "Throwaway exploration, speed over polish" },
  { value: "working", label: "Working", detail: "Everyday design: tokens, states, tweaks" },
  { value: "real-app", label: "Real app", detail: "Product-grade: comments, critique, handoff" },
];

/** The tier a stored value names, or null when it is absent or not one of them. */
export function readTier(v: unknown): PrototypeTier | null {
  return v === "quick" || v === "working" || v === "real-app" ? v : null;
}

/** A thread's tier: the user's pick, else the one its Auto direction chose, else `DEFAULT_TIER`. */
export function tierOf(thread: { prototypeTier?: PrototypeTier; designDirection?: { tier: PrototypeTier } }): PrototypeTier {
  return thread.prototypeTier ?? thread.designDirection?.tier ?? DEFAULT_TIER;
}

/** What a tier turns on in the design UI and the agent's guide. */
export interface TierFeatures {
  tweaks: boolean;
  textEdit: boolean;
  comments: boolean;
}

/** The features each tier enables. */
export function tierFeatures(t: PrototypeTier): TierFeatures {
  switch (t) {
    case "quick":
      return { tweaks: false, textEdit: false, comments: false };
    case "working":
      return { tweaks: true, textEdit: true, comments: false };
    case "real-app":
      return { tweaks: true, textEdit: true, comments: true };
  }
}

/** The one-paragraph note about the tier appended to a design thread's guide. */
export function tierNote(t: PrototypeTier): string {
  switch (t) {
    case "quick":
      return "Prototype tier: Quick. Speed over polish: get the structure and the main interaction on screen. Tokens are optional; skip the states checklist, tweaks, data-agent-ids and critique.";
    case "working":
      return "Prototype tier: Working. Full design-prototype discipline: tokens, 8pt, states, real content, data-agent-ids and 2–5 tweaks. Check with design_screenshot and design_lint; run design-critique only when asked.";
    case "real-app":
      return "Prototype tier: Real app. Product-grade: match the project's real design system and component patterns (run design-system-extract first if the project has none), keep data-agent-ids stable, then run design-critique (save it) and offer design-handoff.";
  }
}
