import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";

/** Markup of one snippet through the renderer under test. */
const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe("markdown dialect", () => {
  it("renders fenced code with ``` and ~~~ as pre>code", () => {
    for (const fence of ["```", "~~~"]) {
      const html = render(`${fence}js\nconst a = 1;\n${fence}`);
      expect(html).toContain("<pre><code>const a = 1;</code></pre>");
    }
  });

  it("renders # as h1", () => {
    expect(render("# h")).toContain("<h1>h</h1>");
  });

  it("renders - lists as ul with two li", () => {
    const html = render("- a\n- b");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
  });

  it("renders 1. as ol", () => {
    expect(render("1. a")).toContain("<ol><li>a</li></ol>");
  });

  it("renders inline code, bold, em, underscore em, and strikethrough", () => {
    expect(render("`code`")).toContain("<code>code</code>");
    expect(render("**bold**")).toContain("<strong>bold</strong>");
    expect(render("*em*")).toContain("<em>em</em>");
    expect(render("_em_")).toContain("<em>em</em>");
    expect(render("~~del~~")).toContain("<del>del</del>");
  });

  it("renders links with their href", () => {
    expect(render("[x](https://e.com)")).toContain('<a href="https://e.com"');
  });

  it("renders a GFM table with alignment", () => {
    const html = render("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<th style="text-align:right">b</th>');
    expect(html).toContain("<td>2</td>");
  });

  it("keeps a header row without a delimiter row a paragraph", () => {
    const html = render("| a | b |\n| 1 | 2 |");
    expect(html).not.toContain("<table>");
    expect(html).toContain("| a | b |");
  });

  it("escapes HTML instead of rendering it", () => {
    const html = render("<script>alert(1)</script><img src=x onerror=1>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
  });

  it("never emits a javascript: href", () => {
    const html = render("[x](javascript:alert(1))");
    expect(html).not.toContain('href="javascript');
  });
});
