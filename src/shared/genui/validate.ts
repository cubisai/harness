import { evaluateFormula, formulaIds } from "./formula";
import { parseUiLines } from "./lines";
import { CARDS_MAX, CHOICES_MAX, FORM_FIELDS_MAX, STATS_MAX, UI_ACTION_MAX, UI_BODY_MAX, UI_ITEMS_MAX, UI_NAMES, UI_TEXT_MAX } from "./types";
import type { CalculatorInput, CalculatorSpec, CardItem, CardsSpec, ChartSpec, ChecklistSpec, ChoicesSpec, CompareSpec, FormField, FormSpec, StatSpec, TimelineSpec, UiName, UiSpec } from "./types";

/** Most columns a compare block may have. */
const COMPARE_COLS_MAX = 8;

/** Shape an input id must have. */
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What one validation run noticed: why it refused (the first reason wins), and
 * the repairs it made to a block it accepted. Validation is synchronous, so one
 * module-level collector serves the run in progress.
 */
interface Diag {
  reason: string | null;
  clipped: number;
  padded: number;
  dropped: number;
  deduped: number;
  ignored: number;
}
let diag: Diag | null = null;

/** Refuse the block, recording why (the first reason in a run is kept). */
function fail(reason: string): null {
  if (diag && diag.reason === null) diag.reason = reason;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string, clipped to UI_TEXT_MAX (ending with "…" when clipped). */
function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.length <= UI_TEXT_MAX) return v;
  if (diag) diag.clipped++;
  return v.slice(0, UI_TEXT_MAX - 1) + "…";
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

/** A non-empty array of at most `max` entries, or null (with the reason named after `key`). */
function list(v: unknown, max: number, key: string): unknown[] | null {
  if (!Array.isArray(v)) return fail(v === undefined ? `no ${key}` : `${key} isn't a list`);
  if (v.length === 0) return fail(`${key} is empty`);
  if (v.length > max) return fail(`${v.length} ${key}, max ${max}`);
  return v;
}

/** "item 3" style position, 1-based. */
const at = (what: string, i: number): string => `${what} ${i + 1}`;

function validateChecklist(o: Record<string, unknown>): ChecklistSpec | null {
  const raw = list(o.items, UI_ITEMS_MAX, "items");
  if (!raw) return null;
  const items: ChecklistSpec["items"] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`${at("item", i)} isn't an object`);
    const label = text(entry.text);
    if (label === null) return fail(`${at("item", i)} has no text`);
    items.push({ text: label, done: entry.done === true });
  }
  const spec: ChecklistSpec = { name: "checklist", items };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  const note = optText(o, "note");
  if (note !== undefined) spec.note = note;
  return spec;
}

/**
 * Why a calculator's formula can't run, or null when it can. Agents write
 * formulas with ids they never declared (`P * r/12` over inputs named
 * principal and rate) or stray characters; the inputs still render, with this
 * line in place of the result.
 */
function formulaProblem(formula: string, inputs: CalculatorInput[]): string | null {
  if (!formula) return "no formula";
  const ids = new Set(inputs.map((i) => i.id));
  const used = formulaIds(formula) ?? [...new Set(formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];
  const unknown = used.filter((id) => !ids.has(id));
  if (unknown.length) return `unknown ${unknown.slice(0, 6).join(", ")}`;
  const defaults: Record<string, number> = {};
  // Empty inputs count as 1, so the formula is still checked to parse and evaluate.
  for (const input of inputs) defaults[input.id] = Number.isFinite(input.value) ? input.value : 1;
  return evaluateFormula(formula, defaults) === null ? "the formula doesn't parse" : null;
}

function validateCalculator(o: Record<string, unknown>): CalculatorSpec | null {
  const raw = list(o.inputs, UI_ITEMS_MAX, "inputs");
  if (!raw) return null;
  const inputs: CalculatorInput[] = [];
  const ids = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`${at("input", i)} isn't an object`);
    const id = entry.id;
    if (typeof id !== "string" || !ID_RE.test(id)) return fail(`${at("input", i)} has no usable id`);
    if (ids.has(id)) return fail(`input id "${id}" is used twice`);
    ids.add(id);
    const label = text(entry.label);
    if (label === null) return fail(`${at("input", i)} has no label`);
    // A missing starting value (`id|label||unit`, as agents write) is an empty input to fill in.
    const empty = entry.value === undefined || entry.value === "" || (typeof entry.value === "number" && Number.isNaN(entry.value));
    const value = num(entry.value);
    if (value === null && !empty) return fail(`${at("input", i)}'s value isn't a number`);
    const input: CalculatorInput = { id, label, value: value ?? Number.NaN };
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
  const formula = text(o.formula) ?? "";
  const spec: CalculatorSpec = { name: "calculator", inputs, formula };
  const problem = formulaProblem(formula, inputs);
  if (problem) spec.problem = problem;
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
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) return fail("no headers");
  if (rawHeaders.length > COMPARE_COLS_MAX) return fail(`${rawHeaders.length} columns, max ${COMPARE_COLS_MAX}`);
  const headers: string[] = [];
  for (const [i, cell] of rawHeaders.entries()) {
    const head = text(cell);
    if (head === null) return fail(`${at("header", i)} isn't text`);
    headers.push(head);
  }
  const rawRows = list(o.rows, UI_ITEMS_MAX, "rows");
  if (!rawRows) return null;
  const rows: string[][] = [];
  for (const [i, entry] of rawRows.entries()) {
    if (!Array.isArray(entry)) return fail(`${at("row", i)} isn't a list`);
    const row: string[] = [];
    // Short rows are padded with "" and extra cells beyond the headers dropped.
    if (diag && entry.length > headers.length) diag.dropped += entry.length - headers.length;
    for (const [j, cell] of entry.slice(0, headers.length).entries()) {
      if (typeof cell === "number") {
        if (!Number.isFinite(cell)) return fail(`${at("row", i)}, ${at("cell", j)} isn't a finite number`);
        row.push(String(cell));
      } else {
        const s = text(cell);
        if (s === null) return fail(`${at("row", i)}, ${at("cell", j)} isn't text`);
        row.push(s);
      }
    }
    if (diag && row.length < headers.length) diag.padded++;
    while (row.length < headers.length) row.push("");
    rows.push(row);
  }
  const spec: CompareSpec = { name: "compare", headers, rows };
  const highlight = o.highlight;
  if (typeof highlight === "number" && Number.isInteger(highlight) && highlight >= 0 && highlight < rows.length) spec.highlight = highlight;
  else if (highlight !== undefined && diag) diag.ignored++;
  const rawBest = o.best;
  if (Array.isArray(rawBest)) {
    // Invalid, out-of-bounds or repeated pairs are dropped, never a rejection.
    const best: [number, number][] = [];
    const seen = new Set<string>();
    for (const pair of rawBest) {
      const ok = ((): boolean => {
        if (!Array.isArray(pair) || pair.length !== 2) return false;
        const [row, column] = pair as [unknown, unknown];
        if (typeof row !== "number" || !Number.isInteger(row) || row < 0 || row >= rows.length) return false;
        if (typeof column !== "number" || !Number.isInteger(column) || column < 1 || column >= headers.length) return false;
        const key = `${row},${column}`;
        if (seen.has(key)) return false;
        seen.add(key);
        best.push([row, column]);
        return true;
      })();
      if (!ok && diag) diag.ignored++;
    }
    if (best.length > 0) spec.best = best;
  }
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

function validateTimeline(o: Record<string, unknown>): TimelineSpec | null {
  const raw = list(o.steps, UI_ITEMS_MAX, "steps");
  if (!raw) return null;
  const steps: TimelineSpec["steps"] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`${at("step", i)} isn't an object`);
    const heading = text(entry.title);
    if (heading === null) return fail(`${at("step", i)} has no title`);
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
  if (o.kind !== "bars") return fail(o.kind === undefined ? 'no kind (only "bars")' : `kind "${String(o.kind)}" isn't supported (only "bars")`);
  const raw = list(o.series, UI_ITEMS_MAX, "series");
  if (!raw) return null;
  const series: ChartSpec["series"] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`${at("bar", i)} isn't an object`);
    const label = text(entry.label);
    if (label === null) return fail(`${at("bar", i)} has no label`);
    const value = num(entry.value);
    if (value === null) return fail(`${at("bar", i)}'s value isn't a number`);
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

/** What a tap or select sends, exactly as written (trimmed): never clipped; too long or blank → null. Long text is ellipsed only on screen. */
function actionValue(v: unknown, what: string): string | null {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : null;
  if (s === null || s === "") return fail(`${what} is blank`);
  if (s.length > UI_ACTION_MAX) return fail(`${what} is ${s.length} characters, max ${UI_ACTION_MAX}`);
  return s;
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
  const raw = list(o.options, CHOICES_MAX, "options");
  if (!raw) return null;
  const options: string[] = [];
  for (const [i, entry] of raw.entries()) {
    const option = actionValue(entry, at("option", i));
    if (option === null) return null;
    // A repeated option is one button: two would light up together when tapped.
    if (!options.includes(option)) options.push(option);
    else if (diag) diag.deduped++;
  }
  const spec: ChoicesSpec = { name: "choices", options };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

const FIELD_TYPES = new Set<FormField["type"]>(["text", "number", "toggle", "select"]);

function validateForm(o: Record<string, unknown>): FormSpec | null {
  const raw = list(o.fields, FORM_FIELDS_MAX, "fields");
  if (!raw) return null;
  const fields: FormField[] = [];
  const ids = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`${at("field", i)} isn't an object`);
    const id = entry.id;
    if (typeof id !== "string" || !ID_RE.test(id)) return fail(`${at("field", i)} has no usable id`);
    if (ids.has(id)) return fail(`field id "${id}" is used twice`);
    ids.add(id);
    const name = label(entry.label) ?? id;
    const type = entry.type === undefined ? "text" : entry.type;
    if (typeof type !== "string" || !FIELD_TYPES.has(type as FormField["type"])) return fail(`field "${id}" has an unknown type`);
    const field: FormField = { id, label: name, type: type as FormField["type"] };
    if (field.type === "select") {
      const opts = list(entry.options, CHOICES_MAX * 2, `options in "${id}"`);
      if (!opts) return null;
      const options: string[] = [];
      for (const [j, opt] of opts.entries()) {
        const value = actionValue(opt, `${at("option", j)} of "${id}"`);
        if (value === null) return null;
        if (!options.includes(value)) options.push(value);
        else if (diag) diag.deduped++;
      }
      if (options.length < 2) return fail(`select "${id}" needs 2 different options`);
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
  const raw = list(o.stats, STATS_MAX, "stats");
  if (!raw) return null;
  const stats: StatSpec["stats"] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`${at("stat", i)} isn't an object`);
    const name = label(entry.label);
    if (name === null) return fail(`${at("stat", i)} has no label`);
    const value = label(entry.value);
    if (value === null) return fail(`${at("stat", i)} has no value`);
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
  const raw = list(o.items, CARDS_MAX, "items");
  if (!raw) return null;
  const items: CardItem[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`${at("item", i)} isn't an object`);
    const heading = label(entry.title);
    if (heading === null) return fail(`${at("item", i)} has no title`);
    const item: CardItem = { title: heading };
    const lead = label(entry.lead);
    if (lead !== null && lead !== "-") item.lead = lead;
    const body = label(entry.text);
    if (body !== null) item.text = body;
    const link = httpsUrl(entry.link);
    if (link !== undefined) item.link = link;
    else if (entry.link !== undefined && entry.link !== "" && entry.link !== "-" && diag) diag.ignored++;
    items.push(item);
  }
  const spec: CardsSpec = { name: "cards", items };
  const title = optText(o, "title");
  if (title !== undefined) spec.title = title;
  return spec;
}

function check(name: string, body: string): UiSpec | null {
  if (!(UI_NAMES as readonly string[]).includes(name)) return fail(`there's no ui:${name} block`);
  if (typeof body !== "string") return fail("no body");
  if (body.length > UI_BODY_MAX) return fail(`the body is ${body.length} characters, max ${UI_BODY_MAX}`);
  const ui = name as UiName;
  let parsed: unknown;
  if (body.trimStart().startsWith("{")) {
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail("the JSON doesn't parse");
    }
  } else {
    parsed = parseUiLines(ui, body);
    if (parsed === null) return fail("it has no rows");
  }
  if (!isRecord(parsed)) return fail("the JSON isn't an object");
  if (ui === "checklist") return validateChecklist(parsed);
  if (ui === "calculator") return validateCalculator(parsed);
  if (ui === "compare") return validateCompare(parsed);
  if (ui === "timeline") return validateTimeline(parsed);
  if (ui === "chart") return validateChart(parsed);
  if (ui === "choices") return validateChoices(parsed);
  if (ui === "form") return validateForm(parsed);
  if (ui === "stat") return validateStat(parsed);
  if (ui === "cards") return validateCards(parsed);
  return fail(`there's no ui:${name} block`);
}

/** A validation verdict: the spec with the repairs made to it, or why the block can't be drawn. */
export type UiValidation = { spec: UiSpec; notes: string[] } | { spec: null; reason: string };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * `validateUi` with its reasons: a refusal names the first problem ("field 3
 * has no usable id"); an accepted block lists what was repaired on the way
 * (clipped texts, padded rows, dropped cells, merged repeats, ignored hints).
 */
export function validateUiDetailed(name: string, body: string): UiValidation {
  const own: Diag = { reason: null, clipped: 0, padded: 0, dropped: 0, deduped: 0, ignored: 0 };
  const outer = diag;
  diag = own;
  let spec: UiSpec | null;
  try {
    spec = check(name, body);
  } finally {
    diag = outer;
  }
  if (!spec) return { spec: null, reason: own.reason ?? "it doesn't match the catalog" };
  const notes: string[] = [];
  if (own.clipped) notes.push(`${plural(own.clipped, "text", "texts")} clipped to ${UI_TEXT_MAX} characters`);
  if (own.padded) notes.push(`${plural(own.padded, "short row", "short rows")} padded`);
  if (own.dropped) notes.push(`${plural(own.dropped, "extra cell", "extra cells")} dropped`);
  if (own.deduped) notes.push(`${plural(own.deduped, "repeated option", "repeated options")} merged`);
  if (own.ignored) notes.push(`${plural(own.ignored, "invalid hint", "invalid hints")} ignored`);
  return { spec, notes };
}

/**
 * Parse and check a ```ui:<name> body against the catalog in types.ts.
 * A body opening with `{` is JSON; anything else uses the compact line
 * syntax (lines.ts). Returns a fresh, clipped spec object, or null when the
 * block is not usable.
 */
export function validateUi(name: string, body: string): UiSpec | null {
  return validateUiDetailed(name, body).spec;
}
