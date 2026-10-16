import { describe, expect, it } from "vitest";
import { highlight, langOf, type SynToken } from "../src/renderer/src/design/highlight";

/** The texts of every token of a given kind. */
const texts = (tokens: SynToken[], kind: SynToken["kind"]): string[] => tokens.filter((t) => t.kind === kind).map((t) => t.text);

const HTML = `<!DOCTYPE html>
<!-- a page -->
<html lang="en">
<head>
<style>
  p { color: #fff; margin: 12px }
</style>
</head>
<body>
<a href="x">hi</a>
<script>
const s = "a"; // hi
</script>
</body>
</html>`;

describe("highlight", () => {
  it("is lossless for an html sample with doctype, comment, attrs, style and script", () => {
    expect(highlight(HTML, "html").map((t) => t.text).join("")).toBe(HTML);
  });

  it("colours tag names, attribute names and values in html", () => {
    const tokens = highlight('<a href="x">', "html");
    expect(tokens).toContainEqual({ text: "a", kind: "keyword" });
    expect(tokens).toContainEqual({ text: "href", kind: "attr" });
    expect(tokens).toContainEqual({ text: '"x"', kind: "string" });
  });

  it("colours css properties, hex colours and numbers", () => {
    const tokens = highlight("p { color: #fff; margin: 12px }", "css");
    expect(texts(tokens, "attr")).toContain("color");
    expect(texts(tokens, "attr")).toContain("margin");
    expect(texts(tokens, "number")).toContain("#fff");
    expect(texts(tokens, "number")).toContain("12px");
  });

  it("colours js keywords, strings and line comments", () => {
    const tokens = highlight('const s = "a"; // hi', "js");
    expect(texts(tokens, "keyword")).toContain("const");
    expect(texts(tokens, "string")).toContain('"a"');
    expect(texts(tokens, "comment")).toContain("// hi");
  });

  it("returns one plain token for text over the 200k cap", () => {
    const big = "x".repeat(200_001);
    expect(highlight(big, "js")).toEqual([{ text: big, kind: "plain" }]);
  });
});

describe("langOf", () => {
  it("picks a language by extension, case-insensitively", () => {
    expect(langOf("x/Page.HTML")).toBe("html");
    expect(langOf("a.json")).toBe("js");
    expect(langOf("README.md")).toBe("plain");
  });
});

describe("highlight edge cases", () => {
  it("steps over a stray quote in a tag and an unclosed tag", () => {
    for (const html of ['<a "x">t</a>', "<a b='1' 'c>", "<div", "<p>1</p><style>a{b:-.5em}", "<script>let a = 0x1f + 1e3"]) {
      expect(highlight(html, "html").map((t) => t.text).join("")).toBe(html);
    }
  });

  it("stays fast on a large numeric file", () => {
    const css = ".a { margin: 1px 2px 3px 4px; }\n".repeat(5000);
    const start = Date.now();
    expect(highlight(css, "css").map((t) => t.text).join("")).toBe(css);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
