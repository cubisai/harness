import type { DesignIntent } from "../../../shared/types";

/** The chip a design thread's next message goes out with (`+` menu, the style picker, System mode). */
export type DesignChip = { kind: "new-kit" } | { kind: "match-screenshot"; file?: string } | { kind: "new-component"; selection?: string };

/** Where System mode is: the page open in it, and the theme and scheme it shows. */
export interface SystemWhere {
  page: string;
  theme: string;
}

/** The Composer's context chips in System mode, minus the ones the user removed. `Library` gone means the message is about the page. */
export function systemChips(where: SystemWhere | undefined, dropped: ReadonlySet<string>): string[] {
  if (!where || dropped.has("Library")) return [];
  return ["Library", where.page, where.theme].filter((c) => c === "Library" || !dropped.has(c));
}

export function designChipLabel(chip: DesignChip): string {
  return chip.kind === "new-kit" ? "New kit" : chip.kind === "match-screenshot" ? "Match a screenshot" : "New component";
}

/** The Composer placeholder for a design chip or System mode; null when neither applies. */
export function designPlaceholder(chip: DesignChip | undefined, system: string[]): string | null {
  if (chip?.kind === "new-kit") return "Describe the page. CubiQ builds the kit with it…";
  if (chip?.kind === "match-screenshot") return "Say what to match…";
  if (chip?.kind === "new-component") return "Describe the component…";
  if (system.length) return "Describe a design system change…";
  return null;
}

/** What the next message tells the agent beyond its text: the chip wins, then System mode's context. */
export function designIntent(chip: DesignChip | undefined, system: string[]): DesignIntent | null {
  if (chip?.kind === "new-kit") return { kind: "new-kit" };
  if (chip?.kind === "match-screenshot") return { kind: "match-screenshot" };
  if (chip?.kind === "new-component") return { kind: "new-component", ...(chip.selection ? { selection: chip.selection } : {}) };
  if (system.length) return { kind: "system", where: system.join(" · ").slice(0, 200) };
  return null;
}
