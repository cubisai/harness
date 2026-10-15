import { afterEach, describe, expect, it, vi } from "vitest";
import { describeElement } from "../src/main/design/bridge";
import { readSelected, STYLE_KEYS, type SelectedElement } from "../src/shared/selection";

const el = (over: Partial<SelectedElement> = {}): SelectedElement => ({
  selector: "main > div",
  tag: "div",
  text: "Hello",
  html: "<div>Hello</div>",
  rect: { x: 0, y: 0, width: 120, height: 44 },
  path: [{ label: "main", selector: "main" }],
  ...over,
});

/** A style map with every whitelisted key set to a short, valid value. */
const validStyle = (): Record<string, string> => {
  const style: Record<string, string> = {};
  for (const key of STYLE_KEYS) style[key] = "x";
  return style;
};

describe("readSelected style", () => {
  it("keeps a valid style map", () => {
    const style = { display: "flex", color: "rgb(1, 2, 3)" };
    expect(readSelected({ ...el(), style })?.style).toEqual(style);
    expect(readSelected({ ...el(), style: validStyle() })?.style).toEqual(validStyle());
  });

  it("drops a style with an unknown key without rejecting the element", () => {
    const out = readSelected({ ...el(), style: { display: "flex", nope: "x" } });
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty("style");
  });

  it("drops a style with an oversized value without rejecting the element", () => {
    const out = readSelected({ ...el(), style: { display: "x".repeat(121) } });
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty("style");
  });

  it("drops a non-object style without rejecting the element", () => {
    for (const style of [["display"], "flex", 5, null]) {
      const out = readSelected({ ...el(), style });
      expect(out).not.toBeNull();
      expect(out).not.toHaveProperty("style");
    }
  });
});

/** A minimal fake element: only the DOM surface describeElement touches. */
function div(tag = "div"): Element {
  return {
    tagName: tag.toUpperCase(),
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    outerHTML: `<${tag}></${tag}>`,
    textContent: "",
    parentElement: null,
  } as unknown as Element;
}

describe("describeElement style", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("includes style.display and the other whitelisted keys for a div", () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => (name === "display" ? "block" : "") }));
    const out = describeElement(div(), (el) => el.tagName.toLowerCase());
    expect(out.style?.display).toBe("block");
    expect(Object.keys(out.style ?? {})).toEqual([...STYLE_KEYS]);
  });

  it("omits style when the host has no computed style (the try/catch path)", () => {
    expect(describeElement(div(), (el) => el.tagName.toLowerCase()).style).toBeUndefined();
  });
});
