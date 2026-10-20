import { describe, expect, it } from "vitest";
import { anchorDelta, anchorFor, BODY_COLLAPSIBLE, collapseTarget, stillPinned, trimmedReserve } from "../src/renderer/src/disclosure";

/** A details element as collapseTarget sees it: open or not, and whether it is one of the transcript's foldable kinds. */
function details(open: boolean, foldable: boolean): HTMLDetailsElement {
  return { open, matches: (sel: string) => sel === BODY_COLLAPSIBLE && foldable } as unknown as HTMLDetailsElement;
}

/** A click target: inside `around` (or no details), and inside something interactive or not. */
function target(around: HTMLDetailsElement | null, interactive = false): Element {
  return { closest: (sel: string) => (sel === "details" ? around : interactive ? ({} as Element) : null) } as unknown as Element;
}

const box = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as unknown as Element;

describe("collapseTarget", () => {
  it("folds the open transcript block a plain click lands in", () => {
    const d = details(true, true);
    expect(collapseTarget(target(d), "")).toBe(d);
  });

  it("leaves clicks on links, buttons and other controls alone", () => {
    expect(collapseTarget(target(details(true, true), true), "")).toBeNull();
  });

  it("does nothing while text is selected", () => {
    expect(collapseTarget(target(details(true, true)), "boils at 100")).toBeNull();
  });

  it("ignores closed blocks, other disclosures and clicks outside any block", () => {
    expect(collapseTarget(target(details(false, true)), "")).toBeNull();
    expect(collapseTarget(target(details(true, false)), "")).toBeNull();
    expect(collapseTarget(target(null), "")).toBeNull();
    expect(collapseTarget(null, "")).toBeNull();
  });
});

describe("anchorFor / anchorDelta", () => {
  it("keeps a visible header where it is", () => {
    const anchor = anchorFor(box(300), box(46));
    expect(anchor.top).toBe(300);
  });

  it("brings a header above the scroller back to its top edge", () => {
    const anchor = anchorFor(box(-900), box(46));
    expect(anchor.top).toBe(54);
  });

  it("measures how far the header moved since", () => {
    let top = 300;
    const summary = { getBoundingClientRect: () => ({ top }) } as unknown as Element;
    const anchor = anchorFor(summary, box(46));
    top = 244;
    expect(anchorDelta(anchor)).toBe(-56);
  });
});

describe("stillPinned", () => {
  const at = (scrollTop: number, scrollHeight = 900, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });

  it("unpins on the first frame of a scroll up, even a few px from the bottom", () => {
    // Bottom is 300; an animated wheel scroll's first frame moves 6 px.
    expect(stillPinned(300, at(294))).toBe(false);
  });

  it("stays pinned at the bottom and re-pins when the reader scrolls back near it", () => {
    expect(stillPinned(300, at(300))).toBe(true);
    expect(stillPinned(200, at(250))).toBe(true);
    expect(stillPinned(100, at(150))).toBe(false);
  });

  it("stays pinned when shrinking content clamps the view up onto the new bottom", () => {
    expect(stillPinned(300, at(250, 850))).toBe(true);
  });
});

describe("trimmedReserve", () => {
  it("shrinks the reserve to what the view still needs as the reader scrolls up", () => {
    expect(trimmedReserve(2000, 1700.4, 1400)).toBe(1701);
  });

  it("never grows it: at the bottom the scroller needs a little more than the reserve", () => {
    // Pinned, the view sits ~10 px past the transcript (the waiting dock): growing to that fed itself every frame.
    let reserve = 1639;
    for (let frame = 0; frame < 60; frame++) reserve = trimmedReserve(reserve, reserve + 10, 1399) ?? 0;
    expect(reserve).toBe(1639);
  });

  it("releases once the content alone reaches the view's bottom", () => {
    expect(trimmedReserve(2000, 1400, 1400)).toBeNull();
  });
});
