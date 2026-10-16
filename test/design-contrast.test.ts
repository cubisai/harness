import { describe, expect, it } from "vitest";
import { contrastLabel, contrastRatio, groundFor, isColorToken, parseColor, alphaOf, pickedColor, toHexColor } from "../src/renderer/src/design/contrast";

describe("parseColor", () => {
  it("parses hex in short and long form, ignoring alpha", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#ffffff80")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#FFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("parses rgb()/rgba() with commas, spaces and an optional slash alpha", () => {
    expect(parseColor("rgb(0 0 0 / 0.5)")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColor("rgba(10, 20, 30, 0.4)")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("returns null for anything it can't read", () => {
    expect(parseColor("nonsense")).toBeNull();
    expect(parseColor("var(--x)")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("gives 21 for black on white", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21);
  });

  it("rates a near-black ink on white at least 17:1", () => {
    const ink = parseColor("#18181b")!;
    const bg = parseColor("#ffffff")!;
    expect(contrastRatio(ink, bg)).toBeGreaterThanOrEqual(17);
  });
});

describe("contrastLabel", () => {
  it("passes, needs large text or fails on the WCAG thresholds", () => {
    expect(contrastLabel(4.5).pass).toBe("aa");
    expect(contrastLabel(3.2).pass).toBe("large");
    expect(contrastLabel(2).pass).toBe("fail");
  });

  it("formats the ratio with one decimal", () => {
    expect(contrastLabel(4.5).text).toBe("4.5:1");
  });
});

describe("groundFor", () => {
  it("reads the on-token, the base background for text, and nothing for the rest", () => {
    expect(groundFor("--color-on-primary")).toBe("--color-primary");
    expect(groundFor("--color-text-muted")).toBe("--color-bg");
    expect(groundFor("--color-accent")).toBeNull();
  });
});

describe("isColorToken", () => {
  it("trusts a --color- name, and any value that parses as a colour", () => {
    expect(isColorToken("--accent", "#f00")).toBe(true);
    expect(isColorToken("--color-bg", "var(--x)")).toBe(true);
    expect(isColorToken("--space-4", "16px")).toBe(false);
  });
});

describe("colour picker values", () => {
  it("turns any colour parseColor reads into #rrggbb, else null", () => {
    expect(toHexColor("rgb(244, 241, 255)")).toBe("#f4f1ff");
    expect(toHexColor("#0E7")).toBe("#00ee77");
    expect(toHexColor("rgba(0, 0, 0, 0)")).toBe("#000000");
    expect(toHexColor("var(--x)")).toBeNull();
  });

  it("reads alpha from hex and rgb forms", () => {
    expect(alphaOf("#ff000080")).toBeCloseTo(128 / 255);
    expect(alphaOf("rgba(0, 0, 0, 0.5)")).toBe(0.5);
    expect(alphaOf("rgb(0 0 0 / 25%)")).toBe(0.25);
    expect(alphaOf("rgb(1, 2, 3)")).toBe(1);
  });

  it("keeps a see-through value's alpha when the picker sets a new colour", () => {
    expect(pickedColor("#112233", "rgb(244, 241, 255)")).toBe("#112233");
    expect(pickedColor("#112233", "rgba(0, 0, 0, 0.5)")).toBe("#11223380");
    // An unset (transparent) background takes the pick as it is.
    expect(pickedColor("#112233", "rgba(0, 0, 0, 0)")).toBe("#112233");
  });
});
