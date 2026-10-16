/**
 * Inline UI blocks: an agent writes a fenced ```ui:<name> block with a JSON
 * body inside a normal reply; the renderer validates it against this catalog
 * and draws it, or shows the fence as plain code. Nothing new is stored.
 */

/** Largest JSON body accepted, in characters. */
export const UI_BODY_MAX = 8_000;
/** Most items / rows / steps / inputs / headers in one block. */
export const UI_ITEMS_MAX = 50;
/** Strings longer than this are clipped (with "…"). */
export const UI_TEXT_MAX = 500;

export const UI_NAMES = ["checklist", "calculator", "compare", "timeline"] as const;
export type UiName = (typeof UI_NAMES)[number];

export type ChecklistSpec = { name: "checklist"; title?: string; items: { text: string; done: boolean }[]; note?: string };

export type CalculatorInput = { id: string; label: string; value: number; min?: number; max?: number; step?: number; unit?: string };
export type CalculatorSpec = { name: "calculator"; title?: string; inputs: CalculatorInput[]; formula: string; unit?: string; note?: string };

/** `highlight` is a 0-based row index. Every row has `headers.length` cells. */
export type CompareSpec = { name: "compare"; title?: string; headers: string[]; rows: string[][]; highlight?: number };

export type TimelineSpec = { name: "timeline"; title?: string; steps: { time?: string; title: string; detail?: string }[] };

export type UiSpec = ChecklistSpec | CalculatorSpec | CompareSpec | TimelineSpec;
