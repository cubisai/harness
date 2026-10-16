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

export const UI_NAMES = ["checklist", "calculator", "compare", "timeline", "chart", "choices", "form", "stat", "cards"] as const;
export type UiName = (typeof UI_NAMES)[number];

export type ChecklistSpec = { name: "checklist"; title?: string; items: { text: string; done: boolean }[]; note?: string };

export type CalculatorInput = { id: string; label: string; value: number; min?: number; max?: number; step?: number; unit?: string };
export type CalculatorSpec = { name: "calculator"; title?: string; inputs: CalculatorInput[]; formula: string; unit?: string; note?: string };

/** `highlight` is a 0-based row index. Every row has `headers.length` cells. */
export type CompareSpec = { name: "compare"; title?: string; headers: string[]; rows: string[][]; highlight?: number };

export type TimelineSpec = { name: "timeline"; title?: string; steps: { time?: string; title: string; detail?: string }[] };

/** Horizontal bars; values must be finite and ≥ 0. Bars are drawn relative to the largest value. */
export type ChartSpec = { name: "chart"; title?: string; kind: "bars"; series: { label: string; value: number }[]; unit?: string };

/** Most buttons in a choices block, fields in a form, tiles in a stat block, rows in a cards block. */
export const CHOICES_MAX = 6;
export const FORM_FIELDS_MAX = 8;
export const STATS_MAX = 4;
export const CARDS_MAX = 12;

/** Tap-to-reply buttons: a tap sends that option's text as the user's message. */
export type ChoicesSpec = { name: "choices"; title?: string; options: string[] };

/** A `select` field has 2+ `options`; the others have none. */
export type FormField = { id: string; label: string; type: "text" | "number" | "toggle" | "select"; options?: string[] };
/** A small form; Submit sends one line, `Form "<title>": id=value, …`. */
export type FormSpec = { name: "form"; title?: string; fields: FormField[] };

/** Big-number tiles. `delta` is free text such as "+12%". */
export type StatSpec = { name: "stat"; title?: string; stats: { label: string; value: string; delta?: string }[] };

/**
 * A list of rows in one card. `lead` is an icon word (mapped locally), an
 * https image URL or a local image path; `link` is an https URL.
 */
export type CardItem = { lead?: string; title: string; text?: string; link?: string };
export type CardsSpec = { name: "cards"; title?: string; items: CardItem[] };

export type UiSpec = ChecklistSpec | CalculatorSpec | CompareSpec | TimelineSpec | ChartSpec | ChoicesSpec | FormSpec | StatSpec | CardsSpec;
