import { describe, expect, it } from "vitest";
import {
  blend,
  colorKey,
  contrastRatio,
  formatLint,
  lintScript,
  minContrast,
  onGrid,
  parseColor,
  type LintFinding,
  type LintResult,
} from "../src/main/design/lint";

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

describe("parseColor", () => {
  it("parses rgb, rgba, and space syntax", () => {
    expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor("rgb(1 2 3 / 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it("parses hex in 3, 6, and 8 digits", () => {
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("#aabbcc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("#aabbccdd")).toEqual({ r: 170, g: 187, b: 204, a: 221 / 255 });
  });

  it("parses transparent as fully clear", () => {
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("returns null for anything else", () => {
    expect(parseColor("nope")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("rgb(1, 2)")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for identical colors", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it("straddles the 4.5 boundary at #777777 / #767676", () => {
    const grey77 = parseColor("#777777")!;
    const grey76 = parseColor("#767676")!;
    expect(contrastRatio(grey77, WHITE)).toBeCloseTo(4.48, 1);
    expect(contrastRatio(grey77, WHITE)).toBeLessThan(4.5);
    expect(contrastRatio(grey76, WHITE)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("minContrast", () => {
  it("requires 3 for large text and 4.5 otherwise", () => {
    expect(minContrast(16, 400)).toBe(4.5);
    expect(minContrast(24, 400)).toBe(3);
    expect(minContrast(19, 700)).toBe(3);
    expect(minContrast(19, 400)).toBe(4.5);
  });
});

describe("blend", () => {
  it("composites 50% black over white to mid grey", () => {
    const grey = blend({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE);
    expect(grey.r).toBeGreaterThanOrEqual(127);
    expect(grey.r).toBeLessThanOrEqual(128);
    expect(grey.g).toBe(grey.r);
    expect(grey.b).toBe(grey.r);
    expect(grey.a).toBe(1);
  });
});

describe("onGrid", () => {
  it("accepts 0, 1, 2, and multiples of 4", () => {
    for (const value of [0, 1, 2, 4, 8, 12, 96, -8]) expect(onGrid(value)).toBe(true);
  });

  it("rejects off-grid values", () => {
    for (const value of [3, 5, 6, 10, 13, 14.5]) expect(onGrid(value)).toBe(false);
  });

  it("rounds float error to 2 decimals first", () => {
    expect(onGrid(7.999999)).toBe(true);
    expect(onGrid(8.004)).toBe(true);
  });
});

describe("colorKey", () => {
  it("normalizes equivalent colors to one key", () => {
    expect(colorKey(parseColor("rgb(255,0,0)")!)).toBe(colorKey(parseColor("#ff0000")!));
    expect(colorKey({ r: 1, g: 2, b: 3, a: 0.5 })).toBe("1,2,3,0.5");
  });
});

describe("formatLint", () => {
  const result = (findings: LintFinding[], skipped: string[] = [], scanned = 0): LintResult => ({ findings, skipped, scanned });

  it("orders findings by rule and lists counts in the header", () => {
    const out = formatLint(
      result([
        { rule: "color", selector: ".c", detail: "color #fff is not a design token" },
        { rule: "spacing", selector: ".s", detail: "padding: 13px (not on the 4px grid)" },
        { rule: "contrast", selector: ".a", detail: "2.9:1 (#8a8a8a on #ffffff), needs 4.5:1" },
        { rule: "targets", selector: ".b", detail: "32×20px, needs 44×44" },
      ], ["color: no --color-* tokens on :root"], 123),
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("design_lint: 4 findings — contrast 1, targets 1, spacing 1, color 1 (123 elements)");
    expect(lines[1]).toBe("- [contrast] .a — 2.9:1 (#8a8a8a on #ffffff), needs 4.5:1");
    expect(lines[2]).toBe("- [targets] .b — 32×20px, needs 44×44");
    expect(lines[3]).toBe("- [spacing] .s — padding: 13px (not on the 4px grid)");
    expect(lines[4]).toBe("- [color] .c — color #fff is not a design token");
    expect(lines[5]).toBe("skipped color: no --color-* tokens on :root");
  });

  it("uses a distinct line when there are no findings", () => {
    expect(formatLint(result([], [], 5))).toBe("design_lint: no findings (5 elements)");
  });

  it("dedupes exact duplicates", () => {
    const finding: LintFinding = { rule: "spacing", selector: ".s", detail: "padding: 13px (not on the 4px grid)" };
    const out = formatLint(result([finding, { ...finding }], [], 1));
    expect(out.split("\n")[0]).toBe("design_lint: 1 findings — contrast 0, targets 0, spacing 1, color 0 (1 elements)");
  });

  it("caps the list at 40 findings", () => {
    const findings: LintFinding[] = Array.from({ length: 45 }, (_v, i) => ({
      rule: "spacing" as const,
      selector: `.s${i}`,
      detail: "x",
    }));
    const lines = formatLint(result(findings, [], 1)).split("\n");
    expect(lines).toHaveLength(42);
    expect(lines[41]).toBe("… 5 more not shown");
  });
});

describe("lintScript", () => {
  it("builds a parseable page expression with the helpers embedded", () => {
    const script = lintScript((el) => el.tagName.toLowerCase());
    expect(script).toContain("JSON.stringify");
    expect(script).toContain("parseColor");
    expect(script).toContain("blend");
    expect(script).toContain("contrastRatio");
    expect(script).toContain("minContrast");
    expect(script).toContain("onGrid");
    expect(script).toContain("colorKey");
    expect(() => new Function("return " + script)).not.toThrow();
  });
});
