import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";

describe("Markdown", () => {
  it("renders markdown to static markup", () => {
    const html = renderToStaticMarkup(<Markdown text={"# Title\n\nHello **world**\n\n- one\n- two"} />);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>one</li>");
  });
});
