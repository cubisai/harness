import type { CompareSpec } from "../types";

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
    </>
  );
}
