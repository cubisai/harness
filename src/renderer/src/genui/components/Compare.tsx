import { UiActions } from "../UiActions";
import type { CompareSpec } from "../types";

/** The block's best cells as "row:column" keys. */
function bestKeys(spec: CompareSpec): Set<string> {
  return new Set((spec.best ?? []).map(([r, c]) => `${r}:${c}`));
}

/** Markdown for a compare block: an optional title, then a GFM table with pipes escaped; best cells in bold. */
export function compareMarkdown(spec: CompareSpec): string {
  const best = bestKeys(spec);
  const esc = (cell: string) => cell.replace(/\|/g, "\\|");
  const header = `| ${spec.headers.map(esc).join(" | ")} |`;
  const delim = `| ${spec.headers.map(() => "---").join(" | ")} |`;
  const rows = spec.rows.map((row, i) => `| ${row.map((cell, j) => (best.has(`${i}:${j}`) && cell ? `**${esc(cell)}**` : esc(cell))).join(" | ")} |`);
  const table = [header, delim, ...rows].join("\n");
  return spec.title ? `**${spec.title}**\n\n${table}` : table;
}

/** A comparison table; the highlighted row (`spec.highlight`, 0-based) is tinted and best cells are marked. */
export function Compare({ spec }: { spec: CompareSpec }) {
  const best = bestKeys(spec);
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
              {row.map((cell, j) =>
                best.has(`${i}:${j}`) ? (
                  <td key={j} className="best">
                    <span className="sr-only">Best: </span>
                    {cell}
                  </td>
                ) : (
                  <td key={j}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <UiActions markdown={compareMarkdown(spec)} />
    </>
  );
}
