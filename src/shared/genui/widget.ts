/**
 * Widgets a run_code script shows the user (`show(kind, props)`): drawn from
 * the script's own data, not retyped by the model. They travel as a versioned
 * envelope in a `widget` thread event; the renderer re-validates the spec
 * before drawing it, so a stored or imported event can't smuggle in anything
 * the catalog doesn't allow.
 */
import { UI_TEXT_MAX } from "./types";
import type { UiSpec } from "./types";
import { validateUiDetailed } from "./validate";

/** Most rows / columns a table widget carries, and its largest stored size (JSON characters). */
export const TABLE_ROWS_MAX = 2_000;
export const TABLE_COLS_MAX = 12;
export const WIDGET_JSON_MAX = 256_000;
/** Most widgets one script may show. */
export const WIDGETS_PER_RUN = 4;

export type TableCell = string | number | null;
/** `currency` reads `unit` as an ISO code (USD, EUR) when it is one; `percent` values are already percentages (12.5 = 12.5%). */
export type TableColumn = { key: string; label: string; type: "text" | "number" | "currency" | "percent"; unit?: string };
export type TableSpec = { name: "table"; title?: string; columns: TableColumn[]; rows: TableCell[][] };

export type WidgetSpec = UiSpec | TableSpec;

/** The kinds a script may show: the read-only catalog blocks plus `table`. Taps and forms stay with the model's own replies. */
export const WIDGET_KINDS = ["table", "stat", "chart", "compare", "cards", "checklist", "timeline"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** Each kind's props, for a script's error message (kept out of the tool description: it costs nothing until a script gets one wrong). */
export const WIDGET_SHAPES: Record<WidgetKind, string> = {
  table: '{ title?, rows: object[] | array[], columns?: (string | { key, label?, type?: "text"|"number"|"currency"|"percent", unit? })[], complete? }',
  stat: '{ title?, stats: [{ label, value, delta?, better?: "up"|"down" }] }',
  chart: '{ title?, kind: "bars", series: [{ label, value: number }], unit? }',
  compare: "{ title?, headers: string[], rows: (string|number)[][], highlight?: rowIndex }",
  cards: "{ title?, items: [{ title, text?, lead?, link?: https URL }] }",
  checklist: "{ title?, items: [{ text, done? }], note? }",
  timeline: "{ title?, steps: [{ title, time?, detail? }] }",
};

export type WidgetProvenance = { kind: "computed"; tool: "run_code"; observedAt: number; /** False when the script said its data is partial. */ complete: boolean };

export interface WidgetEnvelope {
  schemaVersion: 1;
  widgetId: string;
  /** The tool row (the script's call) that showed it. */
  ownerId: string;
  revision: number;
  provenance: WidgetProvenance;
  spec: WidgetSpec;
}

export type WidgetValidation = { spec: WidgetSpec; notes: string[] } | { spec: null; reason: string };

const COLUMN_TYPES = new Set<TableColumn["type"]>(["text", "number", "currency", "percent"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function clip(s: string, counter: { clipped: number }): string {
  if (s.length <= UI_TEXT_MAX) return s;
  counter.clipped++;
  return s.slice(0, UI_TEXT_MAX - 1) + "…";
}

/** A table from a script: rows as objects (keyed by column) or arrays; columns given, or taken from the first row. */
export function validateTable(props: Record<string, unknown>): WidgetValidation {
  const rawRows = props.rows;
  if (!Array.isArray(rawRows)) return { spec: null, reason: rawRows === undefined ? "no rows" : "rows isn't a list" };
  if (rawRows.length === 0) return { spec: null, reason: "rows is empty" };
  if (rawRows.length > TABLE_ROWS_MAX) return { spec: null, reason: `${rawRows.length} rows, max ${TABLE_ROWS_MAX}: show a top slice or a summary` };
  const first = rawRows[0];
  const counter = { clipped: 0, flattened: 0 };

  // Columns: as given (strings or { key, label, type, unit }), else the first row's keys / positions.
  let given: unknown[];
  if (props.columns !== undefined) {
    if (!Array.isArray(props.columns) || props.columns.length === 0) return { spec: null, reason: "columns must be a non-empty list" };
    given = props.columns;
  } else if (isRecord(first)) given = Object.keys(first);
  else if (Array.isArray(first)) given = first.map((_, i) => `Column ${i + 1}`);
  else return { spec: null, reason: "row 1 isn't an object or a list" };
  if (given.length === 0) return { spec: null, reason: "row 1 has no columns" };
  if (given.length > TABLE_COLS_MAX) return { spec: null, reason: `${given.length} columns, max ${TABLE_COLS_MAX}` };
  const columns: (Omit<TableColumn, "type"> & { type?: TableColumn["type"] })[] = [];
  const keys = new Set<string>();
  for (const [i, c] of given.entries()) {
    const col = typeof c === "string" ? { key: c } : isRecord(c) ? c : null;
    if (!col) return { spec: null, reason: `column ${i + 1} isn't a name or an object` };
    const key = typeof col.key === "string" && col.key !== "" ? col.key : typeof col.label === "string" && col.label !== "" ? col.label : null;
    if (key === null) return { spec: null, reason: `column ${i + 1} has no key` };
    if (keys.has(key)) return { spec: null, reason: `column "${key}" is listed twice` };
    keys.add(key);
    const type = col.type;
    if (type !== undefined && (typeof type !== "string" || !COLUMN_TYPES.has(type as TableColumn["type"]))) return { spec: null, reason: `column "${key}" has an unknown type (text, number, currency or percent)` };
    const out: (typeof columns)[number] = { key, label: clip(typeof col.label === "string" && col.label.trim() ? col.label.trim() : key, counter) };
    if (type !== undefined) out.type = type as TableColumn["type"];
    if (typeof col.unit === "string" && col.unit.trim()) out.unit = clip(col.unit.trim(), counter);
    columns.push(out);
  }

  const cell = (v: unknown): TableCell => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") return clip(v, counter);
    if (typeof v === "boolean") return String(v);
    counter.flattened++;
    let json: string;
    try {
      json = JSON.stringify(v) ?? "";
    } catch {
      json = String(v);
    }
    return clip(json, counter);
  };
  const rows: TableCell[][] = [];
  for (const [i, r] of rawRows.entries()) {
    if (isRecord(r)) rows.push(columns.map((c) => cell(r[c.key])));
    else if (Array.isArray(r)) rows.push(columns.map((_, j) => cell(r[j])));
    else return { spec: null, reason: `row ${i + 1} isn't an object or a list` };
  }
  // An untyped column is a number column when every filled cell is a number. A
  // declared number column takes numeric strings ("12", "-3.5") as numbers, and
  // reads as text when real text is left in it (an error message, a label).
  let demoted = 0;
  const typed: TableColumn[] = columns.map((c, j) => {
    const filled = rows.map((r) => r[j]).filter((v) => v !== null);
    if (!c.type) return { ...c, type: filled.length > 0 && filled.every((v) => typeof v === "number") ? "number" : "text" };
    if (c.type === "text") return c as TableColumn;
    const numeric = filled.every((v) => typeof v === "number" || /^[+-]?\d+(\.\d+)?$/.test(v!.trim()));
    if (!numeric) {
      demoted++;
      return { ...c, type: "text" };
    }
    for (const r of rows) if (typeof r[j] === "string") r[j] = Number((r[j] as string).trim());
    return c as TableColumn;
  });
  const spec: TableSpec = { name: "table", columns: typed, rows };
  if (typeof props.title === "string" && props.title.trim()) spec.title = clip(props.title.trim(), counter);
  const size = JSON.stringify(spec).length;
  if (size > WIDGET_JSON_MAX) return { spec: null, reason: `the table is ${Math.round(size / 1000)} KB, max ${WIDGET_JSON_MAX / 1000} KB: fewer rows or columns` };
  const notes: string[] = [];
  if (counter.clipped) notes.push(`${counter.clipped} text${counter.clipped === 1 ? "" : "s"} clipped to ${UI_TEXT_MAX} characters`);
  if (counter.flattened) notes.push(`${counter.flattened} nested value${counter.flattened === 1 ? "" : "s"} shown as JSON`);
  if (demoted) notes.push(`${demoted} number column${demoted === 1 ? "" : "s"} shown as text (it holds text)`);
  return { spec, notes };
}

/** Check what a script asked to show: a known kind with props the catalog accepts. */
export function validateWidget(kind: unknown, props: unknown): WidgetValidation {
  if (typeof kind !== "string" || !(WIDGET_KINDS as readonly string[]).includes(kind)) {
    return { spec: null, reason: `kind must be one of ${WIDGET_KINDS.join(", ")}` };
  }
  if (!isRecord(props)) return { spec: null, reason: "props must be an object" };
  if (kind === "table") return validateTable(props);
  const { complete: _complete, name: _name, ...rest } = props;
  return validateUiDetailed(kind, JSON.stringify(rest));
}

/** `table "Top files", 240 rows`: what the model reads in place of the data it showed. */
export function widgetSummary(spec: WidgetSpec): string {
  const count =
    spec.name === "table" ? [spec.rows.length, "row"] :
    spec.name === "stat" ? [spec.stats.length, "tile"] :
    spec.name === "chart" ? [spec.series.length, "bar"] :
    spec.name === "compare" ? [spec.rows.length, "row"] :
    spec.name === "cards" || spec.name === "checklist" ? [spec.items.length, "item"] :
    spec.name === "timeline" ? [spec.steps.length, "step"] : null;
  const title = spec.title ? ` "${spec.title.slice(0, 80)}"` : "";
  const n = count ? `, ${count[0]} ${count[1]}${count[0] === 1 ? "" : "s"}` : "";
  return `${spec.name}${title}${n}`;
}

export type EnvelopeRead = { envelope: WidgetEnvelope; spec: WidgetSpec } | { envelope: null; reason: string };

/** A stored envelope, re-checked before it is drawn; an unknown version or a spec the catalog refuses says why. */
export function readEnvelope(v: unknown): EnvelopeRead {
  if (!isRecord(v)) return { envelope: null, reason: "it isn't a widget" };
  if (v.schemaVersion !== 1) return { envelope: null, reason: "it was made by a newer CubiQ" };
  const spec = v.spec;
  if (!isRecord(spec) || typeof spec.name !== "string") return { envelope: null, reason: "it has no spec" };
  const checked = validateWidget(spec.name, spec);
  if (!checked.spec) return { envelope: null, reason: checked.reason };
  return { envelope: v as unknown as WidgetEnvelope, spec: checked.spec };
}

/** The envelope for the `index`th widget a script call (`ownerId`) showed. */
export function scriptEnvelope(spec: WidgetSpec, ownerId: string, index: number, complete: boolean, observedAt = Date.now()): WidgetEnvelope {
  return { schemaVersion: 1, widgetId: `${ownerId}:w${index + 1}`, ownerId, revision: 1, provenance: { kind: "computed", tool: "run_code", observedAt, complete }, spec };
}
