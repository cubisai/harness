import { describe, expect, it } from "vitest";
import { STEP, dragReducer, splitterKeys, splitterReset, splitterValue, type DragState, type SplitterState } from "../src/renderer/src/splitter";

const base = (patch: Partial<SplitterState> = {}): SplitterState => ({ value: 300, min: 180, max: 360, collapsed: false, defaultValue: 256, ...patch });

describe("splitterKeys", () => {
  it("toggles collapse on Enter and announces 0 while collapsed", () => {
    const collapsed = splitterKeys(base(), "Enter");
    expect(collapsed.collapsed).toBe(true);
    expect(splitterValue(collapsed)).toBe(0);
    const expanded = splitterKeys(collapsed, "Enter");
    expect(expanded.collapsed).toBe(false);
    expect(splitterValue(expanded)).toBe(300);
  });

  it("moves by one step on the arrows", () => {
    expect(splitterKeys(base(), "ArrowRight").value).toBe(300 + STEP);
    expect(splitterKeys(base(), "ArrowLeft").value).toBe(300 - STEP);
  });

  it("inverts the arrows on a left-edge divider", () => {
    expect(splitterKeys(base({ invert: true }), "ArrowLeft").value).toBe(300 + STEP);
    expect(splitterKeys(base({ invert: true }), "ArrowRight").value).toBe(300 - STEP);
  });

  it("jumps to the bounds on Home and End", () => {
    expect(splitterKeys(base(), "Home").value).toBe(180);
    expect(splitterKeys(base(), "End").value).toBe(360);
  });

  it("clamps the arrows at the bounds", () => {
    expect(splitterKeys(base({ value: 360 }), "ArrowRight").value).toBe(360);
    expect(splitterKeys(base({ value: 180 }), "ArrowLeft").value).toBe(180);
  });

  it("expands when a key moves an arrow while collapsed", () => {
    expect(splitterKeys(base({ collapsed: true }), "ArrowRight").collapsed).toBe(false);
  });

  it("returns the same state for an unknown key", () => {
    const s = base();
    expect(splitterKeys(s, "Tab")).toBe(s);
  });

  it("keeps the announced value equal to the state's when expanded", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      const s = splitterKeys(base(), key);
      expect(splitterValue(s)).toBe(s.value);
    }
  });
});

describe("splitterReset", () => {
  it("returns to the default width, expanded", () => {
    const s = splitterReset(base({ value: 320, collapsed: true }));
    expect(s).toMatchObject({ value: 256, collapsed: false });
  });
});

describe("dragReducer", () => {
  const start = (): DragState => ({ dragging: false, startX: 0, startValue: 300, value: 300, min: 180, max: 360 });

  it("persists only on release and follows every move", () => {
    const down = dragReducer(start(), { type: "down", x: 100 });
    expect(down.persist).toBeNull();
    expect(down.state.dragging).toBe(true);
    expect(down.state.startValue).toBe(300);
    let state = down.state;
    for (let x = 101; x <= 110; x++) {
      const moved = dragReducer(state, { type: "move", x });
      expect(moved.persist).toBeNull();
      expect(moved.state.value).toBe(300 + (x - 100));
      state = moved.state;
    }
    const up = dragReducer(state, { type: "up" });
    expect(up.persist).toBe(310);
    expect(up.state.dragging).toBe(false);
  });

  it("changes nothing on a move with no prior down", () => {
    const s = start();
    expect(dragReducer(s, { type: "move", x: 200 })).toEqual({ state: s, persist: null });
    expect(dragReducer(s, { type: "up" })).toEqual({ state: s, persist: null });
  });

  it("inverts the drag on a left-edge divider", () => {
    const state: DragState = { dragging: true, startX: 100, startValue: 300, value: 300, min: 180, max: 360, invert: true };
    expect(dragReducer(state, { type: "move", x: 110 }).state.value).toBe(290);
  });

  it("clamps the dragged width at the bounds", () => {
    const wide: DragState = { dragging: true, startX: 0, startValue: 300, value: 300, min: 180, max: 360 };
    expect(dragReducer(wide, { type: "move", x: 1000 }).state.value).toBe(360);
    expect(dragReducer(wide, { type: "move", x: -1000 }).state.value).toBe(180);
  });
});