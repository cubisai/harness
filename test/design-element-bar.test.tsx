import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bridgeScript } from "../src/main/design/bridge";
import { selectorFor } from "../src/main/browser/picker";
import { ACTIONS, ElementBar, goMessage, paletteStep, placeElementBar, type ActionId } from "../src/renderer/src/design/ElementBar";
import { NO_MARKS, readBridgeMessage, type PageMarks } from "../src/renderer/src/design/frame";

const noop = () => {};
const view = { x: 0, y: 0, width: 800, height: 600 };
const bar = { width: 400, height: 34 };

describe("placeElementBar", () => {
  it("sits under the element, centred on it", () => {
    expect(placeElementBar({ x: 300, y: 100, width: 200, height: 50 }, view, bar)).toEqual({ left: 200, top: 158, side: "below" });
  });

  it("flips above when there's no room below", () => {
    expect(placeElementBar({ x: 300, y: 540, width: 200, height: 40 }, view, bar)).toEqual({ left: 200, top: 498, side: "above" });
  });

  it("docks to the top edge when the element scrolled off above, and to the bottom when it's below the view", () => {
    expect(placeElementBar({ x: 300, y: -300, width: 200, height: 100 }, view, bar)).toMatchObject({ top: 8, side: "dock-top" });
    expect(placeElementBar({ x: 300, y: 900, width: 200, height: 100 }, view, bar)).toMatchObject({ top: 558, side: "dock-bottom" });
  });

  it("docks to the bottom for an element taller than the view", () => {
    expect(placeElementBar({ x: 0, y: -100, width: 800, height: 900 }, view, bar)).toMatchObject({ top: 558, side: "dock-bottom" });
  });

  it("stays inside the view sideways, and inside a view that doesn't start at the wrapper's edge", () => {
    expect(placeElementBar({ x: 0, y: 100, width: 40, height: 20 }, view, bar).left).toBe(8);
    expect(placeElementBar({ x: 780, y: 100, width: 20, height: 20 }, view, bar).left).toBe(392);
    const inset = { x: 50, y: 40, width: 800, height: 600 };
    expect(placeElementBar({ x: 60, y: -500, width: 40, height: 20 }, inset, bar)).toEqual({ left: 58, top: 48, side: "dock-top" });
  });
});

describe("paletteStep", () => {
  it("moves through the 4 × 3 grid and wraps within a row or a column", () => {
    expect(ACTIONS).toHaveLength(12);
    expect(paletteStep(0, "ArrowRight")).toBe(1);
    expect(paletteStep(3, "ArrowRight")).toBe(0);
    expect(paletteStep(0, "ArrowLeft")).toBe(3);
    expect(paletteStep(1, "ArrowDown")).toBe(5);
    expect(paletteStep(9, "ArrowDown")).toBe(1);
    expect(paletteStep(1, "ArrowUp")).toBe(9);
    expect(paletteStep(5, "Home")).toBe(0);
    expect(paletteStep(5, "End")).toBe(11);
    expect(paletteStep(5, "a")).toBeNull();
  });
});

describe("goMessage", () => {
  const marks: PageMarks = { strokes: [[{ x: 1, y: 2 }]], notes: [{ x: 10, y: 20, text: "more playful", near: 'button "Subscribe"' }, { x: 5, y: 5, text: "tighter", near: "" }] };
  it("names the action (Freeform says nothing more) and keeps the prompt", () => {
    expect(goMessage("freeform", "  warmer  ", NO_MARKS)).toBe("Make 3 variants of the selected element.\nwarmer");
    expect(goMessage("bolder", "", NO_MARKS)).toBe("Make 3 variants of the selected element: Bolder.");
  });
  it("turns notes into text with what they sit near, and points at the capture for marks", () => {
    expect(goMessage("delight", "", marks)).toBe(
      'Make 3 variants of the selected element: Delight.\nNotes on the page:\n- near button "Subscribe": more playful\n- tighter\nThe reference image shows the element with my mark on it.',
    );
  });
});

describe("element bar bridge messages", () => {
  const anchor = { source: "cubiq-design", type: "anchor", rect: { x: 1, y: 2, width: 3, height: 4 }, bounds: { x: 0, y: 0, width: 10, height: 10 }, editable: true, view: { width: 800, height: 600 } };
  it("accepts an anchor or its absence, and rejects a bad box", () => {
    expect(readBridgeMessage(anchor)).toEqual({ type: "anchor", anchor: { rect: anchor.rect, bounds: anchor.bounds, editable: true, view: anchor.view } });
    expect(readBridgeMessage({ source: "cubiq-design", type: "anchor", rect: null })).toEqual({ type: "anchor", anchor: null });
    expect(readBridgeMessage({ ...anchor, rect: { x: 1, y: 2, width: -3, height: 4 } })).toBeNull();
    expect(readBridgeMessage({ ...anchor, bounds: undefined })).toBeNull();
    expect(readBridgeMessage({ ...anchor, editable: "yes" })).toMatchObject({ anchor: { editable: false } });
  });

  it("accepts marks within their caps and rejects anything malformed", () => {
    const msg = { source: "cubiq-design", type: "marks", strokes: [[{ x: 1, y: 2 }, { x: 3, y: 4 }]], notes: [{ x: 1, y: 1, text: "more playful", near: "h1" }] };
    expect(readBridgeMessage(msg)).toEqual({ type: "marks", marks: { strokes: msg.strokes, notes: msg.notes } });
    expect(readBridgeMessage({ ...msg, strokes: Array.from({ length: 41 }, () => []) })).toBeNull();
    expect(readBridgeMessage({ ...msg, strokes: [[{ x: "1", y: 2 }]] })).toBeNull();
    expect(readBridgeMessage({ ...msg, notes: [{ x: 1, y: 1, text: "   ", near: "" }] })).toBeNull();
    expect(readBridgeMessage({ ...msg, notes: [{ x: 1, y: 1, text: "x".repeat(201), near: "" }] })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "repick-ask", label: 'span "Hi"' })).toEqual({ type: "repick-ask", label: 'span "Hi"' });
    expect(readBridgeMessage({ source: "cubiq-design", type: "repick-ask", label: "" })).toBeNull();
  });

  it("still ships a self-contained bridge script with the marks layer", () => {
    const script = bridgeScript(selectorFor);
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("data-cubiq-marks");
  });
});

describe("ElementBar", () => {
  const render = (over: Partial<Parameters<typeof ElementBar>[0]> = {}) =>
    renderToStaticMarkup(
      <ElementBar
        tag='h1 "Overview"'
        place={{ left: 10, top: 20, side: "below" }}
        onSize={noop}
        prompt=""
        onPrompt={noop}
        action={"freeform" as ActionId}
        onAction={noop}
        marks={NO_MARKS}
        onClearMarks={noop}
        canGo={false}
        goWhy="Say what to change, mark it, or pick an action"
        onGo={noop}
        generating={false}
        onEditText={null}
        onComment={null}
        repick={null}
        onRepick={noop}
        {...over}
      />,
    );

  it("shows the tag, the prompt, the action ×3, dictation and Go (off, with why)", () => {
    const html = render();
    expect(html).toContain("h1 &quot;Overview&quot;");
    expect(html).toContain('aria-label="What to change"');
    expect(html).toMatch(/freeform<\/span><span class="design-element-times">×3/);
    expect(html).toContain('aria-label="Dictate"');
    expect(html).toMatch(/aria-label="Make 3 variants" title="Say what to change, mark it, or pick an action" disabled=""/);
    expect(html).not.toContain('aria-label="Edit text"');
    expect(html).not.toContain('aria-label="Comment"');
    expect(html).not.toContain("Clear ");
  });

  it("adds Edit text, Comment and Clear when they apply", () => {
    const html = render({ onEditText: noop, onComment: noop, marks: { strokes: [[{ x: 1, y: 1 }]], notes: [{ x: 1, y: 1, text: "a", near: "" }] } });
    expect(html).toContain('aria-label="Edit text"');
    expect(html).toContain('aria-label="Comment"');
    expect(html).toContain(">Clear 2<");
  });

  it("asks before a re-pick, and becomes a status pill while generating", () => {
    expect(render({ repick: 'span "Hi"' })).toContain("Pick span &quot;Hi&quot;? Your marks will be cleared.");
    const busy = render({ generating: true });
    expect(busy).toContain('role="status"');
    expect(busy).toContain("Generating variants…");
    expect(busy).not.toContain("What to change");
  });

  it("stays hidden until the canvas has placed it", () => {
    expect(render({ place: null })).toContain("visibility:hidden");
  });
});
