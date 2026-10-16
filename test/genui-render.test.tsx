import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";

/** Markup of one reply through the renderer under test. */
const render = (text: string, streaming = false): string => renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);
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
