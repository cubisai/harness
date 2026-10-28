import { describe, expect, it } from "vitest";
import {
  collectTypeSlop,
  typeSlopFindings,
  type TypeSlopNode,
  type TypeSlopSnapshot,
} from "../src/main/design/slop-type";

const node = (over: Partial<TypeSlopNode>): TypeSlopNode => ({
  selector: "div",
  tag: "div",
  text: "",
  textLen: 0,
  fontPx: 16,
  lineHeightPx: 24,
  letterSpacingPx: 0,
  fontStyle: "normal",
  fontFamily: "Helvetica, sans-serif",
  textAlign: "left",
  textTransform: "none",
  textWrap: "wrap",
  rectX: 0,
  rectY: 0,
  rectWidth: 600,
  rectHeight: 24,
  radius: 0,
  paintedBackground: false,
  hasBorder: false,
  insideFooter: false,
  insideNav: false,
  nextTag: null,
  prevTag: null,
  hasOwnText: true,
  visible: true,
  lineCount: 1,
  lastWordAlone: false,
  ...over,
});

const snapshot = (nodes: TypeSlopNode[], viewportHeight = 800): TypeSlopSnapshot => ({ nodes, viewportHeight });

const byId = (out: ReturnType<typeof typeSlopFindings>, id: string): ReturnType<typeof typeSlopFindings> =>
  out.filter((finding) => finding.id === id);

describe("typeSlopFindings", () => {
  it("flags an italic serif display headline", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: "h1.hero",
          tag: "h1",
          text: "Elegant work",
          textLen: 12,
          fontPx: 72,
          fontStyle: "italic",
          fontFamily: '"Playfair Display", Georgia, serif',
        }),
      ]),
    );
    const found = byId(out, "italic-serif-display");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "slop", selector: "h1.hero" });
    expect(found[0]!.detail).toContain("italic serif display headline");
  });

  it("does not flag an italic sans-serif headline", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: "h1.hero",
          tag: "h1",
          text: "Elegant work",
          textLen: 12,
          fontPx: 72,
          fontStyle: "italic",
          fontFamily: '"Inter", sans-serif',
        }),
      ]),
    );
    expect(byId(out, "italic-serif-display")).toEqual([]);
  });

  it("flags a pill badge above the h1", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: ".badge",
          tag: "span",
          text: "New in 2.0",
          textLen: 10,
          fontPx: 12,
          rectHeight: 24,
          radius: 12,
          paintedBackground: true,
          nextTag: "h1",
        }),
      ]),
    );
    const found = byId(out, "hero-chip");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: ".badge" });
    expect(found[0]!.detail).toContain('badge "New in 2.0"');
  });

  it("does not flag a pill badge followed by a paragraph", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: ".badge",
          tag: "span",
          text: "New in 2.0",
          textLen: 10,
          fontPx: 12,
          rectHeight: 24,
          radius: 12,
          paintedBackground: true,
          nextTag: "p",
        }),
      ]),
    );
    expect(byId(out, "hero-chip")).toEqual([]);
  });

  it("flags an oversized h1", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: "h1.hero", tag: "h1", text: "Big", textLen: 3, fontPx: 112, rectHeight: 120 }),
      ]),
    );
    const found = byId(out, "oversized-headline");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: "h1.hero" });
    expect(found[0]!.detail).toContain("112px headline");
  });

  it("does not flag a 96px h1 under 60% of the viewport", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: "h1.hero", tag: "h1", text: "Big", textLen: 3, fontPx: 96, rectHeight: 400 }),
      ]),
    );
    expect(byId(out, "oversized-headline")).toEqual([]);
  });

  it("measures display type against the system's own display size and skips slides", () => {
    const h1 = (fontPx: number, over: Partial<TypeSlopNode> = {}): TypeSlopNode =>
      node({ selector: "h1.hero", tag: "h1", text: "Big", textLen: 3, fontPx, rectHeight: 130, ...over });
    expect(byId(typeSlopFindings({ ...snapshot([h1(120)]), displayTokenPx: 120 }), "oversized-headline")).toEqual([]);
    const over = byId(typeSlopFindings({ ...snapshot([h1(140)]), displayTokenPx: 120 }), "oversized-headline");
    expect(over[0]!.detail).toContain("the system's 121px");
    expect(byId(typeSlopFindings(snapshot([h1(148, { inSlide: true })])), "oversized-headline")).toEqual([]);
  });

  it("flags crushed letter spacing", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: ".tight",
          tag: "h3",
          text: "Ship faster",
          textLen: 11,
          fontPx: 32,
          letterSpacingPx: -1.92,
        }),
      ]),
    );
    const found = byId(out, "crushed-tracking");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: ".tight" });
    expect(found[0]!.detail).toContain('letter-spacing -0.06em on "Ship faster"');
  });

  it("does not flag tracking looser than -0.04em", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: ".tight",
          tag: "h3",
          text: "Ship faster",
          textLen: 11,
          fontPx: 32,
          letterSpacingPx: -1.2,
        }),
      ]),
    );
    expect(byId(out, "crushed-tracking")).toEqual([]);
  });

  it("flags a flat heading hierarchy against body text", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: "h1", tag: "h1", text: "Title", textLen: 5, fontPx: 20 }),
        node({ selector: "h2", tag: "h2", text: "Section", textLen: 7, fontPx: 19 }),
        node({ selector: ".body", tag: "p", text: "Running text", textLen: 100, fontPx: 16, lineHeightPx: 24 }),
      ]),
    );
    const found = byId(out, "flat-hierarchy");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: "body" });
    expect(found[0]!.detail).toContain("headings barely step up");
  });

  it("does not flag a clear heading hierarchy", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: "h1", tag: "h1", text: "Title", textLen: 5, fontPx: 64 }),
        node({ selector: "h2", tag: "h2", text: "Section", textLen: 7, fontPx: 40 }),
        node({ selector: "h3", tag: "h3", text: "Sub", textLen: 3, fontPx: 28 }),
        node({ selector: ".body", tag: "p", text: "Running text", textLen: 100, fontPx: 16, lineHeightPx: 24 }),
      ]),
    );
    expect(byId(out, "flat-hierarchy")).toEqual([]);
  });

  it("flags justified body text with a count", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 100, textAlign: "justify", lineHeightPx: 26.4 }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 100, textAlign: "justify", lineHeightPx: 26.4 }),
        node({ selector: ".p3", tag: "p", text: "Three", textLen: 100, textAlign: "justify", lineHeightPx: 26.4 }),
      ]),
    );
    const found = byId(out, "justified-text");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: ".p1" });
    expect(found[0]!.detail).toContain("3 paragraphs justified");
  });

  it("does not flag left-aligned body text", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 100, textAlign: "left" }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 100, textAlign: "left" }),
      ]),
    );
    expect(byId(out, "justified-text")).toEqual([]);
  });

  it("flags tight body leading on two or more paragraphs", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 140, fontPx: 18, lineHeightPx: 21.6 }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 140, fontPx: 18, lineHeightPx: 21.6 }),
      ]),
    );
    const found = byId(out, "tight-body-leading");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ selector: ".p1" });
    expect(found[0]!.detail).toContain("body text at line-height 1.2");
  });

  it("does not flag comfortable body leading", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 140, fontPx: 18, lineHeightPx: 27 }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 140, fontPx: 18, lineHeightPx: 27 }),
      ]),
    );
    expect(byId(out, "tight-body-leading")).toEqual([]);
  });

  it("flags tiny body text on two or more paragraphs", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 100, fontPx: 13, lineHeightPx: 19.5 }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 100, fontPx: 13, lineHeightPx: 19.5 }),
      ]),
    );
    const found = byId(out, "tiny-text");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ selector: ".p1" });
    expect(found[0]!.detail).toContain("13px body text");
  });

  it("does not flag 14px body text", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 100, fontPx: 14 }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 100, fontPx: 14 }),
      ]),
    );
    expect(byId(out, "tiny-text")).toEqual([]);
  });

  it("flags tiny control labels on two or more controls", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".b1", tag: "button", text: "OK", textLen: 2, fontPx: 11 }),
        node({ selector: ".b2", tag: "button", text: "Go", textLen: 2, fontPx: 11 }),
      ]),
    );
    const found = byId(out, "tiny-text");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ selector: ".b1" });
    expect(found[0]!.detail).toContain("11px control label");
  });

  it("does not flag 12px control labels", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".b1", tag: "button", text: "OK", textLen: 2, fontPx: 12 }),
        node({ selector: ".b2", tag: "button", text: "Go", textLen: 2, fontPx: 12 }),
      ]),
    );
    expect(byId(out, "tiny-text")).toEqual([]);
  });

  it("flags wide-tracked body text", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 100, fontPx: 16, letterSpacingPx: 1.28, lineHeightPx: 26.56 }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 100, fontPx: 16, letterSpacingPx: 1.28, lineHeightPx: 26.56 }),
      ]),
    );
    const found = byId(out, "wide-tracked-body");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ selector: ".p1" });
    expect(found[0]!.detail).toContain("body text tracked at 0.08em");
  });

  it("does not flag body text tracked below 0.05em", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: ".p1", tag: "p", text: "One", textLen: 100, fontPx: 16, letterSpacingPx: 0.64 }),
        node({ selector: ".p2", tag: "p", text: "Two", textLen: 100, fontPx: 16, letterSpacingPx: 0.64 }),
      ]),
    );
    expect(byId(out, "wide-tracked-body")).toEqual([]);
  });

  it("flags a skipped heading level", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: "h1", tag: "h1", text: "Title", textLen: 5, fontPx: 48 }),
        node({ selector: "h3", tag: "h3", text: "Sub", textLen: 3, fontPx: 24 }),
      ]),
    );
    const found = byId(out, "skipped-heading");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: "h3" });
    expect(found[0]!.detail).toContain("h1 followed by h3");
  });

  it("does not flag consecutive heading levels", () => {
    const out = typeSlopFindings(
      snapshot([
        node({ selector: "h1", tag: "h1", text: "Title", textLen: 5, fontPx: 48 }),
        node({ selector: "h2", tag: "h2", text: "Sub", textLen: 3, fontPx: 24 }),
      ]),
    );
    expect(byId(out, "skipped-heading")).toEqual([]);
  });

  it("flags a heading that ends on one word", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: "h2.title",
          tag: "h2",
          text: "Ship it slowly",
          textLen: 14,
          fontPx: 32,
          lineCount: 2,
          lastWordAlone: true,
        }),
      ]),
    );
    const found = byId(out, "stub-line");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ selector: "h2.title" });
    expect(found[0]!.detail).toContain('"Ship it slowly" heading ends on one word');
  });

  it("does not flag a stub line that already balances", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: "h2.title",
          tag: "h2",
          text: "Ship it slowly",
          textLen: 14,
          fontPx: 32,
          textWrap: "balance",
          lineCount: 2,
          lastWordAlone: true,
        }),
      ]),
    );
    expect(byId(out, "stub-line")).toEqual([]);
  });

  it("flags a body paragraph that ends on one word", () => {
    const out = typeSlopFindings(
      snapshot([
        node({
          selector: ".p1",
          tag: "p",
          text: "The last word sits alone here",
          textLen: 80,
          lineCount: 2,
          lastWordAlone: true,
        }),
      ]),
    );
    const found = byId(out, "stub-line");
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("paragraph ends on one word");
  });

  it("findings function is self-contained", () => {
    const fixture = snapshot([
      node({
        selector: "h1.hero",
        tag: "h1",
        text: "Elegant work",
        textLen: 12,
        fontPx: 72,
        fontStyle: "italic",
        fontFamily: '"Playfair Display", Georgia, serif',
      }),
    ]);
    const copy = new Function(`return (${typeSlopFindings.toString()})`)() as typeof typeSlopFindings;
    expect(copy(fixture)).toEqual(typeSlopFindings(fixture));
  });

  it("collector is a serializable page function", () => {
    expect(() => new Function(`return (${collectTypeSlop.toString()})`)()).not.toThrow();
    expect(collectTypeSlop.toString()).toContain("getComputedStyle");
  });
});
