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
    if (highlight === undefined && first !== undefined && first.startsWith("*")) {
      cells[0] = first.replace(/^\*\s*/, "");
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
  const record: Record<string, unknown> = { ...meta, inputs: rows.map(calculatorInput) };
  if (formula !== undefined) record.formula = formula;
  return record;
}
