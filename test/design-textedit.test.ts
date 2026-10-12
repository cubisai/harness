import { describe, expect, it } from "vitest";
import { MAX_EDIT_CHARS, applyTextEdit, decodeEntities, escapeText } from "../src/main/design/textedit";

describe("decodeEntities", () => {
  it("decodes the named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("&lt;b&gt;")).toBe("<b>");
    expect(decodeEntities("&quot;hi&quot;")).toBe('"hi"');
    expect(decodeEntities("it&#39;s")).toBe("it's");
    expect(decodeEntities("it&apos;s")).toBe("it's");
    expect(decodeEntities("a&nbsp;b")).toBe("a b");
  });

  it("decodes decimal and hex code points", () => {
    expect(decodeEntities("&#65;&#66;")).toBe("AB");
    expect(decodeEntities("&#x41;&#X42;")).toBe("AB");
  });

  it("leaves unknown or bare ampersands untouched", () => {
    expect(decodeEntities("A & B")).toBe("A & B");
    expect(decodeEntities("&copy;")).toBe("&copy;");
    expect(decodeEntities("&#xz;")).toBe("&#xz;");
  });
});

describe("escapeText", () => {
  it("escapes only the markup characters", () => {
    expect(escapeText("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeText("<b>")).toBe("&lt;b&gt;");
    expect(escapeText('a "b" it\'s')).toBe('a "b" it\'s');
  });
});

describe("applyTextEdit", () => {
  it("replaces a simple text element and keeps the rest byte-identical", () => {
    const html = `<h1 data-agent-id="hero-title">Plan your week</h1>\n<p>hi</p>`;
    const out = applyTextEdit(html, "hero-title", "Plan your week", "Plan");
    expect(out).toBe(`<h1 data-agent-id="hero-title">Plan</h1>\n<p>hi</p>`);
  });

  it("accepts single quotes and extra attributes before and after the id", () => {
    const html = `<h1 class="a" data-agent-id='hero-title' id="h">Old</h1>`;
    const out = applyTextEdit(html, "hero-title", "Old", "New");
    expect(out).toBe(`<h1 class="a" data-agent-id='hero-title' id="h">New</h1>`);
  });

  it("matches entity-encoded old content and escapes the new text", () => {
    const html = `<p data-agent-id="cast">Tom &amp; Jerry</p>`;
    const out = applyTextEdit(html, "cast", "Tom & Jerry", "<b>");
    expect(out).toBe(`<p data-agent-id="cast">&lt;b&gt;</p>`);
  });

  it("matches a normalized before against whitespace in the content", () => {
    const html = `<p data-agent-id="body">\n  Plan   your\n  week\n</p>`;
    const out = applyTextEdit(html, "body", "Plan your week", "Done");
    expect(out).toBe(`<p data-agent-id="body">Done</p>`);
  });

  it("drops the old indentation when replacing", () => {
    const html = `<p data-agent-id="body">\n  Old   text\n</p>`;
    const out = applyTextEdit(html, "body", "Old text", "New text");
    expect(out).toBe(`<p data-agent-id="body">New text</p>`);
  });

  it("refuses an invalid id", () => {
    expect(() => applyTextEdit(`<p data-agent-id="x">a</p>`, "bad id", "a", "b")).toThrow(
      "That text has no stable id; ask the agent to change it.",
    );
  });

  it("refuses text that is too long", () => {
    const long = "a".repeat(MAX_EDIT_CHARS + 1);
    expect(() => applyTextEdit(`<p data-agent-id="x">old</p>`, "x", "old", long)).toThrow(
      "The new text is too long.",
    );
  });

  it("refuses a missing id", () => {
    expect(() => applyTextEdit(`<p>old</p>`, "x", "old", "new")).toThrow(
      "That text's id isn't unique in the page; ask the agent to change it.",
    );
  });

  it("refuses a duplicated id", () => {
    const html = `<p data-agent-id="x">a</p><p data-agent-id="x">b</p>`;
    expect(() => applyTextEdit(html, "x", "a", "c")).toThrow(
      "That text's id isn't unique in the page; ask the agent to change it.",
    );
  });

  it("refuses an element that holds a child element", () => {
    const html = `<button data-agent-id="x"><span>Go</span></button>`;
    expect(() => applyTextEdit(html, "x", "Go", "Stop")).toThrow(
      "That element holds more than text; ask the agent to change it.",
    );
  });

  it("refuses an element with no closing tag", () => {
    const html = `<p data-agent-id="x">old`;
    expect(() => applyTextEdit(html, "x", "old", "new")).toThrow(
      "That element holds more than text; ask the agent to change it.",
    );
  });

  it("refuses when the page changed since editing started", () => {
    const html = `<p data-agent-id="x">current</p>`;
    expect(() => applyTextEdit(html, "x", "stale", "new")).toThrow(
      "The page changed since you started editing; try again.",
    );
  });

  it("ignores an id that only appears inside plain text", () => {
    const html = `<p>the id is data-agent-id="x" here</p>`;
    expect(() => applyTextEdit(html, "x", "the id", "new")).toThrow(
      "That text's id isn't unique in the page; ask the agent to change it.",
    );
  });
});
