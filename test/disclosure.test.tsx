import { describe, expect, it } from "vitest";
import { anchorDelta, anchorFor, BODY_COLLAPSIBLE, collapseTarget } from "../src/renderer/src/disclosure";

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
