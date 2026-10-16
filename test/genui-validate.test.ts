import { describe, expect, it } from "vitest";
import { evaluateFormula } from "../src/renderer/src/genui/formula";
import { validateUi } from "../src/renderer/src/genui/validate";
import { UI_BODY_MAX, UI_ITEMS_MAX, UI_TEXT_MAX } from "../src/renderer/src/genui/types";
import type { CalculatorSpec, ChecklistSpec, CompareSpec, TimelineSpec } from "../src/renderer/src/genui/types";

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

describe("validateUi", () => {
  it("accepts a valid minimal spec for each name", () => {
    expect(checklist({ items: [{ text: "buy milk", done: true }] }).items).toEqual([{ text: "buy milk", done: true }]);
    expect(calculator({ inputs: [{ id: "a", label: "A", value: 2 }, { id: "b", label: "B", value: 3 }], formula: "a*b+2" }).formula).toBe("a*b+2");
    expect(compare({ headers: ["Name", "Qty"], rows: [["Apples", "3"]] }).rows).toEqual([["Apples", "3"]]);
    expect(timeline({ steps: [{ title: "Kickoff" }] }).steps).toEqual([{ title: "Kickoff" }]);
  });

  it("rejects an unknown name", () => {
    expect(validateUi("chart", JSON.stringify({}))).toBeNull();
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

  it("rejects a compare row whose cell count does not match the headers", () => {
    expect(validateUi("compare", JSON.stringify({ headers: ["A", "B"], rows: [["1"]] }))).toBeNull();
    expect(validateUi("compare", JSON.stringify({ headers: ["A", "B"], rows: [["1", "2", "3"]] }))).toBeNull();
  });

  it("rejects a calculator whose formula references an unknown input", () => {
    expect(validateUi("calculator", JSON.stringify({ inputs: [{ id: "a", label: "A", value: 1 }], formula: "a+b" }))).toBeNull();
  });
});

describe("evaluateFormula", () => {
  it("evaluates a formula against its variables", () => {
    expect(evaluateFormula("a*b+2", { a: 2, b: 3 })).toBe(8);
  });

  it("honours precedence and unary minus", () => {
    expect(evaluateFormula("-(2+3)*2", {})).toBe(-10);
  });

  it("rejects calls, property access and division by zero", () => {
    expect(evaluateFormula("alert(1)", {})).toBeNull();
    expect(evaluateFormula("a.constructor", { a: 1 })).toBeNull();
    expect(evaluateFormula("1/0", {})).toBeNull();
  });
});
