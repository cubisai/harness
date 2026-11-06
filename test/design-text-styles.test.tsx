import { describe, expect, it } from "vitest";
import { colourTokenOf, colourTokens, inlineStyle, normalColour, optionLabel, scaleStepOf, sizeMeta, textVariantProp, tokenNames, typeScale } from "../src/renderer/src/design/text-styles";

const tokens = {
  "--color-text": "rgba(0, 0, 0, 0.87)",
  "--color-text-muted": "rgba(0, 0, 0, 0.6)",
  "--color-primary": "#1976d2",
  "--color-accent-text": "#1976d2",
  "--color-surface": "#fff",
  "--color-border": "rgba(0, 0, 0, 0.12)",
  "--text-md": "16px",
  "--leading-md": "24px",
  "--text-sm": "14px",
  "--leading-sm": "20px",
  "--text-display": "96px",
  "--radius-md": "4px",
};

describe("the Typography view's names", () => {
  it("reads colour and type token names from tokens.css, in order, once each", () => {
    expect(tokenNames(":root{--color-bg:#fff;--text-md:16px;--radius-md:4px;--leading-md:24px;--color-bg:#000}")).toEqual(["--color-bg", "--text-md", "--leading-md"]);
  });
  it("orders the type scale by size, with size/leading", () => {
    expect(typeScale(tokens).map((s) => `${s.label} ${s.meta}`)).toEqual(["Body sm 14/20", "Body md 16/24", "Display 96"]);
  });
  it("finds the step from var() first, else from the size", () => {
    const scale = typeScale(tokens);
    expect(scaleStepOf(scale, "var(--text-sm)", "16px")).toBe("sm");
    expect(scaleStepOf(scale, undefined, "16px")).toBe("md");
    expect(scaleStepOf(scale, undefined, "15px")).toBeNull();
  });
  it("takes a text part's type prop, not a button's", () => {
    expect(textVariantProp("typography", [{ name: "color", options: ["a"] }, { name: "variant", options: ["body1", "h1"] }])).toEqual({ name: "variant", options: ["body1", "h1"] });
    expect(textVariantProp("heading", [{ name: "level", options: ["2", "1"] }])?.name).toBe("level");
    expect(textVariantProp("button", [{ name: "variant", options: ["text"] }])).toBeNull();
  });
  it("says options the way people do", () => {
    expect(optionLabel("variant", "body1")).toBe("Body 1");
    expect(optionLabel("variant", "title-lg")).toBe("Title lg");
    expect(optionLabel("variant", "h3")).toBe("H3");
    expect(optionLabel("level", "2")).toBe("H2");
    expect(optionLabel("size", "md")).toBe("Md");
  });
  it("writes a computed size as 14/20", () => {
    expect(sizeMeta({ fontSize: "14px", lineHeight: "20px" })).toBe("14/20");
    expect(sizeMeta({ fontSize: "14px", lineHeight: "normal" })).toBe("14");
    expect(sizeMeta({})).toBe("");
  });
  it("names a colour by its token, preferring the role that suits the property", () => {
    const list = colourTokens(tokens);
    expect(list.map((t) => t.name)).toEqual(["text", "text-muted", "primary", "accent-text", "surface", "border"]);
    expect(colourTokenOf(list, "color", "var(--color-primary)", "rgb(0,0,0)")).toBe("--color-primary");
    expect(colourTokenOf(list, "color", undefined, "rgb(25, 118, 210)")).toBe("--color-accent-text");
    expect(colourTokenOf(list, "background-color", undefined, "rgb(25, 118, 210)")).toBe("--color-primary");
    expect(colourTokenOf(list, "color", undefined, "rgba(0, 0, 0, 0.6)")).toBe("--color-text-muted");
    expect(colourTokenOf(list, "color", undefined, "rgb(1, 2, 3)")).toBeNull();
  });
  it("compares hex and rgb", () => {
    expect(normalColour("#FFF")).toBe("rgb(255,255,255)");
    expect(normalColour("rgba(255, 255, 255, 1)")).toBe("rgb(255,255,255)");
    expect(normalColour("#00000080")).toBe("rgba(0,0,0,0.5)");
  });
  it("reads one inline declaration", () => {
    expect(inlineStyle("color: red; font-size: var(--text-md)", "font-size")).toBe("var(--text-md)");
    expect(inlineStyle(undefined, "color")).toBeUndefined();
  });
});

describe("a scale step's style", () => {
  it("writes the size token, and the leading when the page has it", async () => {
    const { scaleChanges } = await import("../src/renderer/src/design/text-styles");
    expect(scaleChanges("md", { "--leading-md": "24px" })).toEqual([
      { prop: "font-size", value: "var(--text-md)" },
      { prop: "line-height", value: "var(--leading-md)" },
    ]);
    expect(scaleChanges("display", {})).toEqual([{ prop: "font-size", value: "var(--text-display)" }]);
  });
});
