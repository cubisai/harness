import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";
import { calculatorMarkdown } from "../src/renderer/src/genui/components/Calculator";
import { checklistMarkdown } from "../src/renderer/src/genui/components/Checklist";
import { compareMarkdown } from "../src/renderer/src/genui/components/Compare";
import { timelineMarkdown } from "../src/renderer/src/genui/components/Timeline";
import type { CalculatorSpec, ChecklistSpec, CompareSpec, TimelineSpec } from "../src/renderer/src/genui/types";

/** Markup of one reply through the renderer under test. */
const render = (text: string, streaming = false): string => renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);
const fence = (name: string, body: unknown): string => `\`\`\`ui:${name}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;

describe("UI block actions", () => {
  it("builds checklist Markdown from the current ticks", () => {
    const spec: ChecklistSpec = { name: "checklist", title: "Shop", items: [{ text: "Lamb", done: true }, { text: "Potatoes", done: false }] };
    expect(checklistMarkdown(spec, [true, false])).toBe("**Shop**\n\n- [x] Lamb\n- [ ] Potatoes");
  });

  it("builds calculator Markdown from the current values", () => {
    const spec: CalculatorSpec = { name: "calculator", inputs: [{ id: "a", label: "A", value: 2 }, { id: "b", label: "B", value: 3, unit: "kg" }], formula: "a*b", unit: "kg" };
    expect(calculatorMarkdown(spec, { a: 2, b: 3 })).toBe("- A: 2\n- B: 3 kg\n**Result: 6 kg**");
  });

  it("builds compare Markdown as a GFM table, escaping pipes", () => {
    const spec: CompareSpec = { name: "compare", headers: ["Plan", "Price"], rows: [["Free", "0"], ["Pro|Max", "20"]] };
    expect(compareMarkdown(spec)).toBe("| Plan | Price |\n| --- | --- |\n| Free | 0 |\n| Pro\\|Max | 20 |");
  });

  it("builds timeline Markdown as numbered steps, dropping missing parts", () => {
    const spec: TimelineSpec = { name: "timeline", steps: [{ time: "10:00", title: "Oven on", detail: "220C" }, { title: "Cool" }] };
    expect(timelineMarkdown(spec)).toBe("1. 10:00 — Oven on: 220C\n2. Cool");
  });

  it("offers Copy and Use in reply under a rendered block", () => {
    const html = render(fence("checklist", { items: [{ text: "a" }] }));
    expect(html).toContain("Use in reply");
    expect(html).toContain("Copy");
  });
});

describe("building UI fences while streaming", () => {
  it("shows a building line for an unfinished ui fence instead of its JSON", () => {
    const html = render('Intro\n\n```ui:timeline\n{"steps":[', true);
    expect(html).toContain("Building a timeline");
    expect(html).not.toContain("steps");
  });
});
