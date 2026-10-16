import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { BOUNDS, DEFAULT_LAYOUT, chatFloor, clampLayout, designChatWidth, inspectorCap, isWideInspector, sanitizeLayout } from "../src/renderer/src/layout";
import { tempDir } from "./helpers";

const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from(s).toString("base64"),
  decrypt: (b) => Buffer.from(b, "base64").toString(),
};

describe("clampLayout", () => {
  it("auto-collapses the inspector when the main pane would drop below its minimum", () => {
    const layout = { ...DEFAULT_LAYOUT };
    const result = clampLayout(900, layout);
    expect(result).toMatchObject({ sidebar: 256, inspector: null, main: 644, inspectorAutoCollapsed: true });
    expect(layout.inspector).toBe(460); // the stored layout is never mutated
  });

  it("narrows a wide inspector to fit instead of hiding it", () => {
    const layout = { ...DEFAULT_LAYOUT, sidebar: 359, inspector: BOUNDS.inspector.max };
    expect(clampLayout(1402, layout)).toMatchObject({ sidebar: 359, inspector: 623, main: 420, inspectorAutoCollapsed: false });
    expect(layout.inspector).toBe(BOUNDS.inspector.max);
  });

  it("shrinks the sidebar when the inspector at its minimum still doesn't fit", () => {
    const result = clampLayout(1000, { ...DEFAULT_LAYOUT, sidebar: 300 });
    expect(result).toMatchObject({ sidebar: 260, inspector: BOUNDS.inspector.min, main: 420, inspectorAutoCollapsed: false });
  });

  it("keeps the inspector at 1200", () => {
    const result = clampLayout(1200, { ...DEFAULT_LAYOUT });
    expect(result).toMatchObject({ sidebar: 256, inspector: 460, main: 484, inspectorAutoCollapsed: false });
  });

  it("uses the rail width when the sidebar is collapsed", () => {
    const result = clampLayout(1200, { ...DEFAULT_LAYOUT, sidebarCollapsed: true });
    expect(result.sidebar).toBe(BOUNDS.rail);
  });

  it("shrinks the sidebar to keep the main pane at its minimum", () => {
    const wide = { ...DEFAULT_LAYOUT, sidebar: BOUNDS.sidebar.max };
    const at700 = clampLayout(700, wide, false);
    expect(at700).toMatchObject({ sidebar: 280, inspector: null, main: 420, inspectorAutoCollapsed: false });
    const at500 = clampLayout(500, wide, false);
    expect(at500.sidebar).toBe(BOUNDS.sidebar.min);
  });
});

describe("wide side panel (up to 80%)", () => {
  // 1600 window, 256 sidebar: 1344 to share; 80% is 1075, the chat's floor 20% (269).
  it("caps the panel at 80% of the space right of the sidebar", () => {
    expect(chatFloor(1344)).toBe(269);
    expect(inspectorCap(1344)).toBe(1075);
    expect(clampLayout(1600, { ...DEFAULT_LAYOUT, inspector: 3000, inspectorWide: true })).toMatchObject({ inspector: 1075, main: 269, inspectorMax: 1075 });
  });

  it("never lets the chat go under 260, and never caps the panel under its minimum", () => {
    expect(chatFloor(900)).toBe(260);
    expect(inspectorCap(900)).toBe(640);
    expect(inspectorCap(400)).toBe(BOUNDS.inspector.min);
  });

  it("keeps a dragged-wide panel when the window shrinks, down to the chat's floor", () => {
    const layout = { ...DEFAULT_LAYOUT, inspector: 1075, inspectorWide: true };
    expect(clampLayout(1200, layout)).toMatchObject({ sidebar: 256, inspector: 684, main: 260, inspectorAutoCollapsed: false });
  });

  it("keeps the chat at its normal 420 for a panel that wasn't dragged wide", () => {
    expect(clampLayout(1600, { ...DEFAULT_LAYOUT, inspector: 1075 })).toMatchObject({ inspector: 924, main: 420 });
  });

  it("marks a width as wide only when it leaves the chat under 420", () => {
    expect(isWideInspector(1600, 256, 924)).toBe(false);
    expect(isWideInspector(1600, 256, 925)).toBe(true);
    expect(isWideInspector(1600, 256, 0)).toBe(false);
  });
});

describe("sanitizeLayout", () => {
  it("clamps numbers, rejects non-numbers, and defaults bad booleans", () => {
    const result = sanitizeLayout({ sidebar: 9999, inspector: 10, terminal: "x", browserWide: "yes" });
    expect(result.sidebar).toBe(360);
    expect(result.inspector).toBe(320);
    expect(result.terminal).toBe(240);
    expect(result.browserWide).toBe(false);
  });

  it("returns the defaults for a non-object", () => {
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
  });
});

describe("design chat width", () => {
  it("is automatic (45% within 260–420) until dragged, then keeps the canvas 480px", () => {
    expect(designChatWidth(1000, null)).toEqual({ width: 420, max: 520 });
    expect(designChatWidth(700, null).width).toBe(315);
    expect(designChatWidth(1000, 800)).toEqual({ width: 520, max: 520 });
    expect(designChatWidth(1000, 100).width).toBe(BOUNDS.designChat.min);
    expect(designChatWidth(500, 400)).toEqual({ width: 260, max: 260 });
  });

  it("stores a dragged width and drops a bad one", () => {
    expect(sanitizeLayout({ designChat: 500 }).designChat).toBe(500);
    expect(sanitizeLayout({ designChat: "wide" }).designChat).toBeNull();
    expect(sanitizeLayout({}).designChat).toBeNull();
  });
});

describe("paneLayout persistence", () => {
  it("round-trips a stored paneLayout through a fresh store", () => {
    const file = join(tempDir(), "settings.json");
    const store = new SettingsStore(file, box);
    store.update({ paneLayout: { ...DEFAULT_LAYOUT, sidebar: 300, inspectorCollapsed: true } });
    const fresh = new SettingsStore(file, box);
    expect(fresh.get().paneLayout.sidebar).toBe(300);
    expect(fresh.get().paneLayout.inspectorCollapsed).toBe(true);
  });
});