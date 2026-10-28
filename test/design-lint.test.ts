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
  type SlopPage,
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
    expect(out).toEqual([{ rule: "slop", id: "eyebrow", selector: ".eyebrow", detail: 'eyebrow label "New feature" above a heading' }]);
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
    expect(out).toEqual([{ rule: "slop", id: "gradient-text", selector: ".grad", detail: "gradient text" }]);
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
    expect(out).toEqual([{ rule: "slop", id: "side-stripe", selector: ".stripe", detail: "4px side stripe on one edge" }]);
  });

  it("does not flag heavy borders on both sides", () => {
    expect(slopFindings([node({ borderPx: { top: 0, right: 2, bottom: 0, left: 2 } })])).toEqual([]);
  });

  it("flags a hard offset shadow", () => {
    const out = slopFindings([node({ selector: ".shadow", boxShadow: "0px 4px 0px 0px rgba(0, 0, 0, 0.2)" })]);
    expect(out).toEqual([{ rule: "slop", id: "hard-offset-shadow", selector: ".shadow", detail: "hard offset shadow (no blur)" }]);
  });

  it("does not flag a blurred shadow", () => {
    expect(slopFindings([node({ boxShadow: "rgba(0, 0, 0, 0.1) 0px 4px 12px 0px" })])).toEqual([]);
  });

  it("flags three identical cards once", () => {
    const cards = Array.from({ length: 3 }, (_v, i) =>
      node({ selector: `.card${i}`, cardLike: true, childSig: "h3,p", parentSelector: ".grid" }),
    );
    expect(slopFindings(cards)).toEqual([{ rule: "slop", id: "identical-cards", selector: ".grid", detail: "3 identical cards (h3,p)" }]);
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
    expect(slopFindings(cards)).toEqual([{ rule: "slop", id: "identical-cards", selector: ".grid", detail: "5 identical cards (h3,p)" }]);
  });

  it("flags an emoji used as an icon", () => {
    const out = slopFindings([node({ selector: ".icon", text: "✨" })]);
    expect(out).toEqual([{ rule: "slop", id: "emoji-icon", selector: ".icon", detail: "emoji used as an icon" }]);
  });

  it("does not flag a word as an emoji", () => {
    expect(slopFindings([node({ text: "Hello" })])).toEqual([]);
  });

  it("flags an overused display font", () => {
    const out = slopFindings([node({ selector: "h1", tag: "h1", text: "Title", fontFamily: "Inter" })]);
    expect(out).toEqual([
      { rule: "slop", id: "overused-font", selector: "h1", detail: '"Inter" display face is an overused default' },
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
      { rule: "slop", id: "overused-font", selector: "h1", detail: '"Inter" display face is an overused default' },
    ]);
  });

  it("collectSlop is a serializable page function", () => {
    expect(typeof collectSlop).toBe("function");
    expect(collectSlop.toString()).toContain("querySelectorAll");
  });

  it("flags display leading on large headings", () => {
    const out = slopFindings([node({ selector: ".hero", tag: "h1", text: "Hero", fontPx: 48, lineHeightPx: 72 })]);
    expect(out.some((f) => f.detail.includes("px heading at line-height 1.50"))).toBe(true);
  });

  it("does not flag display type set tight", () => {
    expect(
      slopFindings([node({ tag: "h1", text: "Hero", fontPx: 48, lineHeightPx: 52.8 })]),
    ).toEqual([]);
  });

  it("flags long paragraph measure on two or more paragraphs", () => {
    const out = slopFindings([
      node({ selector: ".p1", tag: "p", textLen: 200, width: 800 }),
      node({ selector: ".p2", tag: "p", textLen: 200, width: 800 }),
    ]);
    expect(out.filter((f) => f.detail.includes("paragraph runs about 100 characters a line"))).toHaveLength(2);
  });

  it("does not flag a long measure with only one paragraph", () => {
    expect(slopFindings([node({ tag: "p", textLen: 200, width: 800 })])).toEqual([]);
  });

  it("flags transition: all on most controls", () => {
    const nodes = Array.from({ length: 8 }, (_v, i) =>
      node({ selector: `.btn${i}`, tag: "button", transitionProperty: "all", transitionDuration: "0.2s" }),
    );
    const out = slopFindings(nodes);
    expect(out.some((f) => f.detail.includes("transition: all on 8 of 8 controls"))).toBe(true);
  });

  it("ignores the default computed transition (all, 0s)", () => {
    const nodes = Array.from({ length: 8 }, (_v, i) => node({ selector: `.btn${i}`, tag: "button", transitionProperty: "all", transitionDuration: "0s" }));
    expect(slopFindings(nodes)).toEqual([]);
  });

  it("does not flag transition: all on half the controls", () => {
    const nodes = Array.from({ length: 8 }, (_v, i) =>
      node({
        selector: `.btn${i}`,
        tag: "button",
        transitionProperty: i < 4 ? "all" : "opacity",
        transitionDuration: "0.2s",
      }),
    );
    expect(slopFindings(nodes)).toEqual([]);
  });

  it("flags overshooting cubic-bezier easing", () => {
    const out = slopFindings([
      node({ selector: ".pop", transitionTiming: "cubic-bezier(0.34, 1.56, 0.64, 1)" }),
    ]);
    expect(out.some((f) => f.detail.includes("overshooting easing cubic-bezier(0.34, 1.56, 0.64, 1)"))).toBe(true);
  });

  it("flags coloured glow shadows on two or more nodes", () => {
    const out = slopFindings([
      node({ selector: ".glow1", boxShadow: "0px 0px 30px rgba(0, 128, 255, 0.5)" }),
      node({ selector: ".glow2", boxShadow: "0px 0px 30px rgba(0, 128, 255, 0.5)" }),
    ]);
    expect(out.filter((f) => f.detail.includes("coloured glow shadow"))).toHaveLength(2);
  });

  it("flags a large blurred decorative blob", () => {
    const out = slopFindings([
      node({ selector: ".blob", position: "absolute", width: 400, height: 400, filter: "blur(60px)" }),
    ]);
    expect(out.some((f) => f.detail.includes("blurred decorative blob"))).toBe(true);
  });

  it("flags a frosted glass panel holding content", () => {
    const out = slopFindings([
      node({ selector: ".panel", tag: "section", backdropFilter: "blur(20px)", cardLike: true, textLen: 60 }),
    ]);
    expect(out.some((f) => f.detail.includes("frosted glass panel holding content"))).toBe(true);
  });

  it("flags one radius applied to every shape", () => {
    const nodes = Array.from({ length: 9 }, (_v, i) =>
      node({ selector: `.btn${i}`, tag: "button", radius: 8, width: 100 }),
    );
    nodes.push(node({ selector: ".card", cardLike: true, radius: 8, width: 400 }));
    const out = slopFindings(nodes);
    expect(out.some((f) => f.detail.includes("one 8px radius on 10 of 10 shapes"))).toBe(true);
  });

  it("does not flag a single radius on fewer than ten shapes", () => {
    const nodes = Array.from({ length: 9 }, (_v, i) =>
      node({ selector: `.btn${i}`, tag: "button", radius: 8, width: 100 }),
    );
    expect(slopFindings(nodes)).toEqual([]);
  });

  it("flags a field labelled only by its placeholder", () => {
    const out = slopFindings([node({ selector: ".field", tag: "input", labelled: false, placeholder: "Email" })]);
    expect(out.some((f) => f.detail.includes('field labelled only by its placeholder "Email"'))).toBe(true);
  });

  it("does not flag a labelled field with a placeholder", () => {
    expect(
      slopFindings([node({ tag: "input", labelled: true, placeholder: "Email" })]),
    ).toEqual([]);
  });

  it("flags an image without alt text", () => {
    const out = slopFindings([node({ selector: ".pic", tag: "img", hasAlt: false })]);
    expect(out.some((f) => f.detail.includes("image without alt text"))).toBe(true);
  });

  it("flags horizontal page overflow", () => {
    const out = slopFindings([node({})], { overflowPx: 40, text: "", ctas: [] });
    expect(out.some((f) => f.detail.includes("page scrolls sideways by 40px"))).toBe(true);
  });

  it("flags text its box cuts off and text drawn over other text", () => {
    const out = slopFindings([node({})], {
      overflowPx: 0,
      text: "",
      ctas: [],
      clipped: [{ selector: "footer button", text: "Schedule private viewing", px: 94 }],
      overlaps: [{ selector: "nav span", text: "Map", other: "$310,000" }],
    });
    expect(out).toContainEqual({ rule: "slop", id: "clipped-text", selector: "footer button", detail: expect.stringContaining('"Schedule private viewing" is cut off by its box (94px hidden)') });
    expect(out).toContainEqual({ rule: "slop", id: "text-overlap", selector: "nav span", detail: expect.stringContaining('"Map" overlaps "$310,000"') });
    expect(slopFindings([node({})], { overflowPx: 0, text: "", ctas: [], clipped: [], overlaps: [] })).toEqual([]);
  });

  it("flags generic copy clichés", () => {
    const out = slopFindings([node({})], {
      overflowPx: 0,
      text: "Supercharge your workflow with a seamless all-in-one platform.",
      ctas: [],
    });
    expect(out.some((f) => f.detail.includes("generic copy (Supercharge, seamless, all-in-one)"))).toBe(true);
  });

  it("does not flag a single copy cliché", () => {
    expect(
      slopFindings([node({})], { overflowPx: 0, text: "Seamless onboarding for teams.", ctas: [] }),
    ).toEqual([]);
  });

  it("flags generic calls to action", () => {
    const out = slopFindings([node({})], {
      overflowPx: 0,
      text: "",
      ctas: ["Get Started", "Learn More", "Book a Demo"],
    });
    expect(out.some((f) => f.detail.includes("generic calls to action"))).toBe(true);
  });

  it("does not flag two generic calls to action", () => {
    expect(
      slopFindings([node({})], { overflowPx: 0, text: "", ctas: ["Get Started", "Learn More"] }),
    ).toEqual([]);
  });

  it("flags placeholder copy", () => {
    const out = slopFindings([node({})], {
      overflowPx: 0,
      text: "Trusted by Acme to power your company.",
      ctas: [],
    });
    expect(out.some((f) => f.detail.includes('placeholder copy "Acme"'))).toBe(true);
  });

  const page = (over: Partial<SlopPage>): SlopPage => ({ overflowPx: 0, text: "", ctas: [], ...over });

  it("flags a font stack with no generic fallback, but not an icon font", () => {
    const out = slopFindings([node({})], page({ fontStacks: ['Figtree', '"Bricolage Grotesque", sans-serif', '"Material Symbols Outlined"'] }));
    expect(out.map((f) => f.detail)).toEqual(['font stack "Figtree" has no generic fallback: end it with sans-serif, serif or monospace']);
  });

  it("flags pseudo-data in prose, not a single identifier", () => {
    const out = slopFindings([node({})], page({ proseText: "WALLET // ACTIVE_SYNC  SECURITY HASH 0X00000000  SLOT: 00-WALLET-NULL" }));
    expect(out.some((f) => f.detail.startsWith("pseudo-data in copy (ACTIVE_SYNC, 0X00000000, NULL)"))).toBe(true);
    expect(slopFindings([node({})], page({ proseText: "Set API_KEY before you run the CLI." }))).toEqual([]);
  });

  it("flags running text in capitals, innermost block only", () => {
    const sentence = "Your digital wallet is empty. Saved gigs and encrypted passes will appear here once purchased.";
    const out = slopFindings([
      node({ selector: ".empty", tag: "div", childSig: "p", text: sentence, textLen: sentence.length, textTransform: "uppercase" }),
      node({ selector: ".empty p", tag: "p", parentSelector: ".empty", text: sentence, textLen: sentence.length, textTransform: "uppercase" }),
      node({ selector: ".typed", tag: "p", text: sentence.toUpperCase(), textLen: sentence.length }),
    ]);
    expect(out.map((f) => f.selector)).toEqual([".empty p", ".typed"]);
  });

  it("does not flag short caps labels or a display headline", () => {
    expect(
      slopFindings([
        node({ selector: ".label", text: "DOORS 20:00 // LIVE 21:30", textLen: 25, textTransform: "uppercase" }),
        node({ selector: "h1", tag: "h1", fontPx: 56, text: "THE MEKONG STATIC SPECIAL ALBUM RELEASE SHOW AT ROOFTOP 51 THIS FRIDAY", textLen: 70 }),
      ]),
    ).toEqual([]);
  });

  it("flags a row of equal metric cards", () => {
    const kpis = [0, 1, 2, 3].map((i) => node({ selector: `.kpi${i}`, parentSelector: ".kpis", cardLike: true, bigNumber: true, width: 280, height: 140 }));
    const out = slopFindings(kpis);
    expect(out.some((f) => f.selector === ".kpis" && f.detail.startsWith("4 equal metric cards in a row"))).toBe(true);
  });

  it("does not flag metric cards of different widths, two cards, or cards without a big figure", () => {
    const uneven = [280, 280, 280, 560].map((w, i) => node({ selector: `.k${i}`, parentSelector: ".row", cardLike: true, bigNumber: true, width: w }));
    const two = [0, 1].map((i) => node({ selector: `.t${i}`, parentSelector: ".two", cardLike: true, bigNumber: true, width: 280 }));
    const plain = [0, 1, 2].map((i) => node({ selector: `.p${i}`, parentSelector: ".plain", cardLike: true, bigNumber: false, width: 280 }));
    const slides = [0, 1, 2, 3].map((i) => node({ selector: `.s${i}`, parentSelector: ".deck", cardLike: true, bigNumber: true, width: 1280, height: 720 }));
    const hidden = [0, 1, 2, 3].map((i) => node({ selector: `.h${i}`, parentSelector: ".deck2", cardLike: true, bigNumber: true, width: 0, height: 0 }));
    for (const set of [uneven, two, plain, slides, hidden]) expect(slopFindings(set).some((f) => f.detail.includes("metric cards"))).toBe(false);
  });

  it("flags zero-padded index labels used as decoration", () => {
    const out = slopFindings([
      node({ selector: ".i1", text: "01 / WORK", fontPx: 12 }),
      node({ selector: ".i2", text: "[ 02 / ABOUT ]", fontPx: 12 }),
    ]);
    expect(out.some((f) => f.selector === ".i1" && f.detail.startsWith('2 index labels as decoration ("01 / WORK", "[ 02 / ABOUT ]")'))).toBe(true);
  });

  it("does not flag one index label, times, dates or large numbers", () => {
    const cases = [
      [node({ selector: ".a", text: "01 / WORK", fontPx: 12 })],
      [node({ selector: ".b", text: "07:00 PM", fontPx: 12 }), node({ selector: ".c", text: "05/12/2026", fontPx: 12 })],
      [node({ selector: ".d", text: "01 / WORK", fontPx: 20 }), node({ selector: ".e", text: "02 / ABOUT", fontPx: 20 })],
    ];
    for (const set of cases) expect(slopFindings(set).some((f) => f.detail.includes("index labels"))).toBe(false);
  });

  it("flags mostly centred paragraphs", () => {
    const long = "Plan the week from your backlog in ten minutes and keep the team on the same page every Monday.";
    const ps = [0, 1, 2, 3, 4, 5].map((i) => node({ selector: `p${i}`, tag: "p", text: long.slice(0, 80), textLen: long.length, textAlign: i < 5 ? "center" : "left" }));
    expect(slopFindings(ps).some((f) => f.detail.startsWith("5 of 6 paragraphs centred"))).toBe(true);
  });

  it("does not flag a few centred paragraphs", () => {
    const long = "Plan the week from your backlog in ten minutes and keep the team on the same page every Monday.";
    const some = [0, 1, 2, 3, 4].map((i) => node({ selector: `p${i}`, tag: "p", text: long.slice(0, 80), textLen: long.length, textAlign: i < 2 ? "center" : "left" }));
    const few = [0, 1, 2, 3].map((i) => node({ selector: `q${i}`, tag: "p", text: long.slice(0, 80), textLen: long.length, textAlign: "center" }));
    for (const set of [some, few]) expect(slopFindings(set).some((f) => f.detail.includes("paragraphs centred"))).toBe(false);
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
    expect(script).toContain("collectSlopPage");
    expect(script).toContain("slopFindings");
    expect(() => new Function("return " + script)).not.toThrow();
  });
});
