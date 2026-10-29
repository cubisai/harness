import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import { SettingsGroupContent } from "../src/renderer/src/components/SettingsSheet";
import type { SettingsView } from "../src/shared/types";
import { applyZoom } from "../src/renderer/src/store";
import { ZOOM_STEPS, stepZoom, trafficLightPosition, zoomKey } from "../src/shared/zoom";
import { tempDir } from "./helpers";

const box: SecretBox = { available: false, encrypt: (s) => s, decrypt: (s) => s };

describe("zoom setting", () => {
  it("defaults to 100%, round-trips a step, and ignores anything else", () => {
    const file = join(tempDir(), "settings.json");
    const store = new SettingsStore(file, box);
    expect(store.get().zoom).toBe(1);
    store.update({ zoom: 1.25 });
    expect(new SettingsStore(file, box).get().zoom).toBe(1.25);
    store.update({ zoom: 3 });
    store.update({ zoom: "big" as unknown as number });
    expect(store.get().zoom).toBe(1.25);
  });
});

describe("stepZoom", () => {
  it("steps along ZOOM_STEPS, stops at the ends, and resets on 0", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, 1)).toBe(1.4);
    expect(stepZoom(0.8, -1)).toBe(0.8);
    expect(stepZoom(1.25, 0)).toBe(1);
    // An off-step value snaps to its nearest step first (Chromium's 91% from ⌘− is nearest 90%).
    expect(stepZoom(0.913, 1)).toBe(1);
  });
});

describe("trafficLightPosition", () => {
  it("centres the 14px lights on the 46px header at each zoom", () => {
    for (const z of ZOOM_STEPS) expect(Math.abs(trafficLightPosition(z).y + 7 - 22.5 * z)).toBeLessThanOrEqual(0.5);
    expect(trafficLightPosition(1)).toEqual({ x: 16, y: 16 });
  });
});

describe("zoomKey", () => {
  const k = (key: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean }> = {}) => ({ key, meta: false, control: false, alt: false, ...mods });
  it("reads ⌘ on macOS and Ctrl elsewhere, and leaves ⌥ chords alone", () => {
    expect(zoomKey(k("=", { meta: true }), true)).toBe(1);
    expect(zoomKey(k("+", { meta: true }), true)).toBe(1);
    expect(zoomKey(k("-", { meta: true }), true)).toBe(-1);
    expect(zoomKey(k("0", { meta: true }), true)).toBe(0);
    expect(zoomKey(k("=", { control: true }), true)).toBeNull();
    expect(zoomKey(k("=", { control: true }), false)).toBe(1);
    expect(zoomKey(k(",", { meta: true, alt: true }), true)).toBeNull();
    expect(zoomKey(k("a", { meta: true }), true)).toBeNull();
  });
});

describe("applyZoom", () => {
  const saved = globalThis.document;
  afterEach(() => {
    globalThis.document = saved;
  });
  it("writes --zoom on the root, 1 when unset", () => {
    const props: Record<string, string> = {};
    globalThis.document = { documentElement: { style: { setProperty: (k: string, v: string) => (props[k] = v) } } } as unknown as Document;
    applyZoom(1.25);
    expect(props["--zoom"]).toBe("1.25");
    applyZoom(undefined);
    expect(props["--zoom"]).toBe("1");
  });
});

describe("Settings › Text size", () => {
  const view = (zoom?: number) =>
    renderToStaticMarkup(<SettingsGroupContent group="appearance" settings={{ theme: "system", zoom, defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providers: [], providerCredential: {}, migratedProviders: [], secretsEncrypted: true } as SettingsView} />);
  it("is a Smaller ↔ Larger slider, a stop per step, resting on 100% with no Reset", () => {
    const html = view();
    expect(html).toMatch(/type="range"[^>]*min="0"[^>]*max="5"/);
    expect(html).toContain('aria-valuetext="100% · default"');
    expect(html).toContain(">Smaller<");
    expect(html).not.toContain(">Reset<");
    expect(html).not.toContain("effort hot");
  });
  it("shows a picked size with Reset, and glows from 125% up", () => {
    expect(view(1.1)).toContain('aria-valuetext="110%"');
    expect(view(1.1)).toContain(">Reset<");
    expect(view(1.1)).not.toContain("effort hot");
    expect(view(1.25)).toContain("effort hot");
  });
});
