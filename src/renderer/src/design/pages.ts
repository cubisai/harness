import type { DesignEntry } from "../../../shared/types";
import { isVariant, variantLabel } from "../../../shared/design";

/** How many pages the compare view shows side by side. */
export const COMPARE_MAX = 4;

export interface PageOption {
  value: string;
  label: string;
  detail?: string;
}

/** The page switcher's options: pages by file name, variants as "Option A" with the file underneath. */
export function pageOptions(pages: DesignEntry["pages"]): PageOption[] {
  return pages.map(({ rel }) => (isVariant(rel) ? { value: rel, label: `Option ${variantLabel(rel)}`, detail: rel } : { value: rel, label: rel }));
}

export interface CompareCell {
  rel: string;
  url: string;
  label: string;
  variant: boolean;
}

/**
 * What the compare view lays side by side: the current `index.html` (when there is one) and then the
 * variants, at most COMPARE_MAX; empty when there's nothing to compare (fewer than two).
 */
export function compareCells(pages: DesignEntry["pages"]): CompareCell[] {
  const index = pages.find((p) => p.rel === "index.html");
  const cells: CompareCell[] = [
    ...(index ? [{ rel: index.rel, url: index.url, label: "Current", variant: false }] : []),
    ...pages.filter((p) => isVariant(p.rel)).map((p) => ({ rel: p.rel, url: p.url, label: `Option ${variantLabel(p.rel)}`, variant: true })),
  ].slice(0, COMPARE_MAX);
  return cells.length >= 2 ? cells : [];
}

/** True when two entries show the same page with the same page list (so the canvas needn't re-render). */
export function sameEntry(a: DesignEntry | null, b: DesignEntry | null): boolean {
  if (!a || !b) return a === b;
  return a.url === b.url && a.pages.length === b.pages.length && a.pages.every((p, i) => p.rel === b.pages[i]!.rel);
}
