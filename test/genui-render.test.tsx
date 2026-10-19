import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";

/** Markup of one reply through the renderer under test. */
const render = (text: string, streaming = false): string => renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);
/** React SSR separates adjacent text nodes with a comment, and escapes quotes; undo both before matching prose. */
const strip = (html: string): string => html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const fence = (name: string, body: unknown): string => `\`\`\`ui:${name}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;

describe("inline UI blocks", () => {
  it("draws each catalog block from a valid fence", () => {
    expect(render(fence("checklist", { title: "Shop", items: [{ text: "Lamb", done: true }, { text: "Potatoes" }] }))).toContain("1 of 2 done");
    const calc = render(fence("calculator", { inputs: [{ id: "a", label: "A", value: 2 }, { id: "b", label: "B", value: 3 }], formula: "a*b+2", unit: "kg" }));
    expect(calc).toContain('data-ui="calculator"');
    expect(calc).toContain("8 kg");
    const cmp = render(fence("compare", { headers: ["Plan", "Price"], rows: [["Free", 0], ["Pro", 20]], highlight: 1 }));
    expect(cmp).toContain('<tr class="hl"><td>Pro</td><td>20</td></tr>');
    const tl = render(fence("timeline", { steps: [{ time: "10:00", title: "Oven on", detail: "220C" }] }));
    expect(tl).toContain("Oven on");
    expect(tl).not.toContain("220C"); // details start collapsed
  });

  it("draws a chart with negative values around a zero line, and an all-positive chart as before", () => {
    const neg = render(fence("chart", "Q1|12\nQ2|-5\nQ3|8"));
    expect(neg).toContain('class="ui-chart diverging"');
    expect(neg).toContain('class="ui-chart-zero"');
    expect(neg).toContain('class="ui-chart-bar neg"');
    const pos = render(fence("chart", "A|4\nB|2"));
    expect(pos).toContain('<ul class="ui-chart"');
    expect(pos).toContain('style="width:50%"');
    expect(pos).not.toContain("ui-chart-zero");
  });

  it("marks best compare cells from per-cell stars and copies them in bold", () => {
    const html = render(fence("compare", "App|Price|Offline\nNotion|$10|Limited\nObsidian|Free *|*Full"));
    expect(html).toContain('<td class="best"><span class="sr-only">Best: </span>Free</td>');
    expect(html).toContain('<td class="best"><span class="sr-only">Best: </span>Full</td>');
    expect(html).not.toContain("*");
  });

  it("renders the loan calculator agents write (named result, ^ power)", () => {
    const calc = render(fence("calculator", "principal|Principal|200000|$\nrate|Annual rate|6|%\nyears|Years|30|years\n=monthly = principal*(rate/1200)/(1-(1+rate/1200)^(-years*12))"));
    expect(calc).toContain('data-ui="calculator"');
    expect(calc).toContain("1,199.1<");
  });

  it("shows an invalid, unknown or oversized block as a plain code block", () => {
    for (const text of [fence("checklist", "{not json"), fence("slider", { items: [] }), fence("checklist", { items: Array.from({ length: 51 }, () => ({ text: "x" })) })]) {
      const html = render(text);
      expect(html).toContain('class="code-block"');
      expect(html).not.toContain("ui-block");
    }
  });

  it("never interprets markup inside a block", () => {
    const html = render(fence("checklist", { items: [{ text: "<img src=x onerror=alert(1)>" }] }));
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("does not mount a block whose fence is still streaming", () => {
    const html = render(`Plan:\n\n\`\`\`ui:checklist\n{"items":[{"text":"a"}`, true);
    expect(html).not.toContain("ui-block");
  });

  it("leaves replies without ui fences unchanged", () => {
    expect(render("```js\nconst a = 1;\n```\n\nText")).toContain("<pre><code>const a = 1;</code></pre>");
  });
});

describe("calculator with a formula that can't run", () => {
  it("renders the inputs and names the unknown ids instead of raw code", () => {
    const html = render(fence("calculator", "principal|Principal|200000|$\nrate|Rate|6|%\nyears|Years|30\n=P * r/12 … n"));
    expect(html).toContain('data-ui="calculator"');
    expect(html).toContain('value="200000"');
    expect(strip(html)).toContain("Couldn't compute: unknown P, r, n");
    expect(html).not.toContain("ui-result");
    expect(html).not.toContain("code-block");
  });
});

describe("calculator with empty starting values", () => {
  it("renders blank inputs and a dash until they're filled, instead of raw code", () => {
    const html = renderToStaticMarkup(<Markdown text={"```ui:calculator\nprincipal|Principal||$\nrate|Rate|6|%\n=principal*rate/100\n```"} />);
    expect(html).toContain('data-ui="calculator"');
    expect(html).toContain('value=""');
    expect(html).toContain("—");
    expect(html).not.toContain("code-block");
  });

  it("treats a non-numeric starting value in the line form as blank, but still rejects one in JSON", () => {
    const line = renderToStaticMarkup(<Markdown text={"```ui:calculator\nprincipal|Principal|lots|$\n=principal*2\n```"} />);
    expect(line).toContain('data-ui="calculator"');
    const json = renderToStaticMarkup(<Markdown text={'```ui:calculator\n{"inputs":[{"id":"a","label":"A","value":"lots"}],"formula":"a*2"}\n```'} />);
    expect(json).toContain("code-block");
  });
});
