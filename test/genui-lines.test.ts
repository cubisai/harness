import { describe, expect, it } from "vitest";
import { validateUi } from "../src/renderer/src/genui/validate";
import type { UiSpec } from "../src/renderer/src/genui/types";

/** Validate a line-form or JSON body, failing loudly when it is not usable. */
function spec(name: string, body: string): UiSpec {
  const ui = validateUi(name, body);
  if (!ui) throw new Error(`expected a valid ${name} block`);
  return ui;
}

describe("validateUi line form", () => {
  it("matches the JSON form for a checklist", () => {
    const lines = ["# Groceries", "- [x] buy milk", "- [ ] bread", "> from the bakery"].join("\n");
    const json = JSON.stringify({
      title: "Groceries",
      items: [
        { text: "buy milk", done: true },
        { text: "bread", done: false },
      ],
      note: "from the bakery",
    });
    expect(spec("checklist", lines)).toEqual(spec("checklist", json));
  });

  it("matches the JSON form for a calculator", () => {
    const lines = ["# Trip", "Distance | Distance | 120 | km", "Rate | Rate | 0.5", "= Distance*Rate"].join("\n");
    const json = JSON.stringify({
      title: "Trip",
      inputs: [
        { id: "Distance", label: "Distance", value: 120, unit: "km" },
        { id: "Rate", label: "Rate", value: 0.5 },
      ],
      formula: "Distance*Rate",
    });
    expect(spec("calculator", lines)).toEqual(spec("calculator", json));
  });

  it("matches the JSON form for a compare", () => {
    const lines = ["Plan | Cost | Speed", "* Pro | 10 | Fast", "Free | 0 | Slow"].join("\n");
    const json = JSON.stringify({
      headers: ["Plan", "Cost", "Speed"],
      rows: [
        ["Pro", "10", "Fast"],
        ["Free", "0", "Slow"],
      ],
      highlight: 0,
    });
    expect(spec("compare", lines)).toEqual(spec("compare", json));
  });

  it("matches the JSON form for a timeline", () => {
    const lines = ["# Launch", "2026-01-01 | Kickoff | team of 4 | office", "2026-02-01 | Beta", "Next"].join("\n");
    const json = JSON.stringify({
      title: "Launch",
      steps: [
        { time: "2026-01-01", title: "Kickoff", detail: "team of 4 | office" },
        { time: "2026-02-01", title: "Beta" },
        { title: "Next" },
      ],
    });
    expect(spec("timeline", lines)).toEqual(spec("timeline", json));
  });

  it("matches the JSON form for a chart", () => {
    const lines = ["# Sales", "Mon | $1,200", "Tue | 900", "unit: $"].join("\n");
    const json = JSON.stringify({
      title: "Sales",
      kind: "bars",
      series: [
        { label: "Mon", value: 1200 },
        { label: "Tue", value: 900 },
      ],
      unit: "$",
    });
    expect(spec("chart", lines)).toEqual(spec("chart", json));
  });

  it("accepts surrounding bars and a backslash-escaped pipe inside a cell", () => {
    expect(spec("compare", ["| Name | Detail |", "| Wheel \\| Tyre | ok |"].join("\n"))).toEqual({
      name: "compare",
      headers: ["Name", "Detail"],
      rows: [["Wheel | Tyre", "ok"]],
    });
  });

  it("skips a GFM delimiter row", () => {
    expect(spec("compare", ["Name | Qty", "|---|:---|", "Apples | 3"].join("\n"))).toEqual({
      name: "compare",
      headers: ["Name", "Qty"],
      rows: [["Apples", "3"]],
    });
  });

  it("normalizes CRLF and lone CR", () => {
    const expected = spec("checklist", "# List\n- [x] one\n- [ ] two");
    expect(spec("checklist", "# List\r\n- [x] one\r\n- [ ] two\r\n")).toEqual(expected);
    expect(spec("checklist", "# List\r- [x] one\r- [ ] two")).toEqual(expected);
  });

  it("marks the first starred compare row and strips only its star", () => {
    expect(spec("compare", ["Plan | Cost", "Free | 0", "* Pro | 10", "Ultra | 20"].join("\n"))).toEqual({
      name: "compare",
      headers: ["Plan", "Cost"],
      rows: [["Free", "0"], ["Pro", "10"], ["Ultra", "20"]],
      highlight: 1,
    });
  });

  it("marks starred compare cells per column, row by row, and strips the stars", () => {
    expect(spec("compare", ["Plan | Cost | Speed", "Notion|Free|Limited*", "Obsidian|*Free|Full *"].join("\n"))).toEqual({
      name: "compare",
      headers: ["Plan", "Cost", "Speed"],
      rows: [
        ["Notion", "Free", "Limited"],
        ["Obsidian", "Free", "Full"],
      ],
      best: [
        [0, 2],
        [1, 1],
        [1, 2],
      ],
    });
  });

  it("still highlights the row for a starred label", () => {
    expect(spec("compare", ["Plan | Cost | Speed", "*Obsidian|Free|Full"].join("\n"))).toEqual({
      name: "compare",
      headers: ["Plan", "Cost", "Speed"],
      rows: [["Obsidian", "Free", "Full"]],
      highlight: 0,
    });
  });

  it("leaves a fully bold compare cell alone", () => {
    expect(spec("compare", ["Plan | Cost | Speed", "**Bold**|x|y"].join("\n"))).toEqual({
      name: "compare",
      headers: ["Plan", "Cost", "Speed"],
      rows: [["**Bold**", "x", "y"]],
    });
  });

  it("pads a short compare row and trims a long one", () => {
    expect(spec("compare", "Name | Qty\nApples")).toEqual({ name: "compare", headers: ["Name", "Qty"], rows: [["Apples", ""]] });
    expect(spec("compare", "Name | Qty\nApples | 3 | extra")).toEqual({ name: "compare", headers: ["Name", "Qty"], rows: [["Apples", "3"]] });
  });

  it("reads a currency amount with a thousands separator", () => {
    expect(spec("chart", "Mon | $1,200")).toEqual({ name: "chart", kind: "bars", series: [{ label: "Mon", value: 1200 }] });
  });

  it("reads the unit meta key case-insensitively", () => {
    expect(spec("chart", "A | 1\nUNIT: kg")).toEqual({ name: "chart", kind: "bars", series: [{ label: "A", value: 1 }], unit: "kg" });
  });

  it("keeps a negative chart value", () => {
    expect(spec("chart", "Change | -5")).toEqual({ name: "chart", kind: "bars", series: [{ label: "Change", value: -5 }] });
  });

  it("reads a named calculator formula line, leaving an unnamed one unchanged", () => {
    expect(spec("calculator", "principal | Principal | 100\n=monthly = principal * 2")).toEqual({
      name: "calculator",
      inputs: [{ id: "principal", label: "Principal", value: 100 }],
      formula: "principal * 2",
    });
    expect(spec("calculator", "principal | Principal | 100\n=principal*2")).toEqual({
      name: "calculator",
      inputs: [{ id: "principal", label: "Principal", value: 100 }],
      formula: "principal*2",
    });
  });

  it("pins an unchanged compare, chart and calculator spec", () => {
    expect(spec("compare", "Plan | Cost\nPro | 10")).toEqual({ name: "compare", headers: ["Plan", "Cost"], rows: [["Pro", "10"]] });
    expect(spec("chart", "Mon | 3")).toEqual({ name: "chart", kind: "bars", series: [{ label: "Mon", value: 3 }] });
    expect(spec("calculator", "a | A | 2\n=a*3")).toEqual({ name: "calculator", inputs: [{ id: "a", label: "A", value: 2 }], formula: "a*3" });
  });

  it("accepts dash and star markers on checklist lines", () => {
    expect(spec("checklist", "- [x] done\n* [ ] todo\nplain line")).toEqual({
      name: "checklist",
      items: [
        { text: "done", done: true },
        { text: "todo", done: false },
        { text: "plain line", done: false },
      ],
    });
  });

  it("returns null for invalid line forms", () => {
    expect(validateUi("chart", "A | abc")).toBeNull();
    expect(validateUi("compare", "A | B")).toBeNull();
    // A calculator with an unknown id still renders its inputs, with the reason instead of a result.
    expect(validateUi("calculator", "a | A | 1\n= a+b")).toMatchObject({ name: "calculator", problem: "unknown b" });
    expect(validateUi("timeline", "# Only a title")).toBeNull();
    expect(validateUi("checklist", "")).toBeNull();
    expect(validateUi("checklist", "  \n\n")).toBeNull();
  });

  it("still validates a JSON body exactly as before", () => {
    const body = JSON.stringify({ title: "List", items: [{ text: "buy milk", done: true }] });
    const expected: UiSpec = { name: "checklist", title: "List", items: [{ text: "buy milk", done: true }] };
    expect(spec("checklist", body)).toEqual(expected);
    // Leading whitespace also puts the body on the JSON path.
    expect(spec("checklist", `\n  ${body}`)).toEqual(expected);
  });

  it("takes a trailing `*` on a value cell as a best mark, and leaves bold cells alone", () => {
    expect(validateUi("compare", "Venue | Price\nCoast | $600\nLodge | $450 *")).toEqual({
      name: "compare",
      headers: ["Venue", "Price"],
      rows: [["Coast", "$600"], ["Lodge", "$450"]],
      best: [[1, 1]],
    });
    expect(validateUi("compare", "A | B\n**x** | 1")).toEqual({ name: "compare", headers: ["A", "B"], rows: [["**x**", "1"]] });
    expect(validateUi("compare", "A | B\nx | *maybe*")).toEqual({ name: "compare", headers: ["A", "B"], rows: [["x", "*maybe*"]] });
  });
});
