import { describe, expect, it } from "vitest";
import { announceSelection, contextBlock, elementLabel, readSelected, scopeBlock, selectionKey, withScope, type SelectedElement } from "../src/shared/selection";

const el = (over: Partial<SelectedElement> = {}): SelectedElement => ({
  selector: "main > button:nth-of-type(2)",
  tag: "button",
  text: "Get started",
  html: "<button>Get started</button>",
  rect: { x: 1, y: 2, width: 120, height: 44 },
  path: [{ label: "main", selector: "main" }],
  ...over,
});

describe("readSelected", () => {
  it("keeps a valid element and only its known fields", () => {
    expect(readSelected({ ...el({ id: "cta-start" }), extra: 1, rect: { x: 1, y: 2, width: 120, height: 44, z: 9 } })).toEqual(el({ id: "cta-start" }));
    expect(readSelected(el())).not.toHaveProperty("id");
  });

  it("rejects any bad field", () => {
    expect(readSelected(null)).toBeNull();
    expect(readSelected([el()])).toBeNull();
    expect(readSelected({ ...el(), selector: "" })).toBeNull();
    expect(readSelected({ ...el(), selector: "x".repeat(2001) })).toBeNull();
    expect(readSelected({ ...el(), tag: "" })).toBeNull();
    expect(readSelected({ ...el(), text: "x".repeat(301) })).toBeNull();
    expect(readSelected({ ...el(), html: "x".repeat(1201) })).toBeNull();
    expect(readSelected({ ...el(), rect: { x: 1, y: 2, width: Number.NaN, height: 4 } })).toBeNull();
    expect(readSelected({ ...el(), id: "has space" })).toBeNull();
    expect(readSelected({ ...el(), id: 5 })).toBeNull();
    expect(readSelected({ ...el(), path: "main" })).toBeNull();
    expect(readSelected({ ...el(), path: Array.from({ length: 7 }, () => ({ label: "div", selector: "div" })) })).toBeNull();
    expect(readSelected({ ...el(), path: [{ label: "", selector: "div" }] })).toBeNull();
  });
});

describe("selection text", () => {
  it("labels by text, then id, then tag", () => {
    expect(elementLabel(el())).toBe('button "Get started"');
    expect(elementLabel(el({ text: "  a   very long label that keeps going past the cut " }))).toBe('button "a very long label that keeps goi…"');
    expect(elementLabel(el({ text: "", id: "cta-start" }))).toBe("button cta-start");
    // Long text (a section's whole content) gives way to the id.
    expect(elementLabel(el({ tag: "section", text: "Plan your week Short copy. Get started now", id: "hero" }))).toBe("section hero");
    expect(elementLabel(el({ id: "cta-start" }))).toBe('button "Get started"');
    expect(elementLabel(el({ text: "" }))).toBe("button");
  });

  it("scopes one element with its html, and several without", () => {
    expect(scopeBlock("designs/ab/index.html", [el({ id: "cta-start" })])).toBe(
      [
        "Selected in designs/ab/index.html (1 element): change only this element. If the request needs changes elsewhere, say so instead of making them.",
        '1. <button> data-agent-id="cta-start" · selector `main > button:nth-of-type(2)` · text "Get started"',
        "```html",
        "<button>Get started</button>",
        "```",
      ].join("\n"),
    );
    expect(scopeBlock("designs/ab/index.html", [el(), el({ tag: "h1", selector: "h1", text: "", html: "<h1></h1>" })])).toBe(
      [
        "Selected in designs/ab/index.html (2 elements): change only these elements. If the request needs changes elsewhere, say so instead of making them.",
        '1. <button> · selector `main > button:nth-of-type(2)` · text "Get started"',
        "2. <h1> · selector `h1`",
      ].join("\n"),
    );
    expect(scopeBlock("p", [])).toBe("");
    expect(scopeBlock("p", [el({ html: "x".repeat(700) })])).toContain(`${"x".repeat(600)}…`);
  });

  it("adds the scope to a message only with a page and elements", () => {
    expect(withScope("make it blue", null, [el()])).toBe("make it blue");
    expect(withScope("make it blue", "p", [])).toBe("make it blue");
    expect(withScope("make it blue", "p", [el()]).startsWith("make it blue\n\nSelected in p (1 element)")).toBe(true);
    expect(withScope("", "p", [el()]).startsWith("Selected in p")).toBe(true);
  });

  it("announces and keys a selection", () => {
    expect(announceSelection([])).toBe("Selection cleared");
    expect(announceSelection([el()])).toBe('Selected button "Get started"');
    expect(announceSelection([el(), el(), el()])).toBe("3 elements selected");
    expect(selectionKey([el({ id: "cta" }), el()])).toBe("cta|main > button:nth-of-type(2)");
  });
});

describe("contextBlock", () => {
  it("names the page and the elements, with no instructions", () => {
    expect(contextBlock("designs/ab/index.html", [el({ id: "cta-start" })], "Button")).toBe(
      ["Button in designs/ab/index.html (1 element)", '1. <button> data-agent-id="cta-start" · selector `main > button:nth-of-type(2)` · text "Get started"', "```html", "<button>Get started</button>", "```"].join("\n"),
    );
    expect(contextBlock("p.html", [el(), el({ tag: "h1", selector: "h1", text: "", html: "<h1></h1>" })])).toBe(
      ["From p.html (2 elements)", '1. <button> · selector `main > button:nth-of-type(2)` · text "Get started"', "2. <h1> · selector `h1`"].join("\n"),
    );
    expect(contextBlock("p.html", [])).toBe("");
  });
});
