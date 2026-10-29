import { useState, type ReactNode } from "react";
import { ChartBars } from "./components/Chart";

/**
 * "Smart tables" and task lists in agent replies, drawn only when the user's
 * `uiBlocks` setting is on (markdown.tsx decides). A smart table is the same
 * markdown table as before, plus hover controls above it: filter, sort a
 * column by clicking its header, copy as CSV, or draw a numeric column as bars.
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

/** The table as RFC 4180 CSV: a header row then each row, newline-separated. */
export function tableCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

function csvField(field: string): string {
  return /[",\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** The first column (index ≥ 1, so labels stay on the left) whose every cell is a non-negative number, or null. */
export function chartColumn(rows: string[][]): number | null {
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((row) => row.length));
  for (let col = 1; col < width; col++) {
    const numeric = rows.every((row) => {
      const value = cellNumber(row[col] ?? "");
      return value !== null && value >= 0;
    });
    if (numeric) return col;
  }
  return null;
}

/** Sort two cells: numerically when both read as numbers, else naturally, case-insensitively. */
function compareCells(a: string, b: string): number {
  const na = cellNumber(a);
  const nb = cellNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** One reply's markdown table with filter, sort, chart and Copy CSV (DESIGN.md §7.4). */
export function SmartTable({
  header,
  align,
  rows,
  renderCell,
}: {
  header: string[];
  align: ("left" | "center" | "right" | null)[];
  rows: string[][];
  renderCell: (cell: string) => ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [view, setView] = useState<"table" | "chart">("table");
  const [copied, setCopied] = useState(false);

  const chartCol = chartColumn(rows);
  const query = filter.trim().toLowerCase();
  const matched = query ? rows.filter((row) => row.join(" ").toLowerCase().includes(query)) : rows;
  const sorted = sort ? [...matched].sort((a, b) => (sort.dir === "asc" ? 1 : -1) * compareCells(a[sort.col] ?? "", b[sort.col] ?? "")) : matched;

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
            void navigator.clipboard?.writeText(tableCsv(header, sorted)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy CSV"}
        </button>
      </div>
      {view === "chart" && chartCol !== null ? (
        <>
          <div className="ui-title">{header[chartCol]}</div>
          <ChartBars
            series={sorted.map((row) => ({ label: row[0] ?? "", value: cellNumber(row[chartCol] ?? "") ?? 0 }))}
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
            {sorted.map((row, j) => (
              <tr key={j}>
                {row.map((cell, k) => (
                  <td key={k}>{renderCell(cell)}</td>
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
    </div>
  );
}
