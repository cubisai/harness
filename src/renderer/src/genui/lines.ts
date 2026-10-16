/**
 * Compact line syntax for inline UI blocks, accepted alongside JSON: one item
 * per line, `|` between fields, `# Title` / `> note` / `unit: $` meta lines
 * anywhere. Builds the same record shape the per-widget validators in
 * validate.ts accept, so both forms share one validation path.
 */

import type { UiName } from "./types";

/** `value` without commas, spaces or one leading currency symbol; "" is NaN. */
function toNumber(value: string): number {
  const clean = value.replaceAll(",", "").replace(/\s/g, "").replace(/^[$€£¥]/, "");
  return clean === "" ? Number.NaN : Number(clean);
}

/** Split a row on unescaped `|`, unescape `\|`, trim, drop one outer empty cell. */
function splitCells(row: string): string[] {
  const parts: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    const c = row.charAt(i);
    if (c === "|" && row.charAt(i - 1) !== "\\") {
      parts.push(cell);
      cell = "";
    } else {
      cell += c;
    }
  }
  parts.push(cell);
  const cells = parts.map((part) => part.replaceAll("\\|", "|").trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

/** One checklist line: `- [x] text`, `* [ ] text` or plain text. */
function checklistItem(line: string): { text: string; done: boolean } {
  const body = line.startsWith("- ") || line.startsWith("* ") ? line.slice(2).trim() : line;
  const box = /^\[([xX ])\]\s*/.exec(body);
  if (!box) return { text: body, done: false };
  const whole = box[0] ?? "";
  return { text: body.slice(whole.length), done: (box[1] ?? "").toLowerCase() === "x" };
}

/** One chart row `label | value`; a bad value stays NaN for the validator. */
function chartPoint(row: string): { label: string; value: number } {
  const cells = splitCells(row);
  return { label: cells[0] ?? "", value: toNumber(cells[1] ?? "") };
}

/** One compare row list: the first row is headers, and the first later row starting with `*` is the highlight. */
function compareRecord(meta: Record<string, string>, rows: string[]): Record<string, unknown> {
  const headers = splitCells(rows[0] ?? "");
  const body: string[][] = [];
  let highlight: number | undefined;
  for (const row of rows.slice(1)) {
    const cells = splitCells(row);
    const first = cells[0];
    // The best row: `*` before it, or (as agents also write) ` *` after any of its cells.
    const marked = cells.findIndex((c) => /\s\*$/.test(c));
    if (highlight === undefined && first !== undefined && first.startsWith("*") && !first.startsWith("**")) {
      cells[0] = first.replace(/^\*\s*/, "");
      highlight = body.length;
    } else if (highlight === undefined && marked >= 0) {
      cells[marked] = cells[marked]!.replace(/\s+\*$/, "");
      highlight = body.length;
    }
    body.push(cells);
  }
  const record: Record<string, unknown> = { ...meta, headers, rows: body };
  if (highlight !== undefined) record.highlight = highlight;
  return record;
}

/** One timeline row: `title`, `time | title` or `time | title | detail...`. */
function timelineStep(row: string): { time?: string; title: string; detail?: string } {
  const cells = splitCells(row);
  const title = cells[1];
  if (title === undefined) return { title: cells[0] ?? "" };
  const step: { time?: string; title: string; detail?: string } = { time: cells[0] ?? "", title };
  if (cells.length > 2) step.detail = cells.slice(2).join(" | ");
  return step;
}

/** One calculator row `id | label | value | unit?` as an input. */
function calculatorInput(row: string): Record<string, unknown> {
  const cells = splitCells(row);
  const input: Record<string, unknown> = { id: cells[0] ?? "", label: cells[1] ?? "", value: toNumber(cells[2] ?? "") };
  const unit = cells[3];
  if (unit !== undefined && unit !== "") input.unit = unit;
  return input;
}

/** One form row `id | label | type`: `number`, `yes/no` (a toggle), `a/b/c` (a select) or text. */
function formField(row: string): Record<string, unknown> {
  const cells = splitCells(row);
  const kind = (cells[2] ?? "").trim();
  const field: Record<string, unknown> = { id: cells[0] ?? "", label: cells[1] ?? cells[0] ?? "" };
  if (/^number$/i.test(kind)) field.type = "number";
  else if (/^(yes\/no|toggle)$/i.test(kind)) field.type = "toggle";
  else if (kind.includes("/")) {
    field.type = "select";
    field.options = kind.split("/").map((o) => o.trim());
  } else field.type = "text";
  return field;
}

/** One stat row `label | value | delta?`. */
function statTile(row: string): Record<string, unknown> {
  const cells = splitCells(row);
  const tile: Record<string, unknown> = { label: cells[0] ?? "", value: cells[1] ?? "" };
  if (cells[2]) tile.delta = cells[2];
  return tile;
}

/**
 * One cards row `lead | title | text | link`. A last cell that is an https
 * URL is the link; then three cells are lead, title, text, two are title,
 * text, and one is the title.
 */
function cardItem(row: string): Record<string, unknown> {
  const cells = splitCells(row);
  const item: Record<string, unknown> = {};
  if (cells.length > 1 && /^https:\/\/\S+$/.test(cells.at(-1) ?? "")) item.link = cells.pop();
  if (cells.length >= 3) {
    item.lead = cells[0];
    item.title = cells[1];
    item.text = cells.slice(2).join(" | ");
  } else if (cells.length === 2) {
    item.title = cells[0];
    item.text = cells[1];
  } else item.title = cells[0] ?? "";
  return item;
}

/**
 * Convert a compact line-syntax body into the record shape the per-widget
 * validators in validate.ts accept, or null when it has no item rows.
 */
export function parseUiLines(name: UiName, body: string): Record<string, unknown> | null {
  const meta: Record<string, string> = {};
  const rows: string[] = [];
  let formula: string | undefined;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^#\s/.test(line)) {
      meta.title = line.slice(1).trim();
      continue;
    }
    if (/^>\s/.test(line)) {
      meta.note = line.slice(1).trim();
      continue;
    }
    const unit = /^unit\s*:(.*)$/i.exec(line);
    if (unit) {
      meta.unit = (unit[1] ?? "").trim();
      continue;
    }
    if (/^\|?\s*:?-{3,}/.test(line)) continue;
    if (name === "calculator" && line.startsWith("=")) {
      formula = line.slice(1).trim();
      continue;
    }
    rows.push(line);
  }
  if (rows.length === 0) return null;
  if (name === "checklist") return { ...meta, items: rows.map(checklistItem) };
  if (name === "chart") return { ...meta, kind: "bars", series: rows.map(chartPoint) };
  if (name === "compare") return compareRecord(meta, rows);
  if (name === "timeline") return { ...meta, steps: rows.map(timelineStep) };
  if (name === "choices") {
    // Agents often put the question first without `# `: a leading line ending in "?" is the title.
    const options = rows.map((row) => row.replace(/^[-*]\s+/, ""));
    if (meta.title === undefined && options.length > 2 && options[0]!.endsWith("?")) meta.title = options.shift()!;
    return { ...meta, options };
  }
  if (name === "form") return { ...meta, fields: rows.map(formField) };
  if (name === "stat") return { ...meta, stats: rows.map(statTile) };
  if (name === "cards") return { ...meta, items: rows.map(cardItem) };
  const record: Record<string, unknown> = { ...meta, inputs: rows.map(calculatorInput) };
  if (formula !== undefined) record.formula = formula;
  return record;
}
