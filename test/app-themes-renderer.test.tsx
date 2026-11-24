import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { applyChromePalette, chromeSafetyStyle } from "../src/renderer/src/app-themes";
import { acceptAppThemeState, applyTheme, useStore } from "../src/renderer/src/store";
import { AppThemeControls, cancelThemePreview, rememberThemePreviewFocus, restoreThemePreviewFocus } from "../src/renderer/src/components/AppThemeControls";
import type { AppThemeState } from "../src/shared/app-themes";

// Zustand's server snapshot is the initial store, not setState(). For markup
// cases read the actual current store without a server subscription; pure
// palette/version tests still execute the real store functions.
vi.mock("../src/renderer/src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/src/store")>();
  const read = Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore);
  return { ...actual, useStore: read };
});

const before = useStore.getState().appThemes;
afterEach(() => { useStore.setState({ appThemes: before }); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function root() {
  const values = new Map([["--zoom", "1.25"], ["--sidebar-w", "300px"], ["--design-prompt-h", "80px"]]);
  const element = { dataset: { theme: "light" }, style: { setProperty: (k: string, v: string) => values.set(k, v), removeProperty: (k: string) => values.delete(k) } };
  const dispatch = vi.fn(() => true);
  vi.stubGlobal("document", { documentElement: element }); vi.stubGlobal("window", { dispatchEvent: dispatch });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  return { element: element as unknown as HTMLElement, values, dispatch };
}
const state = (version: number): AppThemeState => ({ version, selected: null, themes: [], active: { light: { primary: "#3f2f22" } }, preview: null });
describe("renderer chrome palette ownership", () => {
  it("keyboard cancellation restores the connected preview trigger", async () => {
    root(); useStore.setState({ appThemes: null });
    class Element { isConnected = true; focus = vi.fn(); matches = vi.fn(() => false); }
    const button = new Element(); vi.stubGlobal("HTMLElement", Element);
    Object.defineProperty(document, "activeElement", { value: button });
    Object.assign(window, { unskilled: { cancelAppThemePreview: vi.fn().mockResolvedValue({ ...state(20), active: null }) } });
    rememberThemePreviewFocus(); await cancelThemePreview("token", true); expect(button.focus).toHaveBeenCalledTimes(1);
    button.isConnected = false; await cancelThemePreview("token", true); expect(button.focus).toHaveBeenCalledTimes(1);
  });
  it("restores a Cancel target only after its disabled busy state has committed away", () => {
    let busy = true;
    const button = { isConnected: true, matches: vi.fn(() => busy), focus: vi.fn() };
    restoreThemePreviewFocus(button as unknown as HTMLElement);
    expect(button.matches).toHaveBeenCalledWith(":disabled");
    expect(button.focus).not.toHaveBeenCalled();
    busy = false;
    restoreThemePreviewFocus(button as unknown as HTMLElement);
    expect(button.focus).toHaveBeenCalledOnce();
  });
  it("never focuses a Cancel target removed by closing its source sheet", () => {
    const button = { isConnected: false, matches: vi.fn(() => false), focus: vi.fn() };
    restoreThemePreviewFocus(button as unknown as HTMLElement);
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.matches).not.toHaveBeenCalled();
  });
  it("default startup needs no palette DOM writes or browser media API in a server fixture", () => {
    useStore.setState({ appThemes: null }); vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("document", { documentElement: { dataset: {}, style: { setProperty: vi.fn() } } });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    expect(() => applyTheme("system")).not.toThrow();
  });
  it("replaces only owned properties, preserves layout/zoom and notifies after writes", () => {
    const e = root(); e.dispatch.mockImplementation(() => { expect(e.values.get("--primary")).toBe("#3f2f22"); return true; });
    applyChromePalette({ light: { primary: "#3f2f22" } }, "light", e.element);
    expect(e.values.get("--primary-soft")).toBe("rgb(63 47 34 / 0.07)"); expect(e.dispatch).toHaveBeenCalledTimes(1);
    e.dispatch.mockImplementation(() => true); applyChromePalette(null, "light", e.element);
    expect([...e.values]).toEqual([["--zoom", "1.25"], ["--sidebar-w", "300px"], ["--design-prompt-h", "80px"]]);
  });
  it("does not leak light-only values when the effective scheme becomes dark", () => {
    const e = root(); const theme = { light: { primary: "#3f2f22" }, dark: { bg: "#080808" } };
    applyChromePalette(theme, "light", e.element); applyChromePalette(theme, "dark", e.element);
    expect(e.values.has("--primary")).toBe(false); expect(e.values.get("--bg")).toBe("#080808"); expect(e.values.get("--send-bg")).toBe("#080808");
  });
  it("rejects late/duplicate state versions", () => {
    const e = root(); useStore.setState({ appThemes: null }); acceptAppThemeState(state(10));
    acceptAppThemeState({ ...state(9), active: null }); acceptAppThemeState(state(10));
    expect(useStore.getState().appThemes?.version).toBe(10); expect(e.values.get("--primary")).toBe("#3f2f22"); expect(e.dispatch).toHaveBeenCalledTimes(1);
  });
  it("security/revert colors are baseline scheme-aware values, not the selected palette", () => {
    expect(chromeSafetyStyle()).toMatchObject({ "--primary": "light-dark(#0b0d10, #f7f8fa)", "--focus": "light-dark(#0b0d10, #f7f8fa)" });
    expect(chromeSafetyStyle()).not.toHaveProperty("--zoom"); expect(chromeSafetyStyle()).not.toHaveProperty("--sidebar-w");
  });
  it("renders empty/default, proposal preview-only and installed selected states", () => {
    useStore.setState({ appThemes: { ...state(1), active: null } });
    expect(renderToStaticMarkup(<AppThemeControls />)).toContain("No plugin app themes installed");
    const proposal = renderToStaticMarkup(<AppThemeControls proposalId="proposal" />);
    expect(proposal).toContain("Preview theme"); expect(proposal).not.toContain("Apply theme"); expect(proposal).toContain("Install first");
    useStore.setState({ appThemes: { ...state(2), selected: { key: "g~palette", hash: "hash" }, themes: [{ key: "g~palette", hash: "hash", revision: "revision", title: "Palette", enabled: true, theme: state(2).active! }] } });
    const selected = renderToStaticMarkup(<AppThemeControls pluginKey="g~palette" />);
    expect(selected).toContain("Applied"); expect(selected).toContain("Revert to CubiQ");
    expect(selected).not.toContain(">Applied</button>");
    const appearance = renderToStaticMarkup(<AppThemeControls />);
    expect(appearance).toContain("app-theme-appearance"); expect(appearance).toContain('aria-label="Preview app theme"');
    expect(appearance).not.toContain(">Applied</button>");
    expect(renderToStaticMarkup(<AppThemeControls proposalId="uninstalled" />)).not.toContain("Revert to CubiQ");
  });
  it("shows owner-unavailable state without offering usable Apply", () => {
    useStore.setState({ appThemes: { ...state(3), themes: [{ key: "g~palette", hash: "hash", revision: "revision", title: "Palette", enabled: false, error: "Owner Off", theme: state(3).active! }] } });
    const html = renderToStaticMarkup(<AppThemeControls pluginKey="g~palette" />);
    expect(html).toContain("Owner Off"); expect(html).toContain("disabled");
  });
});
