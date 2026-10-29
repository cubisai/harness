import { describe, expect, it } from "vitest";
import { evaluateFormula } from "../src/renderer/src/genui/formula";
import { validateUi } from "../src/renderer/src/genui/validate";
import { UI_BODY_MAX, UI_ITEMS_MAX, UI_TEXT_MAX } from "../src/renderer/src/genui/types";
import type { CalculatorSpec, ChartSpec, ChecklistSpec, CompareSpec, TimelineSpec } from "../src/renderer/src/genui/types";

const checklist = (body: unknown): ChecklistSpec => {
  const spec = validateUi("checklist", JSON.stringify(body));
  if (!spec || spec.name !== "checklist") throw new Error("expected a valid checklist");
  return spec;
};

const calculator = (body: unknown): CalculatorSpec => {
  const spec = validateUi("calculator", JSON.stringify(body));
  if (!spec || spec.name !== "calculator") throw new Error("expected a valid calculator");
  return spec;
};

const compare = (body: unknown): CompareSpec => {
  const spec = validateUi("compare", JSON.stringify(body));
  if (!spec || spec.name !== "compare") throw new Error("expected a valid compare");
  return spec;
};

const timeline = (body: unknown): TimelineSpec => {
  const spec = validateUi("timeline", JSON.stringify(body));
  if (!spec || spec.name !== "timeline") throw new Error("expected a valid timeline");
  return spec;
};

const chart = (body: unknown): ChartSpec => {
  const spec = validateUi("chart", JSON.stringify(body));
  if (!spec || spec.name !== "chart") throw new Error("expected a valid chart");
  return spec;
};

describe("validateUi", () => {
  it("accepts a valid minimal spec for each name", () => {
    expect(checklist({ items: [{ text: "buy milk", done: true }] }).items).toEqual([{ text: "buy milk", done: true }]);
    expect(calculator({ inputs: [{ id: "a", label: "A", value: 2 }, { id: "b", label: "B", value: 3 }], formula: "a*b+2" }).formula).toBe("a*b+2");
    expect(compare({ headers: ["Name", "Qty"], rows: [["Apples", "3"]] }).rows).toEqual([["Apples", "3"]]);
    expect(timeline({ steps: [{ title: "Kickoff" }] }).steps).toEqual([{ title: "Kickoff" }]);
  });

  it("rejects an unknown name", () => {
    expect(validateUi("nope", JSON.stringify({}))).toBeNull();
  });

  it("rejects invalid JSON", () => {
    expect(validateUi("checklist", "{")).toBeNull();
  });

  it("rejects a body over the size limit", () => {
    expect(validateUi("checklist", "x".repeat(UI_BODY_MAX + 1))).toBeNull();
  });

  it("rejects more than the maximum number of items", () => {
    const items = Array.from({ length: UI_ITEMS_MAX + 1 }, () => ({ text: "x" }));
    expect(validateUi("checklist", JSON.stringify({ items }))).toBeNull();
  });

  it("clips a long string to the text limit, ending with an ellipsis", () => {
    const item = checklist({ items: [{ text: "a".repeat(UI_TEXT_MAX + 50) }] }).items[0];
    if (!item) throw new Error("expected a validated item");
    expect(item.text.length).toBe(UI_TEXT_MAX);
    expect(item.text.endsWith("…")).toBe(true);
  });

  it("pads a short compare row and trims a long one", () => {
    expect(compare({ headers: ["A", "B"], rows: [["1"]] }).rows).toEqual([["1", ""]]);
    expect(compare({ headers: ["A", "B"], rows: [["1", "2", "3"]] }).rows).toEqual([["1", "2"]]);
  });

  it("keeps only in-bounds, deduped best pairs on a compare", () => {
    const spec = compare({ headers: ["A", "B", "C"], rows: [["1", "2", "3"]], best: [[0, 2], [0, 2], [0, 0], [1, 1], [0, 3], ["0", 1], [0]] });
    expect(spec.best).toEqual([[0, 2]]);
    // A malformed `best` never rejects the block.
    expect(compare({ headers: ["A", "B"], rows: [["1", "2"]], best: "nope" }).best).toBeUndefined();
  });

  it("keeps a calculator whose formula can't run, with the reason in place of a result", () => {
    expect(calculator({ inputs: [{ id: "a", label: "A", value: 1 }], formula: "a+b" }).problem).toBe("unknown b");
    expect(calculator({ inputs: [{ id: "a", label: "A", value: 1 }], formula: "a+(" }).problem).toBe("the formula doesn't parse");
    expect(calculator({ inputs: [{ id: "a", label: "A", value: 1 }] }).problem).toBe("no formula");
    expect(calculator({ inputs: [{ id: "a", label: "A", value: 2 }], formula: "a*3" }).problem).toBeUndefined();
  });

  it("accepts a valid chart, including a zero value", () => {
    expect(chart({ kind: "bars", series: [{ label: "A", value: 3 }, { label: "B", value: 0 }] }).series).toEqual([
      { label: "A", value: 3 },
      { label: "B", value: 0 },
    ]);
  });

  it("rejects a chart whose kind is not bars", () => {
    expect(validateUi("chart", JSON.stringify({ kind: "pie", series: [{ label: "A", value: 1 }] }))).toBeNull();
  });

  it("accepts a chart with a negative value and rejects a non-numeric one", () => {
    expect(chart({ kind: "bars", series: [{ label: "A", value: -1 }] }).series).toEqual([{ label: "A", value: -1 }]);
    expect(validateUi("chart", JSON.stringify({ kind: "bars", series: [{ label: "A", value: "3" }] }))).toBeNull();
  });

  it("rejects a chart with more than the maximum number of entries", () => {
    const series = Array.from({ length: UI_ITEMS_MAX + 1 }, (_, i) => ({ label: `S${i}`, value: i }));
    expect(validateUi("chart", JSON.stringify({ kind: "bars", series }))).toBeNull();
  });
});

describe("evaluateFormula", () => {
  it("evaluates a formula against its variables", () => {
    expect(evaluateFormula("a*b+2", { a: 2, b: 3 })).toBe(8);
  });

  it("honours precedence and unary minus", () => {
    expect(evaluateFormula("-(2+3)*2", {})).toBe(-10);
  });

  it("evaluates `^` and `**` as right-associative exponentiation", () => {
    expect(evaluateFormula("2^3", {})).toBe(8);
    expect(evaluateFormula("2**3", {})).toBe(8);
    expect(evaluateFormula("2^3^2", {})).toBe(512);
  });

  it("binds unary minus looser than power, and allows it in the exponent", () => {
    expect(evaluateFormula("-2^2", {})).toBe(-4);
    expect(evaluateFormula("(-2)^2", {})).toBe(4);
    expect(evaluateFormula("2^-1", {})).toBe(0.5);
  });

  it("evaluates a loan-payment formula", () => {
    expect(evaluateFormula("principal*(rate/1200)/(1-(1+rate/1200)^(-years*12))", { principal: 200000, rate: 6, years: 30 })).toBeCloseTo(1199.1, 2);
  });

  it("rejects calls, property access and division by zero", () => {
    expect(evaluateFormula("alert(1)", {})).toBeNull();
    expect(evaluateFormula("a.constructor", { a: 1 })).toBeNull();
    expect(evaluateFormula("1/0", {})).toBeNull();
  });
});
