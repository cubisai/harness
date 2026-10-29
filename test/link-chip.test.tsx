import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chipText, urlTitle } from "../src/renderer/src/components/LinkChip";
import { linkUrls, Markdown } from "../src/renderer/src/markdown";

/** Markup of one snippet through the renderer under test. */
const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe("link chip", () => {
  it("keeps a real label as the chip text", () => {
    expect(chipText("https://vitejs.dev/guide/", "the docs", null)).toBe("the docs");
  });

  it("uses the host when the label is the URL, with or without a trailing slash", () => {
    expect(chipText("https://vitejs.dev/guide/", "https://vitejs.dev/guide/", null)).toBe("vitejs.dev");
    expect(chipText("https://vitejs.dev/guide/", "https://vitejs.dev/guide", null)).toBe("vitejs.dev");
  });

  it("prefers the site's name once it is known", () => {
    expect(chipText("https://vitejs.dev/guide/", "https://vitejs.dev/guide/", "Vite")).toBe("Vite");
  });

  it("uses the host for a bare host label", () => {
    expect(chipText("https://github.com/x", "github.com", null)).toBe("github.com");
  });

  it("renders a labelled https link as a chip", () => {
    const html = render("[the docs](https://vitejs.dev/guide/)");
    expect(html).toContain('<a class="link-chip"');
    expect(html).toContain('href="https://vitejs.dev/guide/"');
    expect(html).toContain('<span class="link-chip-text">the docs</span>');
  });

  it("chips a bare URL and leaves the sentence's full stop outside", () => {
    const html = render("see https://example.com/a.");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain("</a>.");
  });

  it("leaves inline code and file links alone", () => {
    const code = render("`https://example.com`");
    expect(code).toContain("<code>https://example.com</code>");
    expect(code).not.toContain("link-chip");
    const file = render("[a.ts](/src/a.ts)");
    expect(file).toContain("<code>a.ts</code>");
    expect(file).not.toContain("link-chip");
  });
});

describe("link cards", () => {
  it("collects a block's https links once each, in order, skipping code and file links", () => {
    expect(linkUrls("Read [the guide](https://vite.dev/guide/) and https://react.dev/learn. Again https://vite.dev/guide/ `https://in.code/x` [a.ts](/src/a.ts) http://plain.example.com")).toEqual([
      "https://vite.dev/guide/",
      "https://react.dev/learn",
    ]);
  });

  it("draws no card before the page's metadata arrives (and none with previews off)", () => {
    const html = render("Read [the guide](https://vite.dev/guide/).");
    expect(html).not.toContain("link-card-row");
  });

  it("titles a card for a page that couldn't be read from its host and path", () => {
    expect(urlTitle("https://stackoverflow.com/questions/11227809/why-is-it-faster/")).toBe("stackoverflow.com/questions/11227809/why-is-it-faster");
    expect(urlTitle("https://www.reddit.com/")).toBe("reddit.com");
    expect(urlTitle("https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC")).toBe("ja.wikipedia.org/wiki/東京");
    expect(urlTitle("https://a.dev/%E0%A4%A")).toBe("a.dev");
  });

  it("keeps balanced parentheses in a URL, labelled or bare, and leaves a closing one that isn't its own", () => {
    const wiki = "https://en.wikipedia.org/wiki/Electron_(software_framework)";
    expect(linkUrls(`See [Electron](${wiki}), then more.`)).toEqual([wiki]);
    expect(linkUrls(`See ${wiki}.`)).toEqual([wiki]);
    expect(linkUrls("(see https://vite.dev/guide)")).toEqual(["https://vite.dev/guide"]);
    const html = render(`See [Electron](${wiki}), then more.`);
    expect(html).toContain(`href="${wiki}"`);
    expect(html).not.toMatch(/<\/a>\)/);
  });
});
