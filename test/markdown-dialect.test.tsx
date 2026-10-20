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

  it("parses code, links and emphasis inside bold, italic and strikethrough", () => {
    const html = render("**1. `onorca.dev/docs` — loads fine.** and *see `a.ts`* and ~~`old`~~");
    expect(html).toContain("<strong>1. <code>onorca.dev/docs</code> — loads fine.</strong>");
    expect(html).toContain("<em>see <code>a.ts</code></em>");
    expect(html).toContain("<del><code>old</code></del>");
    expect(html).not.toContain("`");
  });

  it("renders inline code, bold, em, underscore em, and strikethrough", () => {
    expect(render("`code`")).toContain("<code>code</code>");
    expect(render("**bold**")).toContain("<strong>bold</strong>");
    expect(render("*em*")).toContain("<em>em</em>");
    expect(render("_em_")).toContain("<em>em</em>");
    expect(render("~~del~~")).toContain("<del>del</del>");
  });

  it("renders links with their href", () => {
    expect(render("[x](https://e.com)")).toContain('<a class="link-chip" href="https://e.com"');
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

  it("turns a link to an absolute path into a file link, never raw markdown or a navigation", () => {
    const opened: string[] = [];
    const withFile = (text: string) => renderToStaticMarkup(<Markdown text={text} onFile={(r) => opened.push(r.path)} />);
    for (const target of ["/tmp/app/notes.js", "/tmp/app/notes.js:12", "C:\\app\\notes.js", "C:/app/notes.js"]) {
      const html = withFile(`See [notes.js](${target}) now.`);
      expect(html).toContain('<button class="file-link"');
      expect(html).toContain("<code>notes.js</code>");
      expect(html).not.toContain("](");
      expect(html).not.toContain("<a ");
    }
    // Without a file handler it still reads as the label, not the raw link.
    expect(render("See [notes.js](/tmp/app/notes.js).")).toBe("<p>See <code>notes.js</code>.</p>");
    expect(render("[docs](https://example.com)")).toContain('<a class="link-chip" href="https://example.com"');
  });
});

describe("turn sources", () => {
  it("collects the https pages a turn fetched, once each, and resets per turn", async () => {
    const { createSegmenter, fetchedUrl } = await import("../src/renderer/src/turns");
    expect(fetchedUrl({ name: "Fetch", payload: { url: "https://a.dev/x" } })).toBe("https://a.dev/x");
    expect(fetchedUrl({ name: "WebFetch", payload: { url: "https://a.dev/x" } })).toBe("https://a.dev/x");
    expect(fetchedUrl({ name: "Fetch", payload: { url: "http://a.dev/x" } })).toBeNull();
    expect(fetchedUrl({ name: "Read", payload: { url: "https://a.dev/x" } })).toBeNull();
    expect(fetchedUrl({ name: "browser_open", payload: { url: "https://www.reddit.com/" } })).toBe("https://www.reddit.com/");
    expect(fetchedUrl({ name: "mcp__cubiq__browser_open", payload: { url: "https://b.dev/" } })).toBe("https://b.dev/");
    expect(fetchedUrl({ name: "browser_open", payload: { url: "http://localhost:5173/" } })).toBeNull();
    let seq = 0;
    const ev = (event: object) => ({ seq: ++seq, createdAt: seq, event }) as never;
    const events = [
      ev({ kind: "user", text: "check" }),
      ev({ kind: "tool-use", toolUseId: "1", name: "Fetch", summary: "", payload: { url: "https://a.dev/x" } }),
      ev({ kind: "tool-result", toolUseId: "1", isError: false, summary: "" }),
      ev({ kind: "tool-use", toolUseId: "2", name: "Fetch", summary: "", payload: { url: "https://a.dev/x" } }),
      ev({ kind: "tool-use", toolUseId: "3", name: "WebFetch", summary: "", payload: { url: "https://b.dev/" } }),
      ev({ kind: "assistant-text", text: "done" }),
      ev({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: 0 }),
      ev({ kind: "user", text: "again" }),
      ev({ kind: "assistant-text", text: "ok" }),
      ev({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: 0 }),
    ];
    const ends = createSegmenter()(events, false).filter((s: { kind: string }) => s.kind === "turn-end") as { sources: string[] }[];
    expect(ends.map((e) => e.sources)).toEqual([["https://a.dev/x", "https://b.dev/"], []]);
  });
});
