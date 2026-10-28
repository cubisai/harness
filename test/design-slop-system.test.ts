import { describe, expect, it } from "vitest";
import { collectSystemSlop, systemSlopFindings, type SystemSlopSnapshot, type SystemUse } from "../src/main/design/slop-system";

const use = (value: string, count = 1, selector = ".x"): SystemUse => ({ value, count, selector });
const snap = (over: Partial<SystemSlopSnapshot>): SystemSlopSnapshot => ({
  fonts: ["archivo", "jetbrains mono"],
  sizes: [12, 14, 16, 20, 24, 32],
  sizeRanges: [[40, 64]],
  radii: [0, 4, 8],
  pill: true,
  usedFonts: [],
  usedSizes: [],
  usedRadii: [],
  ...over,
});

describe("systemSlopFindings", () => {
  it("is quiet when everything is on token", () => {
    const s = snap({
      usedFonts: [use("archivo", 20), use("jetbrains mono", 3), use("sans-serif"), use("material symbols outlined")],
      usedSizes: [use("16", 30), use("14", 4), use("52.5", 1)],
      usedRadii: [use("8", 6), use("4", 2)],
    });
    expect(systemSlopFindings(s)).toEqual([]);
  });

  it("names off-token fonts, sizes and radii with counts, most used first", () => {
    const s = snap({
      usedFonts: [use("archivo", 20), use("inter", 5, "nav a")],
      usedSizes: [use("16", 30), use("15", 2, ".lead"), use("13", 6, ".meta"), use("72", 1, "h1")],
      usedRadii: [use("8", 3), use("12", 4, ".card")],
    });
    const out = systemSlopFindings(s);
    expect(out.map((f) => f.id)).toEqual(["token-font", "token-size", "token-radius"]);
    expect(out[0]).toMatchObject({ rule: "slop", selector: "nav a" });
    expect(out[0]!.detail).toContain("inter (5)");
    expect(out[1]).toMatchObject({ selector: ".meta" });
    expect(out[1]!.detail).toContain("13px (6), 15px (2), 72px (1) on 9 elements");
    expect(out[2]!.detail).toContain("12px radius (4)");
  });

  it("checks nothing a page has no tokens for", () => {
    const s = snap({ fonts: [], sizes: [], sizeRanges: [], radii: [], pill: false, usedFonts: [use("inter")], usedSizes: [use("15")], usedRadii: [use("12")] });
    expect(systemSlopFindings(s)).toEqual([]);
  });

  it("findings function is self-contained", () => {
    const copy = new Function(`return (${systemSlopFindings.toString()})`)() as typeof systemSlopFindings;
    const s = snap({ usedSizes: [use("15", 2)] });
    expect(copy(s)).toEqual(systemSlopFindings(s));
  });

  it("collector is a serializable page function", () => {
    expect(() => new Function(`return (${collectSystemSlop.toString()})`)()).not.toThrow();
    expect(collectSystemSlop.toString()).toContain("getComputedStyle");
  });
});
