import { useId, useState } from "react";
import { evaluateFormula } from "../formula";
import { UiActions } from "../UiActions";
import type { CalculatorSpec } from "../types";

/** The result string the calculator shows, unit included; "—" when undefined. */
export function formatResult(result: number | null, unit?: string): string {
  if (result === null || !Number.isFinite(result)) return "—";
  return `${result.toLocaleString(undefined, { maximumFractionDigits: 4 })}${unit ? ` ${unit}` : ""}`;
}

/** Markdown for a calculator: one line per input at its current value, then the result. */
export function calculatorMarkdown(spec: CalculatorSpec, values: Record<string, number>): string {
  const lines = spec.inputs.map((input) => {
    const raw = values[input.id];
    const shown = raw === undefined || !Number.isFinite(raw) ? "—" : String(raw);
    return `- ${input.label}: ${shown}${input.unit ? ` ${input.unit}` : ""}`;
  });
  lines.push(`**Result: ${formatResult(evaluateFormula(spec.formula, values), spec.unit)}**`);
  return spec.title ? `**${spec.title}**\n\n${lines.join("\n")}` : lines.join("\n");
}

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
      <div className="ui-result">{formatResult(result, spec.unit)}</div>
      {spec.note ? <div className="ui-note">{spec.note}</div> : null}
      <UiActions markdown={calculatorMarkdown(spec, values)} />
    </>
  );
}
