import { evaluateFormula, formulaIds } from "./formula";
import { parseUiLines } from "./lines";
import { CARDS_MAX, CHOICES_MAX, FORM_FIELDS_MAX, STATS_MAX, UI_BODY_MAX, UI_ITEMS_MAX, UI_NAMES, UI_TEXT_MAX } from "./types";
import type { CalculatorInput, CalculatorSpec, CardItem, CardsSpec, ChartSpec, ChecklistSpec, ChoicesSpec, CompareSpec, FormField, FormSpec, StatSpec, TimelineSpec, UiName, UiSpec } from "./types";

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

function validateChart(o: Record<string, unknown>): ChartSpec | null {
  if (o.kind !== "bars") return null;
  const raw = list(o.series, UI_ITEMS_MAX);
  if (!raw) return null;
  const series: ChartSpec["series"] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const label = text(entry.label);
    if (label === null) return null;
    const value = num(entry.value);
    if (value === null || value < 0) return null;
    series.push({ label, value });
  }
  const spec: ChartSpec = { name: "chart", kind: "bars", series };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  const unit = optText(o, "unit");
  if (unit !== undefined) spec.unit = unit;
  return spec;
}

/** A non-empty string after trimming, clipped; numbers are accepted as their text. */
function label(v: unknown): string | null {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : text(v);
  return s !== null && s.trim() !== "" ? s.trim() : null;
}

/** An https URL, or undefined. */
function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > UI_TEXT_MAX) return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

function validateChoices(o: Record<string, unknown>): ChoicesSpec | null {
  const raw = list(o.options, CHOICES_MAX);
  if (!raw) return null;
  const options: string[] = [];
  for (const entry of raw) {
    const option = label(entry);
    if (option === null) return null;
    options.push(option);
  }
  const spec: ChoicesSpec = { name: "choices", options };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

const FIELD_TYPES = new Set<FormField["type"]>(["text", "number", "toggle", "select"]);

function validateForm(o: Record<string, unknown>): FormSpec | null {
  const raw = list(o.fields, FORM_FIELDS_MAX);
  if (!raw) return null;
  const fields: FormField[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const id = entry.id;
    if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) return null;
    ids.add(id);
    const name = label(entry.label) ?? id;
    const type = entry.type === undefined ? "text" : entry.type;
    if (typeof type !== "string" || !FIELD_TYPES.has(type as FormField["type"])) return null;
    const field: FormField = { id, label: name, type: type as FormField["type"] };
    if (field.type === "select") {
      const opts = list(entry.options, CHOICES_MAX * 2);
      if (!opts || opts.length < 2) return null;
      const options: string[] = [];
      for (const opt of opts) {
        const value = label(opt);
        if (value === null) return null;
        options.push(value);
      }
      field.options = options;
    }
    fields.push(field);
  }
  const spec: FormSpec = { name: "form", fields };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

function validateStat(o: Record<string, unknown>): StatSpec | null {
  const raw = list(o.stats, STATS_MAX);
  if (!raw) return null;
  const stats: StatSpec["stats"] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const name = label(entry.label);
    const value = label(entry.value);
    if (name === null || value === null) return null;
    const stat: StatSpec["stats"][number] = { label: name, value };
    const delta = label(entry.delta);
    if (delta !== null) stat.delta = delta;
    stats.push(stat);
  }
  const spec: StatSpec = { name: "stat", stats };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

function validateCards(o: Record<string, unknown>): CardsSpec | null {
  const raw = list(o.items, CARDS_MAX);
  if (!raw) return null;
  const items: CardItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const heading = label(entry.title);
    if (heading === null) return null;
    const item: CardItem = { title: heading };
    const lead = label(entry.lead);
    if (lead !== null && lead !== "-") item.lead = lead;
    const body = label(entry.text);
    if (body !== null) item.text = body;
    const link = httpsUrl(entry.link);
    if (link !== undefined) item.link = link;
    items.push(item);
  }
  const spec: CardsSpec = { name: "cards", items };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

/**
 * Parse and check a ```ui:<name> body against the catalog in types.ts.
 * A body opening with `{` is JSON; anything else uses the compact line
 * syntax (lines.ts). Returns a fresh, clipped spec object, or null when the
 * block is not usable.
 */
export function validateUi(name: string, body: string): UiSpec | null {
  if (!(UI_NAMES as readonly string[]).includes(name)) return null;
  if (typeof body !== "string" || body.length > UI_BODY_MAX) return null;
  const ui = name as UiName;
  let parsed: unknown;
  if (body.trimStart().startsWith("{")) {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  } else {
    parsed = parseUiLines(ui, body);
    if (parsed === null) return null;
  }
  if (!isRecord(parsed)) return null;
  if (ui === "checklist") return validateChecklist(parsed);
  if (ui === "calculator") return validateCalculator(parsed);
  if (ui === "compare") return validateCompare(parsed);
  if (ui === "timeline") return validateTimeline(parsed);
  if (ui === "chart") return validateChart(parsed);
  if (ui === "choices") return validateChoices(parsed);
  if (ui === "form") return validateForm(parsed);
  if (ui === "stat") return validateStat(parsed);
  if (ui === "cards") return validateCards(parsed);
  return null;
}
