import { describe, expect, it } from "vitest";
import { decodeEntities, escapeText } from "../src/main/design/textedit";

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
