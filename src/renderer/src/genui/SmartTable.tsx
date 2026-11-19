import { useState, type ReactNode } from "react";
import type { TableCell } from "../../../shared/genui/widget";
import { ChartBars } from "./components/Chart";

/**
 * "Smart tables" and task lists in agent replies, drawn only when the user's
 * `uiBlocks` setting is on (markdown.tsx decides). A smart table is the same
 * markdown table as before, plus hover controls above it: filter, sort a
 * column by clicking its header, copy as a table, or draw a numeric column as bars.
 * Nothing here is stored; the state lives with the rendered reply.
 */

/** A cell's number: optional emphasis markers, a sign, a currency symbol, grouped digits and a trailing %. */
export function cellNumber(cell: string): number | null {
  const text = cell
    .trim()
    .replace(/^(\*\*|\*|`)+/, "")
    .replace(/(\*\*|\*|`)+$/, "")
    .trim();
  const match = /^([+-]?)([$€£¥]?)(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?%?$/.exec(text);
  if (!match) return null;
  const value = Number(`${match[1]}${match[3]}${match[4] ?? ""}`.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** The table as RFC 4180 CSV: a header row then each row, newline-separated; formula-like cells are neutralised. Typed cells keep their exact numbers. */
export function tableCsv(header: string[], rows: (string | number | null)[][]): string {
  return [header, ...rows].map((row) => row.map((cell) => (typeof cell === "number" ? String(cell) : cell === null ? "" : csvField(cell))).join(",")).join("\n");
}

/** A cell a spreadsheet would run as a formula (=, +, -, @, tab, CR first) gets a leading ' (OWASP CSV injection); a plain number like -3 stays as it is. */
function neutralise(raw: string): string {
  return /^[=+\-@\t\r]/.test(raw) && !/^[+-]?\d+(\.\d+)?$/.test(raw.trim()) ? `'${raw}` : raw;
}

function csvField(raw: string): string {
  const field = neutralise(raw);
  return /[",\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

type Cell = string | number | null;
const cellText = (cell: Cell): string => (typeof cell === "number" ? String(cell) : cell === null ? "" : neutralise(cell));

/** Tab-separated rows: pastes into separate cells in Sheets/Excel and lines up in plain text. Tabs and line breaks inside a cell become spaces. */
export function tableTsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((row) => row.map((cell) => cellText(cell).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A plain HTML table: pastes as a real table into Docs, Notion, Mail and Sheets. Numbers align right. */
export function tableHtml(header: string[], rows: Cell[][]): string {
  const head = header.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td${typeof cell === "number" ? ' style="text-align:right"' : ""}>${escapeHtml(cellText(cell))}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Puts the table on the clipboard as HTML (a formatted table) with tab-separated text beside it; plain text only where rich copy isn't available. */
async function copyTable(header: string[], rows: Cell[][]): Promise<void> {
  const tsv = tableTsv(header, rows);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const item = new ClipboardItem({ "text/html": new Blob([tableHtml(header, rows)], { type: "text/html" }), "text/plain": new Blob([tsv], { type: "text/plain" }) });
    await navigator.clipboard.write([item]);
  } else {
    await navigator.clipboard?.writeText(tsv);
  }
}

/** A number cell's unit marks: its currency symbol and a trailing %, so "$12" and "€12" (or "12%" and "12") never share a chart. */
function cellUnit(cell: string): string {
  const text = cell.trim().replace(/^(\*\*|\*|`)+/, "").replace(/(\*\*|\*|`)+$/, "").trim();
  return `${/[$€£¥]/.exec(text)?.[0] ?? ""}${text.endsWith("%") ? "%" : ""}`;
}

/** The first column (index ≥ 1, so labels stay on the left) whose every cell is a non-negative number in one unit, or null. */
export function chartColumn(rows: string[][]): number | null {
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((row) => row.length));
  for (let col = 1; col < width; col++) {
    const numeric = rows.every((row) => {
      const value = cellNumber(row[col] ?? "");
      return value !== null && value >= 0;
    });
    if (numeric && new Set(rows.map((row) => cellUnit(row[col] ?? ""))).size === 1) return col;
  }
  return null;
}

/** Rows a table shows at once; past it, Previous/Next pages through the rest (filter, sort, chart and copy still see every row). */
export const PAGE_ROWS = 50;

/** Sort two cells: numerically when both read as numbers, else naturally, case-insensitively. */
function compareCells(a: string, b: string): number {
  const na = cellNumber(a);
  const nb = cellNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Sort two typed cells: numbers by value, text naturally, empty cells last either way. */
function compareTyped(a: TableCell, b: TableCell, dir: 1 | -1): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return dir * (a - b);
  return dir * String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** A typed table's chart column: the first number column (index ≥ 1) with a value in every row. */
function typedChartColumn(raw: TableCell[][], numeric: boolean[]): number | null {
  if (raw.length < 2) return null;
  for (let col = 1; col < numeric.length; col++) if (numeric[col] && raw.every((row) => typeof row[col] === "number")) return col;
  return null;
}

/**
 * One reply's markdown table with filter, sort, chart and Copy table (DESIGN.md §7.4).
 * A typed table (a script's `show("table")`) also passes `raw`, the exact cells
 * behind each shown string, and `numeric`, which columns hold numbers of one
 * unit: sort, chart and copy then use the exact values, not the display text.
 */
export function SmartTable({
  header,
  align,
  rows,
  renderCell,
  raw,
  numeric,
}: {
  header: string[];
  align: ("left" | "center" | "right" | null)[];
  rows: string[][];
  renderCell: (cell: string) => ReactNode;
  raw?: TableCell[][];
  numeric?: boolean[];
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [view, setView] = useState<"table" | "chart">("table");
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState(0);

  const typed = raw !== undefined && raw.length === rows.length;
  const chartCol = typed ? typedChartColumn(raw, numeric ?? []) : chartColumn(rows);
  const query = filter.trim().toLowerCase();
  // Row indexes, so the shown text and the exact values stay paired through filter and sort.
  const all = rows.map((_, i) => i);
  const matched = query ? all.filter((i) => rows[i]!.join(" ").toLowerCase().includes(query)) : all;
  const order = sort
    ? [...matched].sort((a, b) =>
        typed ? compareTyped(raw[a]![sort.col] ?? null, raw[b]![sort.col] ?? null, sort.dir === "asc" ? 1 : -1) : (sort.dir === "asc" ? 1 : -1) * compareCells(rows[a]![sort.col] ?? "", rows[b]![sort.col] ?? ""),
      )
    : matched;
  const sorted = order.map((i) => rows[i]!);
  // A filter or sort that leaves fewer pages lands on the last one there is.
  const pages = Math.max(1, Math.ceil(order.length / PAGE_ROWS));
  const at = Math.min(page, pages - 1);
  const shown = order.slice(at * PAGE_ROWS, (at + 1) * PAGE_ROWS);
  const value = (i: number, col: number): number => (typed ? (raw[i]![col] as number) : (cellNumber(rows[i]![col] ?? "") ?? 0));

  /** asc → desc → the agent's own order. */
  const cycleSort = (col: number) => {
    setSort((s) => (s && s.col === col ? (s.dir === "asc" ? { col, dir: "desc" } : null) : { col, dir: "asc" }));
  };

  return (
    <div className="smart-table">
      <div className="smart-table-bar">
        {rows.length > 8 ? (
          <input
            type="search"
            className="smart-table-filter"
            placeholder="Filter"
            aria-label="Filter rows"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        ) : null}
        {chartCol !== null ? (
          <button type="button" className="code-copy" onClick={() => setView((v) => (v === "table" ? "chart" : "table"))}>
            {view === "table" ? "Chart" : "Table"}
          </button>
        ) : null}
        <button
          type="button"
          className="code-copy"
          onClick={() => {
            void copyTable(header, typed ? order.map((i) => raw[i]!) : sorted).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy table"}
        </button>
      </div>
      {view === "chart" && chartCol !== null ? (
        <>
          <div className="ui-title">{header[chartCol]}</div>
          <ChartBars
            series={shown.map((i) => ({ label: rows[i]![0] ?? "", value: value(i, chartCol) }))}
            label={header[chartCol] ?? "Chart"}
          />
        </>
      ) : (
        <table>
          <thead>
            <tr>
              {header.map((cell, j) => {
                const dir = sort && sort.col === j ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
                return (
                  <th key={j} style={align[j] ? { textAlign: align[j]! } : undefined} aria-sort={dir}>
                    <button type="button" className="smart-th" onClick={() => cycleSort(j)}>
                      {renderCell(cell)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i}>
                {rows[i]!.map((cell, k) => (
                  <td key={k} style={align[k] ? { textAlign: align[k]! } : undefined}>
                    {renderCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={header.length} className="smart-table-empty">
                  No matching rows
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
      {pages > 1 ? (
        <div className="smart-table-pager">
          <button type="button" className="code-copy" disabled={at === 0} onClick={() => setPage(at - 1)}>
            Previous
          </button>
          <span aria-live="polite">
            {(at * PAGE_ROWS + 1).toLocaleString()}–{Math.min((at + 1) * PAGE_ROWS, order.length).toLocaleString()} of {order.length.toLocaleString()}
          </span>
          <button type="button" className="code-copy" disabled={at === pages - 1} onClick={() => setPage(at + 1)}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
