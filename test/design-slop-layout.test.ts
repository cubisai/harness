import { describe, expect, it } from "vitest";
import {
  collectLayoutSlop,
  layoutSlopFindings,
  type LayoutSlopElement,
  type LayoutSlopSnapshot,
} from "../src/main/design/slop-layout";

const node = (over: Partial<LayoutSlopElement>): LayoutSlopElement => ({
  selector: "div",
  tag: "div",
  width: 300,
  height: 200,
  left: 0,
  right: 300,
  card: false,
  nestedInCard: false,
  iconTile: false,
  tileBeforeHeading: false,
  textLength: 0,
  clipPath: "none",
  maskImage: "none",
  edgeFlushScroller: false,
  ...over,
});

const snap = (elements: LayoutSlopElement[], over: Partial<LayoutSlopSnapshot> = {}): LayoutSlopSnapshot => ({
  viewportWidth: 1200,
  viewportHeight: 800,
  gaps: [],
  elements,
  ...over,
});

const nestedCards = (): LayoutSlopSnapshot =>
  snap([
    node({ selector: ".outer", card: true }),
    node({ selector: ".inner", card: true, nestedInCard: true }),
  ]);

describe("layoutSlopFindings", () => {
  it("flags a card nested inside a card", () => {
    const out = layoutSlopFindings(nestedCards());
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("nested-cards");
    expect(out[0]!.selector).toBe(".inner");
    expect(out[0]!.detail).toContain("flatten");
  });

  it("does not flag a single card", () => {
    expect(layoutSlopFindings(snap([node({ selector: ".card", card: true })]))).toEqual([]);
  });

  it("flags three or more icon tiles above headings", () => {
    const tiles = Array.from({ length: 4 }, (_v, i) =>
      node({ selector: `.tile${i}`, width: 48, height: 48, iconTile: true, tileBeforeHeading: true }),
    );
    const out = layoutSlopFindings(snap(tiles));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("icon-tile-stack");
    expect(out[0]!.selector).toBe(".tile0");
    expect(out[0]!.detail).toContain("4 icon tiles");
  });

  it("does not flag two icon tiles or tiles without a heading", () => {
    const two = [0, 1].map((i) => node({ selector: `.tile${i}`, iconTile: true, tileBeforeHeading: true }));
    const noHeading = [0, 1, 2].map((i) =>
      node({ selector: `.tile${i}`, iconTile: true, tileBeforeHeading: false }),
    );
    expect(layoutSlopFindings(snap(two))).toEqual([]);
    expect(layoutSlopFindings(snap(noHeading))).toEqual([]);
  });

  it("flags headings with more space below than above", () => {
    const out = layoutSlopFindings(
      snap([
        node({ selector: ".h1", tag: "h2", height: 40, headingGapAbove: 12, headingGapBelow: 24 }),
        node({ selector: ".h2", tag: "h3", height: 40, headingGapAbove: 8, headingGapBelow: 20 }),
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe("heading-rhythm");
    expect(out[0]!.selector).toBe(".h1");
    expect(out[0]!.detail).toContain("more space above");
  });

  it("does not flag one heading or headings with more space above", () => {
    const correct = [
      node({ selector: ".h1", tag: "h2", height: 40, headingGapAbove: 24, headingGapBelow: 12 }),
      node({ selector: ".h2", tag: "h3", height: 40, headingGapAbove: 20, headingGapBelow: 8 }),
    ];
    const single = [node({ selector: ".h1", tag: "h2", height: 40, headingGapAbove: 12, headingGapBelow: 24 })];
    expect(layoutSlopFindings(snap(correct))).toEqual([]);
    expect(layoutSlopFindings(snap(single))).toEqual([]);
  });

  it("flags a page where most gaps are one value", () => {
    const gaps = Array.from({ length: 12 }, () => 24);
    const out = layoutSlopFindings(snap([], { gaps }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("monotonous-spacing");
    expect(out[0]!.selector).toBe("body");
    expect(out[0]!.detail).toContain("the same 24px gap");
  });

  it("does not flag fewer than twelve gaps or a less uniform set", () => {
    const eleven = Array.from({ length: 11 }, () => 24);
    const varied = [24, 24, 24, 24, 24, 24, 24, 24, 24, 32, 40, 48];
    expect(layoutSlopFindings(snap([], { gaps: eleven }))).toEqual([]);
    expect(layoutSlopFindings(snap([], { gaps: varied }))).toEqual([]);
  });

  it("flags a sideways scroller whose first card touches its edge", () => {
    const out = layoutSlopFindings(snap([node({ selector: ".rail", edgeFlushScroller: true })]));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("edge-flush-cards");
    expect(out[0]!.selector).toBe(".rail");
    expect(out[0]!.detail).toContain("inset");
  });

  it("does not flag an inset card in a scroller", () => {
    expect(layoutSlopFindings(snap([node({ selector: ".rail", edgeFlushScroller: false })]))).toEqual([]);
  });

  it("flags running text touching the window edge", () => {
    const out = layoutSlopFindings(
      snap([node({ selector: ".lead", tag: "p", textLength: 80, height: 40, left: 2, right: 1180 })]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("text-at-viewport-edge");
    expect(out[0]!.selector).toBe(".lead");
    expect(out[0]!.detail).toContain("side padding");
  });

  it("does not flag text inside the side padding", () => {
    expect(
      layoutSlopFindings(
        snap([node({ selector: ".lead", tag: "p", textLength: 80, height: 40, left: 12, right: 1188 })]),
      ),
    ).toEqual([]);
  });

  it("flags text sitting close to its box edge", () => {
    const out = layoutSlopFindings(snap([node({ selector: ".badge", textInsetPx: 3 })]));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("cramped-padding");
    expect(out[0]!.selector).toBe(".badge");
    expect(out[0]!.detail).toContain("3px from its box edge");
  });

  it("does not flag comfortable padding", () => {
    expect(layoutSlopFindings(snap([node({ selector: ".badge", textInsetPx: 12 })]))).toEqual([]);
  });

  it("flags a large polygon clip-path", () => {
    const out = layoutSlopFindings(
      snap([
        node({
          selector: ".cut",
          width: 300,
          height: 200,
          clipPath: "polygon(0px 0px, 100% 0px, 100% 40%, 70% 100%, 30% 100%, 0px 60%)",
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("jagged-mask");
    expect(out[0]!.selector).toBe(".cut");
    expect(out[0]!.detail).toContain("plain rectangle");
  });

  it("flags an image mask but not a gradient fade", () => {
    const masked = [node({ selector: ".blob", width: 400, height: 300, maskImage: 'url("blob.svg")' })];
    const fade = [node({ selector: ".rail", width: 400, height: 300, maskImage: "linear-gradient(90deg, rgb(0, 0, 0) 80%, rgba(0, 0, 0, 0))" })];
    expect(layoutSlopFindings(snap(masked)).map((f) => f.id)).toEqual(["jagged-mask"]);
    expect(layoutSlopFindings(snap(fade))).toEqual([]);
  });

  it("flags at most two illustrations set on an organic blob", () => {
    const blob = (selector: string) => node({ selector, tag: "svg", width: 600, height: 600, organicBlob: true });
    expect(layoutSlopFindings(snap([blob(".a")])).map((f) => f.id)).toEqual(["organic-blob"]);
    expect(layoutSlopFindings(snap([blob(".a"), blob(".b"), blob(".c")]))).toHaveLength(2);
    expect(layoutSlopFindings(snap([node({ tag: "svg", width: 600, height: 600 })]))).toEqual([]);
  });

  it("does not flag a five-point polygon or a small shape", () => {
    const five = [
      node({
        selector: ".tag",
        width: 300,
        height: 200,
        clipPath: "polygon(0px 0px, 100% 0px, 100% 100%, 0px 100%, 50% 50%)",
      }),
    ];
    const small = [
      node({
        selector: ".small",
        width: 120,
        height: 160,
        clipPath: "polygon(0px 0px, 100% 0px, 100% 40%, 70% 100%, 30% 100%, 0px 60%)",
      }),
    ];
    expect(layoutSlopFindings(snap(five))).toEqual([]);
    expect(layoutSlopFindings(snap(small))).toEqual([]);
  });

  it("flags an image hidden by an overlay", () => {
    const out = layoutSlopFindings(
      snap([
        node({
          selector: "img.hero",
          tag: "img",
          width: 300,
          height: 200,
          src: "hero.png",
          complete: true,
          naturalWidth: 300,
          coveredByOverlay: true,
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("image-overlay");
    expect(out[0]!.selector).toBe("img.hero");
    expect(out[0]!.detail).toContain("lighten it");
  });

  it("does not flag a clear image", () => {
    expect(
      layoutSlopFindings(
        snap([
          node({
            selector: "img.hero",
            tag: "img",
            width: 300,
            height: 200,
            src: "hero.png",
            complete: true,
            naturalWidth: 300,
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("flags a missing or failed image", () => {
    const out = layoutSlopFindings(
      snap([
        node({ selector: "img.missing", tag: "img", src: "", complete: true, naturalWidth: 0 }),
        node({ selector: "img.failed", tag: "img", src: "hero.png", complete: true, naturalWidth: 0 }),
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe("broken-image");
    expect(out[0]!.selector).toBe("img.missing");
    expect(out[0]!.detail).toContain("(no src)");
    expect(out[1]!.detail).toContain('"hero.png"');
  });

  it("does not flag a loaded image", () => {
    expect(
      layoutSlopFindings(
        snap([
          node({
            selector: "img.hero",
            tag: "img",
            src: "hero.png",
            complete: true,
            naturalWidth: 300,
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("findings function is self-contained", () => {
    const copy = new Function(`return (${layoutSlopFindings.toString()})`)() as typeof layoutSlopFindings;
    const fixture = nestedCards();
    expect(copy(fixture)).toEqual(layoutSlopFindings(fixture));
  });

  it("collector is a serializable page function", () => {
    expect(() => new Function(`return (${collectLayoutSlop.toString()})`)()).not.toThrow();
    expect(collectLayoutSlop.toString()).toContain("getComputedStyle");
  });
});
