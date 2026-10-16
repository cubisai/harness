import { useState } from "react";
import type { ChecklistSpec } from "../types";

/** A checklist: ticking is local and throwaway, nothing is stored back. */
export function Checklist({ spec }: { spec: ChecklistSpec }) {
  const [done, setDone] = useState<boolean[]>(() => spec.items.map((it) => it.done));
  const count = done.filter(Boolean).length;
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      {spec.items.map((item, i) => (
        <label key={i} className="ui-check">
          <input
            type="checkbox"
            checked={done[i] ?? false}
            onChange={() => setDone((flags) => flags.map((v, j) => (j === i ? !v : v)))}
          />
          <span>{item.text}</span>
        </label>
      ))}
      <div className="ui-meta">
        {count} of {spec.items.length} done
      </div>
      {spec.note ? <div className="ui-note">{spec.note}</div> : null}
    </>
  );
}
