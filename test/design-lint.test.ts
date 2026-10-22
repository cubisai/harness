import { describe, expect, it } from "vitest";
import {
  blend,
  collectSlop,
  colorKey,
  contrastRatio,
  formatLint,
  lintScript,
  minContrast,
  onGrid,
  parseColor,
  slopFindings,
  type LintFinding,
  type LintResult,
  type SlopNode,
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
    expect(lines[0]).toBe("design_lint: 4 findings — contrast 1, targets 1, spacing 1, color 1, slop 0 (123 elements)");
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
    expect(out.split("\n")[0]).toBe("design_lint: 1 findings — contrast 0, targets 0, spacing 1, color 0, slop 0 (1 elements)");
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

describe("slopFindings", () => {
  const node = (over: Partial<SlopNode>): SlopNode => ({
    selector: "div",
    tag: "div",
    text: "",
    nextTag: null,
    fontPx: 16,
    textTransform: "none",
    letterSpacingPx: 0,
    fontFamily: "Helvetica",
    backgroundImage: "none",
    backgroundClip: "border-box",
    borderPx: { top: 0, right: 0, bottom: 0, left: 0 },
    boxShadow: "none",
    cardLike: false,
    childSig: "",
    parentSelector: null,
    width: 300,
    ...over,
  });

  it("returns nothing for neutral nodes", () => {
    expect(slopFindings([node({}), node({ tag: "section", selector: "section" })])).toEqual([]);
  });

  it("flags an eyebrow label above a heading", () => {
    const out = slopFindings([
      node({ text: "New feature", fontPx: 12, textTransform: "uppercase", nextTag: "h2", selector: ".eyebrow" }),
    ]);
    expect(out).toEqual([{ rule: "slop", selector: ".eyebrow", detail: 'eyebrow label "New feature" above a heading' }]);
  });

  it("does not flag an eyebrow without a following heading", () => {
    expect(
      slopFindings([node({ text: "New feature", fontPx: 12, textTransform: "uppercase", nextTag: "p" })]),
    ).toEqual([]);
  });

  it("flags gradient text", () => {
    const out = slopFindings([
      node({
        selector: ".grad",
        text: "Hello",
        backgroundImage: "linear-gradient(90deg, #f00, #00f)",
        backgroundClip: "text",
      }),
    ]);
    expect(out).toEqual([{ rule: "slop", selector: ".grad", detail: "gradient text" }]);
  });

  it("does not flag a gradient background without text clip", () => {
    expect(
      slopFindings([
        node({ backgroundImage: "linear-gradient(90deg, #f00, #00f)", backgroundClip: "border-box" }),
      ]),
    ).toEqual([]);
  });

  it("flags a single heavy side stripe", () => {
    const out = slopFindings([node({ selector: ".stripe", borderPx: { top: 0, right: 0, bottom: 0, left: 4 } })]);
    expect(out).toEqual([{ rule: "slop", selector: ".stripe", detail: "4px side stripe on one edge" }]);
  });

  it("does not flag heavy borders on both sides", () => {
    expect(slopFindings([node({ borderPx: { top: 0, right: 2, bottom: 0, left: 2 } })])).toEqual([]);
  });

  it("flags a hard offset shadow", () => {
    const out = slopFindings([node({ selector: ".shadow", boxShadow: "0px 4px 0px 0px rgba(0, 0, 0, 0.2)" })]);
    expect(out).toEqual([{ rule: "slop", selector: ".shadow", detail: "hard offset shadow (no blur)" }]);
  });

  it("does not flag a blurred shadow", () => {
    expect(slopFindings([node({ boxShadow: "rgba(0, 0, 0, 0.1) 0px 4px 12px 0px" })])).toEqual([]);
  });

  it("flags three identical cards once", () => {
    const cards = Array.from({ length: 3 }, (_v, i) =>
      node({ selector: `.card${i}`, cardLike: true, childSig: "h3,p", parentSelector: ".grid" }),
    );
    expect(slopFindings(cards)).toEqual([{ rule: "slop", selector: ".grid", detail: "3 identical cards (h3,p)" }]);
  });

  it("does not flag only two identical cards", () => {
    const cards = Array.from({ length: 2 }, (_v, i) =>
      node({ selector: `.card${i}`, cardLike: true, childSig: "h3,p", parentSelector: ".grid" }),
    );
    expect(slopFindings(cards)).toEqual([]);
  });

  it("does not flag identical cards with different widths", () => {
    const cards = [300, 310, 320].map((width, i) =>
      node({ selector: `.card${i}`, cardLike: true, childSig: "h3,p", parentSelector: ".grid", width }),
    );
    expect(slopFindings(cards)).toEqual([]);
  });

  it("emits identical cards once per parent", () => {
    const cards = Array.from({ length: 5 }, (_v, i) =>
      node({ selector: `.card${i}`, cardLike: true, childSig: "h3,p", parentSelector: ".grid" }),
    );
    expect(slopFindings(cards)).toEqual([{ rule: "slop", selector: ".grid", detail: "5 identical cards (h3,p)" }]);
  });

  it("flags an emoji used as an icon", () => {
    const out = slopFindings([node({ selector: ".icon", text: "✨" })]);
    expect(out).toEqual([{ rule: "slop", selector: ".icon", detail: "emoji used as an icon" }]);
  });

  it("does not flag a word as an emoji", () => {
    expect(slopFindings([node({ text: "Hello" })])).toEqual([]);
  });

  it("flags an overused display font", () => {
    const out = slopFindings([node({ selector: "h1", tag: "h1", text: "Title", fontFamily: "Inter" })]);
    expect(out).toEqual([
      { rule: "slop", selector: "h1", detail: '"Inter" display face is an overused default' },
    ]);
  });

  it("does not flag a distinctive display font", () => {
    expect(slopFindings([node({ tag: "h1", text: "Title", fontFamily: "Bricolage Grotesque" })])).toEqual([]);
  });

  it("emits an overused font once per family", () => {
    const out = slopFindings([
      node({ selector: "h1", tag: "h1", text: "One", fontFamily: "Inter" }),
      node({ selector: "h2.title", tag: "h2", text: "Two", fontFamily: "Inter" }),
    ]);
    expect(out).toEqual([
      { rule: "slop", selector: "h1", detail: '"Inter" display face is an overused default' },
    ]);
  });

  it("collectSlop is a serializable page function", () => {
    expect(typeof collectSlop).toBe("function");
    expect(collectSlop.toString()).toContain("querySelectorAll");
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
    expect(script).toContain("collectSlop");
    expect(script).toContain("slopFindings");
    expect(() => new Function("return " + script)).not.toThrow();
  });
});
