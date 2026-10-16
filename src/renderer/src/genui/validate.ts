import { evaluateFormula, formulaIds } from "./formula";
import { UI_BODY_MAX, UI_ITEMS_MAX, UI_NAMES, UI_TEXT_MAX } from "./types";
import type { CalculatorInput, CalculatorSpec, ChecklistSpec, CompareSpec, TimelineSpec, UiName, UiSpec } from "./types";

/** Most columns a compare block may have. */
const COMPARE_COLS_MAX = 8;

/** Shape an input id must have. */
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string, clipped to UI_TEXT_MAX (ending with "…" when clipped). */
function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.length > UI_TEXT_MAX ? v.slice(0, UI_TEXT_MAX - 1) + "…" : v;
}

/** Optional string: absent or the wrong type becomes undefined. */
function optText(o: Record<string, unknown>, key: string): string | undefined {
  return text(o[key]) ?? undefined;
}

/** A finite number, or null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Optional finite number: absent or the wrong type becomes undefined. */
function optNum(v: unknown): number | undefined {
  return num(v) ?? undefined;
}

/** A non-empty array of at most `max` entries, or null. */
function list(v: unknown, max: number): unknown[] | null {
  return Array.isArray(v) && v.length > 0 && v.length <= max ? v : null;
}

function validateChecklist(o: Record<string, unknown>): ChecklistSpec | null {
  const raw = list(o.items, UI_ITEMS_MAX);
  if (!raw) return null;
  const items: ChecklistSpec["items"] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const label = text(entry.text);
    if (label === null) return null;
    items.push({ text: label, done: entry.done === true });
  }
  const spec: ChecklistSpec = { name: "checklist", items };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  const note = optText(o, "note");
  if (note !== undefined) spec.note = note;
  return spec;
}

function validateCalculator(o: Record<string, unknown>): CalculatorSpec | null {
  const raw = list(o.inputs, UI_ITEMS_MAX);
  if (!raw) return null;
  const inputs: CalculatorInput[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const id = entry.id;
    if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) return null;
    ids.add(id);
    const label = text(entry.label);
    if (label === null) return null;
    const value = num(entry.value);
    if (value === null) return null;
    const input: CalculatorInput = { id, label, value };
    const min = optNum(entry.min);
    if (min !== undefined) input.min = min;
    const max = optNum(entry.max);
    if (max !== undefined) input.max = max;
    const step = optNum(entry.step);
    if (step !== undefined) input.step = step;
    const unit = optText(entry, "unit");
    if (unit !== undefined) input.unit = unit;
    inputs.push(input);
  }
  const formula = text(o.formula);
  if (formula === null) return null;
  const used = formulaIds(formula);
  if (used === null || !used.every((id) => ids.has(id))) return null;
  const defaults: Record<string, number> = {};
  for (const input of inputs) defaults[input.id] = input.value;
  if (evaluateFormula(formula, defaults) === null) return null;
  const spec: CalculatorSpec = { name: "calculator", inputs, formula };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  const unit = optText(o, "unit");
  if (unit !== undefined) spec.unit = unit;
  const note = optText(o, "note");
  if (note !== undefined) spec.note = note;
  return spec;
}

function validateCompare(o: Record<string, unknown>): CompareSpec | null {
  const rawHeaders = o.headers;
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0 || rawHeaders.length > COMPARE_COLS_MAX) return null;
  const headers: string[] = [];
  for (const cell of rawHeaders) {
    const head = text(cell);
    if (head === null) return null;
    headers.push(head);
  }
  const rawRows = list(o.rows, UI_ITEMS_MAX);
  if (!rawRows) return null;
  const rows: string[][] = [];
  for (const entry of rawRows) {
    if (!Array.isArray(entry) || entry.length !== headers.length) return null;
    const row: string[] = [];
    for (const cell of entry) {
      if (typeof cell === "number") {
        if (!Number.isFinite(cell)) return null;
        row.push(String(cell));
      } else {
        const s = text(cell);
        if (s === null) return null;
        row.push(s);
      }
    }
    rows.push(row);
  }
  const spec: CompareSpec = { name: "compare", headers, rows };
  const highlight = o.highlight;
  if (typeof highlight === "number" && Number.isInteger(highlight) && highlight >= 0 && highlight < rows.length) spec.highlight = highlight;
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

function validateTimeline(o: Record<string, unknown>): TimelineSpec | null {
  const raw = list(o.steps, UI_ITEMS_MAX);
  if (!raw) return null;
  const steps: TimelineSpec["steps"] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const heading = text(entry.title);
    if (heading === null) return null;
    const step: TimelineSpec["steps"][number] = { title: heading };
    const time = optText(entry, "time");
    if (time !== undefined) step.time = time;
    const detail = optText(entry, "detail");
    if (detail !== undefined) step.detail = detail;
    steps.push(step);
  }
  const spec: TimelineSpec = { name: "timeline", steps };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

/**
 * Parse and check a ```ui:<name> body against the catalog in types.ts.
 * Returns a fresh, clipped spec object, or null when the block is not usable.
 */
export function validateUi(name: string, body: string): UiSpec | null {
  if (!(UI_NAMES as readonly string[]).includes(name)) return null;
  if (typeof body !== "string" || body.length > UI_BODY_MAX) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const ui = name as UiName;
  if (ui === "checklist") return validateChecklist(parsed);
  if (ui === "calculator") return validateCalculator(parsed);
  if (ui === "compare") return validateCompare(parsed);
  return validateTimeline(parsed);
}
