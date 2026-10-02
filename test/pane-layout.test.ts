import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { BOUNDS, DEFAULT_LAYOUT, clampLayout, sanitizeLayout } from "../src/renderer/src/layout";
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
    expect(result).toEqual({ sidebar: 256, inspector: null, main: 644, inspectorAutoCollapsed: true });
    expect(layout.inspector).toBe(460); // the stored layout is never mutated
  });

  it("narrows a wide inspector to fit instead of hiding it", () => {
    const layout = { ...DEFAULT_LAYOUT, sidebar: 359, inspector: BOUNDS.inspector.max };
    expect(clampLayout(1402, layout)).toEqual({ sidebar: 359, inspector: 623, main: 420, inspectorAutoCollapsed: false });
    expect(layout.inspector).toBe(BOUNDS.inspector.max);
  });

  it("shrinks the sidebar when the inspector at its minimum still doesn't fit", () => {
    const result = clampLayout(1000, { ...DEFAULT_LAYOUT, sidebar: 300 });
    expect(result).toEqual({ sidebar: 260, inspector: BOUNDS.inspector.min, main: 420, inspectorAutoCollapsed: false });
  });

  it("keeps the inspector at 1200", () => {
    const result = clampLayout(1200, { ...DEFAULT_LAYOUT });
    expect(result).toEqual({ sidebar: 256, inspector: 460, main: 484, inspectorAutoCollapsed: false });
  });

  it("uses the rail width when the sidebar is collapsed", () => {
    const result = clampLayout(1200, { ...DEFAULT_LAYOUT, sidebarCollapsed: true });
    expect(result.sidebar).toBe(BOUNDS.rail);
  });

  it("shrinks the sidebar to keep the main pane at its minimum", () => {
    const wide = { ...DEFAULT_LAYOUT, sidebar: BOUNDS.sidebar.max };
    const at700 = clampLayout(700, wide, false);
    expect(at700).toEqual({ sidebar: 280, inspector: null, main: 420, inspectorAutoCollapsed: false });
    const at500 = clampLayout(500, wide, false);
    expect(at500.sidebar).toBe(BOUNDS.sidebar.min);
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