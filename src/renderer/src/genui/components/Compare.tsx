import { UiActions } from "../UiActions";
import type { CompareSpec } from "../types";

/** Markdown for a compare block: an optional title, then a GFM table with pipes escaped. */
export function compareMarkdown(spec: CompareSpec): string {
  const esc = (cell: string) => cell.replace(/\|/g, "\\|");
  const header = `| ${spec.headers.map(esc).join(" | ")} |`;
  const delim = `| ${spec.headers.map(() => "---").join(" | ")} |`;
  const rows = spec.rows.map((row) => `| ${row.map(esc).join(" | ")} |`);
  const table = [header, delim, ...rows].join("\n");
  return spec.title ? `**${spec.title}**\n\n${table}` : table;
}

/** A comparison table; the highlighted row (`spec.highlight`, 0-based) is tinted. */
export function Compare({ spec }: { spec: CompareSpec }) {
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <table className="ui-compare">
        <thead>
          <tr>
            {spec.headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, i) => (
            <tr key={i} className={i === spec.highlight ? "hl" : undefined}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <UiActions markdown={compareMarkdown(spec)} />
    </>
  );
}
