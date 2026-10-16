import type { ChartSpec } from "../types";
import { UiActions } from "../UiActions";

/** Horizontal bars drawn relative to the largest value; each value is also shown as text. */
export function ChartBars({ series, unit, label }: { series: { label: string; value: number }[]; unit?: string; label: string }) {
  const max = Math.max(...series.map((entry) => entry.value));
  return (
    <ul className="ui-chart" aria-label={label}>
      {series.map((entry, i) => (
        <li key={i}>
          <span className="ui-chart-label">{entry.label}</span>
          <div className="ui-chart-track">
            <div className="ui-chart-bar" style={{ width: `${max > 0 ? (entry.value / max) * 100 : 0}%` }} />
          </div>
          <span className="ui-chart-value">
            {format(entry.value)}
            {unit ? ` ${unit}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A chart block: an optional title, its bars, and the block's Copy / Use in reply actions. */
export function Chart({ spec }: { spec: ChartSpec }) {
  const md =
    (spec.title ? `**${spec.title}**\n\n` : "") +
    spec.series.map((entry) => `- ${entry.label}: ${format(entry.value)}${spec.unit ? ` ${spec.unit}` : ""}`).join("\n");
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <ChartBars series={spec.series} unit={spec.unit} label={spec.title ?? "Chart"} />
      <UiActions markdown={md} />
    </>
  );
}

/** A value as shown in the row: grouped digits, up to two decimals. */
function format(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
