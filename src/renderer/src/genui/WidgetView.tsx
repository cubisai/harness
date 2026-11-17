import { useMemo } from "react";
import { readEnvelope, type TableCell, type TableColumn, type TableSpec } from "../../../shared/genui/widget";
import { SmartTable } from "./SmartTable";
import { UiSpecView } from "./UiBlock";

const ISO_CURRENCY = /^[A-Z]{3}$/;

/** A typed cell as shown: grouped digits (exact up to 10 decimals), the column's currency or %, empty for null. */
export function formatCell(cell: TableCell, column: TableColumn): string {
  if (cell === null) return "";
  if (typeof cell === "string") return cell;
  if (column.type === "currency" && column.unit && ISO_CURRENCY.test(column.unit)) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: column.unit, maximumFractionDigits: 10 }).format(cell);
    } catch {
      // An unknown code: fall through to the plain number.
    }
  }
  const n = cell.toLocaleString(undefined, { maximumFractionDigits: 10 });
  return column.type === "percent" ? `${n}%` : n;
}

/** A column header: its label, with a unit the cells don't already show ("Latency (ms)"). */
function headerOf(column: TableColumn): string {
  const shownInCells = column.type === "currency" && column.unit !== undefined && ISO_CURRENCY.test(column.unit);
  return column.unit && !shownInCells ? `${column.label} (${column.unit})` : column.label;
}

const NUMERIC = new Set<TableColumn["type"]>(["number", "currency", "percent"]);

/** A script's typed table: the smart table over display text, with sort, chart and CSV on the exact values. */
export function DataTable({ spec }: { spec: TableSpec }) {
  const rows = useMemo(() => spec.rows.map((row) => row.map((cell, j) => formatCell(cell, spec.columns[j]!))), [spec]);
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <SmartTable
        header={spec.columns.map(headerOf)}
        // The first column names the row, so it reads left even when it holds numbers (an index, a year).
        align={spec.columns.map((c, j) => (j > 0 && NUMERIC.has(c.type) ? "right" : null))}
        rows={rows}
        raw={spec.rows}
        numeric={spec.columns.map((c) => NUMERIC.has(c.type))}
        renderCell={(cell) => cell}
      />
    </>
  );
}

/**
 * A widget a run_code script showed (a `widget` thread event): re-checked
 * against the catalog, drawn like an inline block, with one muted line saying
 * it came from a script's data (and when that data was partial).
 */
export function WidgetView({ envelope }: { envelope: unknown }) {
  const read = useMemo(() => readEnvelope(envelope), [envelope]);
  if (!read.envelope) return <div className="ui-fallback-note">Couldn't draw this widget: {read.reason}</div>;
  const { spec } = read;
  const rows = spec.name === "table" ? spec.rows.length : null;
  const complete = read.envelope.provenance?.complete !== false;
  return (
    <div className="ui-block" data-ui={spec.name} data-widget={read.envelope.widgetId}>
      {spec.name === "table" ? <DataTable spec={spec} /> : <UiSpecView spec={spec} />}
      <div className="ui-source">
        From a script's data{rows !== null ? ` · ${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"}` : ""}
        {complete ? "" : " · partial"}
      </div>
    </div>
  );
}
