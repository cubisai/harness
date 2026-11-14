import { describe, expect, it } from "vitest";
import { bridgeScript } from "../src/main/design/bridge";
import { selectorFor } from "../src/main/browser/picker";
import { readBridgeMessage } from "../src/renderer/src/design/frame";
import { escClears, goMessage, placeFloatingBar } from "../src/renderer/src/design/variants";

const view = { x: 0, y: 0, width: 800, height: 600 };
const bar = { width: 400, height: 34 };

describe("placeFloatingBar", () => {
  it("sits under the element, centred on it", () => {
    expect(placeFloatingBar({ x: 300, y: 100, width: 200, height: 50 }, view, bar)).toEqual({ left: 200, top: 158, side: "below" });
  });

  it("flips above when there's no room below", () => {
    expect(placeFloatingBar({ x: 300, y: 540, width: 200, height: 40 }, view, bar)).toEqual({ left: 200, top: 498, side: "above" });
  });

  it("docks to the top edge when the element scrolled off above, and to the bottom when it's below the view", () => {
    expect(placeFloatingBar({ x: 300, y: -300, width: 200, height: 100 }, view, bar)).toMatchObject({ top: 8, side: "dock-top" });
    expect(placeFloatingBar({ x: 300, y: 900, width: 200, height: 100 }, view, bar)).toMatchObject({ top: 558, side: "dock-bottom" });
  });

  it("docks to the bottom for an element taller than the view", () => {
    expect(placeFloatingBar({ x: 0, y: -100, width: 800, height: 900 }, view, bar)).toMatchObject({ top: 558, side: "dock-bottom" });
  });

  it("stays inside the view sideways, and inside a view that doesn't start at the wrapper's edge", () => {
    expect(placeFloatingBar({ x: 0, y: 100, width: 40, height: 20 }, view, bar).left).toBe(8);
    expect(placeFloatingBar({ x: 780, y: 100, width: 20, height: 20 }, view, bar).left).toBe(392);
    const inset = { x: 50, y: 40, width: 800, height: 600 };
    expect(placeFloatingBar({ x: 60, y: -500, width: 40, height: 20 }, inset, bar)).toEqual({ left: 58, top: 48, side: "dock-top" });
  });
});

describe("goMessage", () => {
  it("names the direction (Freeform says nothing more) and keeps the words", () => {
    expect(goMessage("freeform", "  warmer  ")).toBe("Make 3 variants of the selected element.\nwarmer");
    expect(goMessage("bolder", "")).toBe("Make 3 variants of the selected element: Bolder.");
  });
});

describe("selection bridge messages", () => {
  const anchor = { source: "cubiq-design", type: "anchor", rect: { x: 1, y: 2, width: 3, height: 4 }, bounds: { x: 0, y: 0, width: 10, height: 10 }, editable: true, view: { width: 800, height: 600 } };
  it("accepts an anchor or its absence, and rejects a bad box", () => {
    expect(readBridgeMessage(anchor)).toEqual({ type: "anchor", anchor: { rect: anchor.rect, bounds: anchor.bounds, editable: true, view: anchor.view } });
    expect(readBridgeMessage({ source: "cubiq-design", type: "anchor", rect: null })).toEqual({ type: "anchor", anchor: null });
    expect(readBridgeMessage({ ...anchor, rect: { x: 1, y: 2, width: -3, height: 4 } })).toBeNull();
    expect(readBridgeMessage({ ...anchor, bounds: undefined })).toBeNull();
    expect(readBridgeMessage({ ...anchor, editable: "yes" })).toMatchObject({ anchor: { editable: false } });
  });

  it("drops the messages only the old pick and Insert mode sent", () => {
    for (const type of ["marks", "repick-ask", "gap", "gap-rect", "insert-cancel", "text-edit"]) {
      expect(readBridgeMessage({ source: "cubiq-design", type, label: "x", gap: null, rect: { x: 0, y: 0, width: 1, height: 1 }, strokes: [], notes: [], id: "a", before: "a", after: "b" })).toBeNull();
    }
  });

  it("ships a self-contained bridge script with no marks layer and no Insert mode", () => {
    const script = bridgeScript(selectorFor);
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toContain("data-cubiq-marks");
    expect(script).not.toContain("repick-ask");
    expect(script).not.toContain("insert-cancel");
  });
});

describe("detect and variant bridge messages", () => {

  it("reads a pin click from the page, and nothing malformed", () => {
    expect(readBridgeMessage({ source: "cubiq-design", type: "finding", n: 4 })).toEqual({ type: "finding", n: 4 });
    for (const n of [0, 100, 1.5, "4"]) expect(readBridgeMessage({ source: "cubiq-design", type: "finding", n })).toBeNull();
  });

  it("reads a hyphenated variant set name from the page", () => {
    const sets = [{ set: "hero-em", count: 3, shown: 1, malformed: null }];
    expect(readBridgeMessage({ source: "cubiq-design", type: "variants", sets })).toEqual({ type: "variants", sets });
    for (const bad of ["-hero", "hero-", "Hero"]) expect(readBridgeMessage({ source: "cubiq-design", type: "variants", sets: [{ ...sets[0], set: bad }] })).toBeNull();
  });
});

describe("escClears", () => {
  it("clears from the page or a button, never from a text field, dialog or menu", () => {
    const el = (tagName: string, inside: string | null = null, editable = false) =>
      ({ tagName, isContentEditable: editable, closest: (s: string) => (inside && s.includes(inside) ? {} : null) }) as unknown as EventTarget;
    expect(escClears(null)).toBe(true);
    expect(escClears(el("BUTTON"))).toBe(true);
    for (const t of [el("INPUT"), el("TEXTAREA"), el("DIV", null, true), el("BUTTON", "dialog"), el("BUTTON", "menu")]) expect(escClears(t)).toBe(false);
  });
});
