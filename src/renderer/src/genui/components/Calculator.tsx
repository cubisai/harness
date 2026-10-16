import { useId, useState } from "react";
import { evaluateFormula } from "../formula";
import type { CalculatorSpec } from "../types";

/** A live calculator: local inputs, the formula re-evaluated on every change. */
export function Calculator({ spec }: { spec: CalculatorSpec }) {
  const base = useId();
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(spec.inputs.map((i): [string, number] => [i.id, i.value])),
  );
  const result = evaluateFormula(spec.formula, values);
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      {spec.inputs.map((input, i) => {
        const raw = values[input.id];
        return (
          <label key={input.id} className="ui-field" htmlFor={`${base}-${i}`}>
            <span className="ui-field-label">{input.label}</span>
            <input
              id={`${base}-${i}`}
              type="number"
              min={input.min}
              max={input.max}
              step={input.step}
              value={raw === undefined || !Number.isFinite(raw) ? "" : raw}
              onChange={(e) => setValues((v) => ({ ...v, [input.id]: e.target.valueAsNumber }))}
            />
            {input.unit ? <span className="ui-unit">{input.unit}</span> : null}
          </label>
        );
      })}
      <div className="ui-result">
        {result === null || !Number.isFinite(result)
          ? "—"
          : `${result.toLocaleString(undefined, { maximumFractionDigits: 4 })}${spec.unit ? ` ${spec.unit}` : ""}`}
      </div>
      {spec.note ? <div className="ui-note">{spec.note}</div> : null}
    </>
  );
}
